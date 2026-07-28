import type { BrowserObservation } from './browserObservation';
import { assertSafeBrowserObservation, cleanMimeType } from './browserObservation';
import type { PageTargetRef } from './types';

export type StartNetworkCaptureInput = {
  runId: string;
  pageTargetRef: PageTargetRef | string;
  now?: string;
};

export type StopNetworkCaptureInput = {
  runId: string;
  pageTargetRef: PageTargetRef | string;
  now?: string;
};

export type NetworkCaptureResult = {
  observations: BrowserObservation[];
  diagnostics: Record<string, unknown>[];
};

export interface NetworkCaptureSession {
  start(input: StartNetworkCaptureInput): Promise<void>;
  stop(input: StopNetworkCaptureInput): Promise<NetworkCaptureResult>;
  listObservations(runId: string): Promise<BrowserObservation[]>;
  /**
   * Close an opened capture window WITHOUT collecting or storing anything. Used when the work
   * the window was opened for cannot proceed (e.g. the post-recheck discovery navigation
   * failed): leaving the window active would keep a buffering transport accumulating traffic
   * for a run that is already terminal, and expose those stale observations to a later stop().
   * Optional so an existing custom session stays compatible; the flow calls it when present.
   */
  abort?(input: StopNetworkCaptureInput): Promise<void>;
}

/**
 * DI seam (mirrors `CdpTargetTransport`): the upstream source of raw observations a
 * daemon/CDP transport captured for a page target between `start` and `stop`. A fake supplies
 * fixtures in tests; the real transport is out of scope for Phase 3.4.
 *
 * `beginCapture` is the "start capturing NOW / reset the window" signal (optional; a fixture
 * source ignores it). The session calls it on every `start`, so a buffering transport can drop
 * any traffic seen before the window and only report what follows. Phase 3.6 relies on this to
 * begin discovery capture strictly AFTER the post-auth-recheck boundary — otherwise a source
 * that buffers from connect-time would fold human-login / recheck traffic into the evidence.
 */
export interface NetworkObservationSource {
  collect(input: { runId: string; pageTargetRef: string }): Promise<readonly BrowserObservation[]>;
  beginCapture?(input: { runId: string; pageTargetRef: string }): void | Promise<void>;
  /** Counterpart to `beginCapture`: stop capturing and DISCARD the buffered window without
   *  collecting it (the session's `abort` path). Optional; a fixture source ignores it. */
  abortCapture?(input: { runId: string; pageTargetRef: string }): void | Promise<void>;
}

export class NotImplementedNetworkObservationSource implements NetworkObservationSource {
  async collect(): Promise<readonly BrowserObservation[]> {
    throw new Error('network observation source not implemented for this daemon transport');
  }
}

/**
 * Rebuild an observation from ONLY the whitelisted BrowserObservation fields. The
 * field-by-field invariant validates known URL/header/query/id fields but does not reject
 * EXTRA keys, so a raw source could attach `rawRequestHeaders`/`postData` (with credentials)
 * that would otherwise survive `stop()`/`listObservations()` and reach the normalizer. Run
 * this AFTER `assertSafeBrowserObservation`, on an already-validated observation.
 */
function pickStringHeaders(headers: Record<string, unknown>): Record<string, string> {
  // Copy only STRING header values: a non-string JSON value (a nested object with a secret)
  // must not survive into stored/returned observations via stop()/listObservations().
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

function pickSafeObservation(observation: BrowserObservation): BrowserObservation {
  const safe: BrowserObservation = {
    id: observation.id,
    runId: observation.runId,
    source: observation.source,
    capturedAt: observation.capturedAt,
  };
  if (observation.pageTargetRef !== undefined) safe.pageTargetRef = observation.pageTargetRef;
  if (observation.request) {
    const request = observation.request;
    safe.request = { url: request.url, method: request.method };
    if (request.headersPreview) safe.request.headersPreview = pickStringHeaders(request.headersPreview);
    if (request.resourceType !== undefined) safe.request.resourceType = request.resourceType;
    if (request.bodyShape !== undefined) safe.request.bodyShape = request.bodyShape;
    if (Array.isArray(request.queryParamNames)) safe.request.queryParamNames = [...request.queryParamNames];
  }
  if (observation.response) {
    const response = observation.response;
    safe.response = {};
    if (response.status !== undefined) safe.response.status = response.status;
    // SANITIZE, not copy: the gate has no MIME check (a parameter is not per-se unsafe), so
    // strip free-form parameters here -- `application/json; boundary=<secret>` must not
    // survive into stored/returned observations. An invalid base drops the field.
    const mimeType = cleanMimeType(response.mimeType);
    if (mimeType !== undefined) safe.response.mimeType = mimeType;
    if (response.headersPreview) safe.response.headersPreview = pickStringHeaders(response.headersPreview);
    if (response.bodyShape !== undefined) safe.response.bodyShape = response.bodyShape;
  }
  if (observation.timing) {
    const timing = observation.timing;
    safe.timing = {};
    if (timing.startedAt !== undefined) safe.timing.startedAt = timing.startedAt;
    if (timing.durationMs !== undefined) safe.timing.durationMs = timing.durationMs;
  }
  return safe;
}

/**
 * In-memory capture session. `start` marks a (runId, pageTargetRef) window active; `stop`
 * collects raw observations from the source, runs each through `assertSafeBrowserObservation`
 * as a fail-safe gate (an unsafe one is EXCLUDED — never returned or stored — with a
 * value-free diagnostic), stores the safe ones, and returns them. So only invariant-clean
 * observations can ever reach the evidence bridge.
 */
export class BrowserNetworkCaptureSession implements NetworkCaptureSession {
  readonly #source: NetworkObservationSource;
  readonly #active = new Set<string>();
  // Teardown debts: windows whose active key was dropped by abort() but whose source
  // teardown (abortCapture) has not yet SUCCEEDED. Tracked separately from #active so a
  // rejected teardown stays retryable (see abort()).
  readonly #pendingTeardown = new Set<string>();
  // Windows opened on a source that ACTUALLY had a capture-lifecycle hook (beginCapture OR
  // abortCapture) at open time. Only these can owe cleanup: such a source maintains a real
  // buffer, so an unreset/undiscarded window may still be accumulating. A hookless fixture
  // source (`collect` only) holds no buffer, so charging it a debt would permanently block
  // its restarts. A begin-capable-but-not-abort-capable window COUNTS: if that adaptive
  // source later loses beginCapture, a restart would otherwise reactivate the key over an
  // unreset pre-boundary buffer and stop() could collect it as discovery evidence.
  readonly #cleanupOwed = new Set<string>();
  // Per-key lifecycle lock: start/stop/abort for one window run strictly in sequence.
  // Without it, an abortCapture still in flight can finish AFTER a concurrent start() has
  // reset and re-activated the window, discarding the fresh source window while the active
  // key stays set -- a later stop() would then collect from a torn-down window.
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #observations = new Map<string, BrowserObservation[]>();

  constructor(source: NetworkObservationSource = new NotImplementedNetworkObservationSource()) {
    this.#source = source;
  }

  // Serialize `fn` behind any in-flight operation for `key` (running regardless of whether
  // that one settled or threw), and drop the chain entry once this call is the tail.
  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    // The stored tail never rejects, so one failed operation cannot poison later waiters.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  async start(input: StartNetworkCaptureInput): Promise<void> {
    // Canonicalize BOTH identifiers ONCE and derive the window key from those exact strings:
    // a caller field backed by a stateful toString()/getter could otherwise register one
    // (run, page) window as active while asking the source to reset a DIFFERENT one, so a
    // later stop() for the registered window would pass the active check and collect its
    // unreset, pre-boundary buffer. The same snapshots feed every source/storage call.
    const runId = String(input.runId);
    const expectedTarget = String(input.pageTargetRef);
    const key = this.#key(runId, expectedTarget);
    return this.#withLock(key, async () => {
      // INVALIDATE the window before resetting: even a RE-start of an already-active window
      // must not leave the old key live if the reset fails. Drop the key first, run the
      // source's begin/reset, and re-add the key ONLY after a successful reset -- so if
      // beginCapture rejects, a later stop() cannot collect the old, pre-boundary buffer. (A
      // fixture source omits beginCapture; the delete+add is then a no-op round-trip.)
      // SNAPSHOT the hooks BEFORE invoking them. An adaptive source can remove a hook while
      // its own call is still in flight, so re-reading `this.#source.*` afterwards could
      // record NO cleanup obligation for a window that was in fact opened buffer-backed --
      // and a later hookless restart would then reactivate the key over the stale
      // pre-boundary buffer, contaminating discovery evidence.
      const beginCapture = this.#source.beginCapture;
      const abortCapture = this.#source.abortCapture;
      const bufferBacked = Boolean(beginCapture || abortCapture);
      const wasActive = this.#active.delete(key);
      if (beginCapture) {
        try {
          await beginCapture.call(this.#source, { runId, pageTargetRef: expectedTarget });
        } catch (error) {
          // A FAILED re-start of an ACTIVE window leaves the OLD source window possibly still
          // buffering, and the active key is already gone -- so nothing downstream could ever
          // reclaim it (a later abort() would see no window, and the caller never got a
          // resolved start() to pair an abort with). Record the teardown debt for that old
          // window and repay it here if we can; either way the debt survives for a later
          // retry, and the original reset failure is what the caller sees.
          // Regardless of whether an OLDER active window existed: a beginCapture that starts
          // buffering and then rejects has left a partial buffer behind, and the key was
          // never added to #active, so no later abort() could reclaim it. Any buffer-backed
          // start owes cleanup for the buffer it just attempted.
          if (bufferBacked) {
            this.#cleanupOwed.add(key);
            this.#pendingTeardown.add(key);
            if (abortCapture) {
              try {
                await abortCapture.call(this.#source, { runId, pageTargetRef: expectedTarget });
                this.#pendingTeardown.delete(key);
              } catch {
                // keep the debt -- a later start()/abort() retries the teardown
              }
            }
          }
          throw error;
        }
        // An ACTUAL successful reset supersedes any outstanding teardown debt: the source's
        // buffer for this window was just dropped, so there is nothing stale left to discard.
        this.#pendingTeardown.delete(key);
      } else if (this.#pendingTeardown.has(key)) {
        // No reset is possible (the source has no beginCapture), so an unpaid teardown debt
        // means the stale pre-boundary buffer may still be live. REPAY it before reopening:
        // otherwise this restart would mark the window active over that buffer and stop()
        // could collect it. A rejected repayment keeps the debt and fails the start. If the
        // teardown capability itself has DISAPPEARED (an adaptive source dropping
        // abortCapture after its transport failed), nothing can prove the buffer was
        // discarded -- fail the start and RETAIN the debt rather than silently activating
        // over stale traffic. (A source that NEVER had abortCapture is never charged a debt,
        // so it does not reach this branch and restarts normally.)
        if (!this.#source.abortCapture) {
          throw new Error('capture window has an unpaid teardown debt and the source can neither reset nor abort');
        }
        await this.#source.abortCapture({ runId, pageTargetRef: expectedTarget });
        this.#pendingTeardown.delete(key);
      }
      // Record whether THIS window is buffer-backed, judged from the hooks that were present
      // when it was OPENED -- never re-read from the mutable source after the reset call.
      if (bufferBacked) this.#cleanupOwed.add(key);
      else this.#cleanupOwed.delete(key);
      this.#active.add(key);
    });
  }

  async stop(input: StopNetworkCaptureInput): Promise<NetworkCaptureResult> {
    // Same snapshot-once discipline as start(): key and source calls share one conversion.
    const runId = String(input.runId);
    const expectedTarget = String(input.pageTargetRef);
    const key = this.#key(runId, expectedTarget);
    return this.#withLock(key, async () => {
    if (!this.#active.has(key)) {
      throw new Error('network capture stop requires a prior start for this run/pageTargetRef');
    }
    // Collect BEFORE clearing the active window, so a transient collect failure leaves the
    // capture retryable (stop() can be called again) instead of failing 'requires a prior
    // start' forever.
    const raw = await this.#source.collect({ runId, pageTargetRef: expectedTarget });
    this.#active.delete(key);
    this.#cleanupOwed.delete(key);

    const observations: BrowserObservation[] = [];
    const diagnostics: Record<string, unknown>[] = [];

    raw.forEach((observation, index) => {
      // Accept ONLY observations stamped with THIS exact (runId, pageTargetRef) window. A
      // same-run entry MISSING pageTargetRef (or from another run/page) is buffered/stale and
      // would contaminate this page's evidence -> skip it. The diagnostic is positional only.
      const sameRun = observation?.runId === runId;
      const sameTarget =
        observation?.pageTargetRef !== undefined && String(observation.pageTargetRef) === expectedTarget;
      if (!sameRun || !sameTarget) {
        diagnostics.push({ level: 'warning', code: 'observation-window-mismatch-skipped', index });
        return;
      }
      try {
        assertSafeBrowserObservation(observation);
        // Store ONLY the whitelisted fields, so an extra source-controlled property can't
        // survive the gate (it validates known fields, not unknown keys).
        observations.push(pickSafeObservation(observation));
      } catch {
        // A rejected observation is source-controlled: do NOT echo its id or the assertion
        // message (which can name a header) -- a positional skip id leaks nothing.
        diagnostics.push({ level: 'warning', code: 'unsafe-observation-skipped', index });
      }
    });

    const existing = this.#observations.get(runId) ?? [];
    this.#observations.set(runId, [...existing, ...observations]);
    return { observations, diagnostics };
    });
  }

  /**
   * Close the window without collecting: the active key is dropped FIRST (so a later stop()
   * is rejected even if the source's teardown throws), then the source is told to discard its
   * buffer. Nothing is stored or returned — an aborted window contributes no observations.
   *
   * The source teardown is tracked as a SEPARATE debt until abortCapture() succeeds: dropping
   * only the active key meant a rejected teardown made a RETRY of abort() see "no window" and
   * skip the source call forever, leaving a real transport live and buffering for a run that
   * is already terminal. A retried abort() re-attempts the teardown until it succeeds (or the
   * window is legitimately restarted, which resets the source's buffer anyway).
   */
  async abort(input: StopNetworkCaptureInput): Promise<void> {
    // Same snapshot-once discipline as start(): key and source calls share one conversion.
    const runId = String(input.runId);
    const expectedTarget = String(input.pageTargetRef);
    const key = this.#key(runId, expectedTarget);
    return this.#withLock(key, async () => {
      const hadWindow = this.#active.delete(key);
      // Record the debt BEFORE consulting the CURRENT capability: an adaptive source can lose
      // abortCapture between start() and abort(), and returning early without the debt would
      // let a later restart (once the capability returns) reopen the window without ever
      // discarding the still-live stale buffer. Only a window that was opened while the
      // source HAD the hook can owe anything -- a source that never supported teardown holds
      // no buffer to discard, and charging it would permanently block its restarts.
      if (hadWindow && this.#cleanupOwed.has(key)) this.#pendingTeardown.add(key);
      this.#cleanupOwed.delete(key);
      if (!this.#source.abortCapture) return;
      if (this.#pendingTeardown.has(key)) {
        await this.#source.abortCapture({ runId, pageTargetRef: expectedTarget });
        this.#pendingTeardown.delete(key);
      }
    });
  }

  async listObservations(runId: string): Promise<BrowserObservation[]> {
    return [...(this.#observations.get(runId) ?? [])];
  }

  // Takes the ALREADY-canonicalized target string: every public method converts the caller's
  // ref exactly once and passes that snapshot here (never the raw input).
  #key(runId: string, pageTargetRef: string): string {
    return JSON.stringify([runId, pageTargetRef]);
  }
}
