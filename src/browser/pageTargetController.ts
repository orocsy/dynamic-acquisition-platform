import { randomUUID } from 'node:crypto';
import { isPageTargetRef } from './browserRef';
import { redactBrowserDiagnosticData } from './browserRedaction';
import {
  resolveNavigationTimeoutMs,
  resolveNavigationWaitMode,
  sanitizeNavigationUrlPreview,
  type NavigationWaitMode,
} from './navigationPolicy';
import { isPageTargetError, PageTargetError } from './pageTargetErrors';
import type { BrowserDaemonRef, BrowserTargetState, PageTargetRef } from './types';

/**
 * Phase 3.3 — page target lifecycle.
 *
 * A `PageTargetController` gives each run deterministic control over a browser
 * page: create it, get it, navigate it, mark it stale, close it. It is the
 * browser-side state machine `created -> navigating -> ready -> stale -> closed`.
 *
 * Boundary rules (the reason this slice exists at all):
 *   - It MUST NOT mutate runtime checkpoints. The Phase 2 `RuntimeCoordinator`
 *     owns run lifecycle; this controller owns only the page target, and an
 *     illegal transition is a rejected promise, not a state change.
 *   - Every page ref it produces has the opaque `page:<id>` shape and is validated
 *     at the source (`mintPageTargetRef`), so the value that later lands in the
 *     session registry already passes that registry's `guardPageTargetRef`. The
 *     recurring defect in this codebase has been a persisted browser value that
 *     slipped past a guard; minting validates up front rather than at persist.
 *   - No default live-user/`profile=user` attach path exists here.
 */

// ---- Public contract (LLD §6.3) ------------------------------------------

export type CreatePageTargetInput = {
  daemonRef: BrowserDaemonRef;
  runId: string;
  targetUrl?: string;
  now?: string;
};

export type NavigatePageTargetInput = {
  pageTargetRef: PageTargetRef | string;
  url: string;
  timeoutMs?: number;
  waitUntil?: NavigationWaitMode;
  now?: string;
};

export type PageTargetSnapshot = {
  pageTargetRef: PageTargetRef | string;
  state: BrowserTargetState;
  urlPreview?: string;
  titlePreview?: string;
  updatedAt: string;
};

export type BrowserNavigationResult = {
  ok: boolean;
  pageTargetRef: PageTargetRef | string;
  finalUrlPreview?: string;
  status?: number;
  state: BrowserTargetState;
  durationMs?: number;
  diagnostics: Record<string, unknown>[];
};

export interface PageTargetController {
  createTarget(input: CreatePageTargetInput): Promise<PageTargetSnapshot>;
  getTarget(ref: PageTargetRef | string): Promise<PageTargetSnapshot | undefined>;
  navigate(input: NavigatePageTargetInput): Promise<BrowserNavigationResult>;
  markStale(ref: PageTargetRef | string, reason: string): Promise<PageTargetSnapshot>;
  closeTarget(ref: PageTargetRef | string): Promise<PageTargetSnapshot>;
}

// ---- Shared state machine + ref discipline (used by every implementation) --

/**
 * Allowed page-target transitions (LLD §6.4). The doc lists the happy path
 * (`created -> navigating -> ready -> stale -> closed`) plus the teardown edges;
 * `created/navigating -> stale` are the navigation-failure edges and `* -> closed`
 * is teardown. Anything not listed is rejected by `assertTargetTransition`.
 */
export const ALLOWED_TARGET_TRANSITIONS: Record<BrowserTargetState, readonly BrowserTargetState[]> = {
  created: ['navigating', 'stale', 'closed'],
  navigating: ['ready', 'stale', 'closed'],
  ready: ['navigating', 'stale', 'closed'],
  stale: ['closed'],
  closed: [],
};

export function canTransition(from: BrowserTargetState, to: BrowserTargetState): boolean {
  return ALLOWED_TARGET_TRANSITIONS[from].includes(to);
}

/**
 * Throw a structured `PageTargetError` for an illegal transition. The two cases
 * callers branch on most — navigating a closed or a stale target — get precise
 * codes; everything else is `invalid-transition`.
 */
export function assertTargetTransition(
  ref: PageTargetRef | string,
  from: BrowserTargetState,
  to: BrowserTargetState,
): void {
  if (canTransition(from, to)) return;
  if (from === 'closed') {
    throw new PageTargetError('target-closed', `page target is closed and cannot move to ${to}`, {
      pageTargetRef: refForError(ref),
      from,
      to,
    });
  }
  if (from === 'stale' && to === 'navigating') {
    throw new PageTargetError('target-stale', 'stale page target cannot navigate; recreate it first', {
      pageTargetRef: refForError(ref),
      from,
      to,
    });
  }
  throw new PageTargetError('invalid-transition', `illegal page target transition ${from} -> ${to}`, {
    pageTargetRef: refForError(ref),
    from,
    to,
  });
}

export type PageTargetRefFactory = () => string;

export function defaultPageTargetRefFactory(): string {
  return `page:${randomUUID()}`;
}

/**
 * Mint a page target ref and prove it has the safe `page:<opaque-id>` shape
 * before it can escape the controller. A page ref is persisted in the session
 * registry via `guardPageTargetRef`, so an unsafe factory output (a `ws://`/
 * `devtools` URL or a profile path) or a wrong-shaped one (a session ref, an
 * arbitrary token) is rejected here, at the source — not later at persist time.
 * The rejected value is deliberately NOT echoed into the error: it may carry the
 * very URL/path we are refusing to surface (Finding #1).
 */
export function mintPageTargetRef(factory: PageTargetRefFactory = defaultPageTargetRefFactory): string {
  const ref = factory();
  if (!isPageTargetRef(ref)) {
    throw new PageTargetError(
      'unsafe-target-ref',
      'minted page target ref must be an opaque page:<id> ref (not a ws/devtools URL, profile path, or session ref)',
    );
  }
  return ref;
}

/**
 * Defense in depth for Finding #1: a `PageTargetError` must never carry a ref
 * that is not a safe page ref. Even if an internal path is reached with an
 * unvalidated value, the error surfaces `undefined` rather than echoing a
 * `ws://`/`devtools` URL or a profile path back to a caller or a log. The public
 * boundary (`normalizeIncomingRef`) already rejects such refs up front; this
 * guarantees the no-echo property structurally, the way the persistence guard
 * guarantees its fields.
 */
export function refForError(ref: PageTargetRef | string): string | undefined {
  const value = String(ref);
  return isPageTargetRef(value) ? value : undefined;
}

/** Run each diagnostic object through the browser redactor so a URL value that */
/** carries a query secret is sanitized before it can reach a result/log.       */
export function sanitizeNavigationDiagnostics(
  diagnostics: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return diagnostics.map((entry) => redactBrowserDiagnosticData(entry));
}

// ---- In-memory target store (shared; the only place state changes) ---------

export type NewPageTargetRecord = {
  pageTargetRef: string;
  runId: string;
  daemonId: string;
  urlPreview?: string;
  titlePreview?: string;
  createdAt: string;
  updatedAt: string;
};

type PageTargetRecord = NewPageTargetRecord & { state: BrowserTargetState };

function toSnapshot(record: PageTargetRecord): PageTargetSnapshot {
  return {
    pageTargetRef: record.pageTargetRef,
    state: record.state,
    urlPreview: record.urlPreview,
    titlePreview: record.titlePreview,
    updatedAt: record.updatedAt,
  };
}

/**
 * Owns the records map and is the single place a target's state changes, so the
 * transition table is enforced exactly once for every implementation. It does no
 * I/O: a controller performs the browser work, then asks the store to record the
 * resulting transition. `transition` asserts legality BEFORE mutating, so a
 * rejected transition leaves the record untouched.
 */
export class PageTargetStore {
  readonly #records = new Map<string, PageTargetRecord>();

  insertCreated(record: NewPageTargetRecord): PageTargetSnapshot {
    if (this.#records.has(record.pageTargetRef)) {
      throw new PageTargetError('invalid-transition', 'page target ref already exists', {
        pageTargetRef: refForError(record.pageTargetRef),
      });
    }
    const full: PageTargetRecord = { ...record, state: 'created' };
    this.#records.set(full.pageTargetRef, full);
    return toSnapshot(full);
  }

  get(ref: PageTargetRef | string): PageTargetSnapshot | undefined {
    const record = this.#records.get(String(ref));
    return record ? toSnapshot(record) : undefined;
  }

  /**
   * Remove a record entirely. Used only to roll back a reservation when the
   * browser-side create that followed it fails, so a failed create leaves no
   * ghost `created` target behind (Finding #4).
   */
  delete(ref: PageTargetRef | string): void {
    this.#records.delete(String(ref));
  }

  requireSnapshot(ref: PageTargetRef | string): PageTargetSnapshot {
    const snapshot = this.get(ref);
    if (!snapshot) {
      throw new PageTargetError('unknown-target', 'page target not found', { pageTargetRef: refForError(ref) });
    }
    return snapshot;
  }

  currentState(ref: PageTargetRef | string): BrowserTargetState {
    return this.requireSnapshot(ref).state;
  }

  transition(
    ref: PageTargetRef | string,
    to: BrowserTargetState,
    updatedAt: string,
    patch: { urlPreview?: string; titlePreview?: string } = {},
  ): PageTargetSnapshot {
    const key = String(ref);
    const existing = this.#records.get(key);
    if (!existing) {
      throw new PageTargetError('unknown-target', 'page target not found', { pageTargetRef: refForError(key) });
    }
    // Asserts (and throws) before any mutation, so an illegal transition cannot
    // leave the record half-changed.
    assertTargetTransition(key, existing.state, to);
    const updated: PageTargetRecord = {
      ...existing,
      state: to,
      urlPreview: patch.urlPreview !== undefined ? patch.urlPreview : existing.urlPreview,
      titlePreview: patch.titlePreview !== undefined ? patch.titlePreview : existing.titlePreview,
      updatedAt,
    };
    this.#records.set(key, updated);
    return toSnapshot(updated);
  }
}

// ---- Base controller: state machine once, effects per implementation -------

/**
 * The outcome a concrete controller reports for one navigation attempt. The base
 * class wraps this in the `navigating -> ready|stale` transition and the result
 * shape, so a subclass only describes *what happened*, never *how state moves*.
 */
export type NavigationEffectResult = {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  titlePreview?: string;
  durationMs?: number;
  diagnostics?: Record<string, unknown>[];
};

export type NavigationEffectContext = {
  pageTargetRef: string;
  waitUntil: NavigationWaitMode;
  timeoutMs: number;
  from: BrowserTargetState;
};

export type BasePageTargetControllerOptions = {
  pageTargetRefFactory?: PageTargetRefFactory;
  clock?: () => string;
};

function defaultClock(): string {
  return new Date().toISOString();
}

export abstract class BasePageTargetController implements PageTargetController {
  protected readonly store = new PageTargetStore();
  protected readonly mintRef: PageTargetRefFactory;
  protected readonly clock: () => string;

  constructor(options: BasePageTargetControllerOptions = {}) {
    this.mintRef = options.pageTargetRefFactory ?? defaultPageTargetRefFactory;
    this.clock = options.clock ?? defaultClock;
  }

  abstract createTarget(input: CreatePageTargetInput): Promise<PageTargetSnapshot>;

  /** Perform the actual navigation effect; the base owns the state transitions. */
  protected abstract performNavigation(
    input: NavigatePageTargetInput,
    context: NavigationEffectContext,
  ): Promise<NavigationEffectResult>;

  /** Hook for subclasses to release transport resources on close; default no-op. */
  protected async onClose(_ref: PageTargetRef | string): Promise<void> {
    /* no-op */
  }

  /**
   * Validate a caller-supplied ref at the public boundary (Finding #1). An unsafe
   * ref — a `ws://`/`devtools` URL, a profile path, or any non-`page:` string —
   * cannot correspond to a stored target and must never be echoed back in an
   * error, so it is rejected as `unsafe-target-ref` WITHOUT carrying the raw
   * value. A well-formed but unknown `page:<id>` ref is safe to echo and surfaces
   * as the store's `unknown-target`.
   */
  protected normalizeIncomingRef(ref: PageTargetRef | string): string {
    const value = String(ref);
    if (!isPageTargetRef(value)) {
      throw new PageTargetError('unsafe-target-ref', 'page target ref must be an opaque page:<id> ref');
    }
    return value;
  }

  async getTarget(ref: PageTargetRef | string): Promise<PageTargetSnapshot | undefined> {
    // An unsafe/wrong-shaped ref can never be a known target; honor the "not
    // found" contract (undefined) without echoing it anywhere.
    if (!isPageTargetRef(String(ref))) return undefined;
    return this.store.get(ref);
  }

  async navigate(input: NavigatePageTargetInput): Promise<BrowserNavigationResult> {
    const ref = this.normalizeIncomingRef(input.pageTargetRef);
    // Validate inputs (throws) before touching state.
    const waitUntil = resolveNavigationWaitMode(input.waitUntil);
    const timeoutMs = resolveNavigationTimeoutMs(input.timeoutMs);
    const startedAt = input.now ?? this.clock();

    const record = this.store.requireSnapshot(ref); // throws unknown-target
    // Enter `navigating` — throws target-closed / target-stale / invalid-transition
    // for an illegal source state, BEFORE any browser work happens.
    this.store.transition(ref, 'navigating', startedAt);

    let effect: NavigationEffectResult;
    try {
      effect = await this.performNavigation(input, {
        pageTargetRef: ref,
        waitUntil,
        timeoutMs,
        from: record.state,
      });
    } catch (error) {
      const failedAt = input.now ?? this.clock();
      const snapshot = this.store.transition(ref, 'stale', failedAt);
      return {
        ok: false,
        pageTargetRef: ref,
        finalUrlPreview: sanitizeNavigationUrlPreview(input.url),
        state: snapshot.state,
        diagnostics: sanitizeNavigationDiagnostics([
          { code: isPageTargetError(error) ? error.code : 'navigation-failed', reason: 'navigation effect threw' },
        ]),
      };
    }

    const finishedAt = input.now ?? this.clock();
    const finalUrlPreview = sanitizeNavigationUrlPreview(effect.finalUrl ?? input.url);
    const diagnostics = sanitizeNavigationDiagnostics(effect.diagnostics ?? []);

    if (effect.ok) {
      const snapshot = this.store.transition(ref, 'ready', finishedAt, {
        urlPreview: finalUrlPreview,
        titlePreview: effect.titlePreview,
      });
      return {
        ok: true,
        pageTargetRef: ref,
        finalUrlPreview,
        status: effect.status,
        state: snapshot.state,
        durationMs: effect.durationMs,
        diagnostics,
      };
    }

    const snapshot = this.store.transition(ref, 'stale', finishedAt);
    return {
      ok: false,
      pageTargetRef: ref,
      finalUrlPreview,
      status: effect.status,
      state: snapshot.state,
      durationMs: effect.durationMs,
      diagnostics: diagnostics.length > 0 ? diagnostics : [{ code: 'navigation-failed', reason: 'navigation returned ok:false' }],
    };
  }

  async markStale(refInput: PageTargetRef | string, _reason: string): Promise<PageTargetSnapshot> {
    // `_reason` is accepted for interface parity/telemetry; it is intentionally
    // not stored in the opaque snapshot.
    const ref = this.normalizeIncomingRef(refInput);
    const now = this.clock();
    const current = this.store.currentState(ref); // throws unknown-target
    if (current === 'stale') return this.store.requireSnapshot(ref); // idempotent
    if (current === 'closed') {
      throw new PageTargetError('target-closed', 'closed page target cannot be marked stale', {
        pageTargetRef: refForError(ref),
        from: current,
        to: 'stale',
      });
    }
    return this.store.transition(ref, 'stale', now);
  }

  async closeTarget(refInput: PageTargetRef | string): Promise<PageTargetSnapshot> {
    const ref = this.normalizeIncomingRef(refInput);
    const now = this.clock();
    const current = this.store.currentState(ref); // throws unknown-target
    if (current === 'closed') return this.store.requireSnapshot(ref); // idempotent teardown
    await this.onClose(ref);
    return this.store.transition(ref, 'closed', now);
  }
}

// ---- Real adapter: CDP transport injected, wire protocol deferred ----------

/**
 * Narrow port the real controller uses to talk to the daemon. It deals only in
 * an internal `rawTargetId` (a CDP target GUID) — never a websocket/devtools URL,
 * which the controller must never surface. The controller maps `rawTargetId` to
 * an opaque `page:<uuid>` ref and keeps the mapping process-local.
 *
 * This mirrors the Phase 3.2 boundary where the daemon *health* check is real
 * but daemon *launch* is deferred behind an adapter: here the page bookkeeping,
 * state machine, and ref discipline are real and tested, while the CDP wire
 * calls live behind this port so a concrete transport can be dropped in later
 * without touching any of that.
 */
export interface CdpTargetTransport {
  createTarget(input: { daemonRef: BrowserDaemonRef; targetUrl?: string }): Promise<{ rawTargetId: string }>;
  navigate(input: {
    rawTargetId: string;
    url: string;
    waitUntil: NavigationWaitMode;
    timeoutMs: number;
  }): Promise<{ ok: boolean; status?: number; finalUrl?: string; titlePreview?: string; durationMs?: number }>;
  close(input: { rawTargetId: string }): Promise<void>;
}

/**
 * The transport shipped in Phase 3.3. Every call fails with a structured
 * `transport-unavailable` error: the real CDP websocket session is deferred (the
 * same bucket as the daemon launch adapter). It exists so
 * `ChromePageTargetController` is constructible and interface-complete today, and
 * so callers get a clear non-secret failure instead of a half-built navigation.
 */
export class NotImplementedCdpTargetTransport implements CdpTargetTransport {
  async createTarget(): Promise<{ rawTargetId: string }> {
    throw new PageTargetError('transport-unavailable', 'CDP target transport is not implemented yet (deferred to later Phase 3 work)');
  }

  async navigate(): Promise<{ ok: boolean }> {
    throw new PageTargetError('transport-unavailable', 'CDP target transport is not implemented yet (deferred to later Phase 3 work)');
  }

  async close(): Promise<void> {
    throw new PageTargetError('transport-unavailable', 'CDP target transport is not implemented yet (deferred to later Phase 3 work)');
  }
}

export type ChromePageTargetControllerOptions = BasePageTargetControllerOptions & {
  transport?: CdpTargetTransport;
};

/**
 * Real local Chrome page target controller. Reuses the base state machine and
 * opaque-ref discipline; only the actual page work is delegated to an injected
 * `CdpTargetTransport`. With the default (not-implemented) transport, create and
 * navigate fail with a structured `transport-unavailable` error rather than
 * pretending to drive a browser.
 */
export class ChromePageTargetController extends BasePageTargetController {
  readonly #transport: CdpTargetTransport;
  // rawTargetId is internal only: it never appears in a snapshot, a result, or a
  // persisted field. The opaque `page:<uuid>` ref is the only handle that leaves.
  readonly #rawByRef = new Map<string, string>();

  constructor(options: ChromePageTargetControllerOptions = {}) {
    super(options);
    this.#transport = options.transport ?? new NotImplementedCdpTargetTransport();
  }

  async createTarget(input: CreatePageTargetInput): Promise<PageTargetSnapshot> {
    // Mint + reserve the ref BEFORE any CDP work (Finding #4). `insertCreated`
    // throws synchronously on a duplicate ref, so a colliding factory output can
    // neither open a second raw target nor rebind the existing mapping. The raw
    // target id is recorded only after the create succeeds; a failed create rolls
    // the reservation back so no ghost `created` target is left behind.
    const ref = mintPageTargetRef(this.mintRef);
    const now = input.now ?? this.clock();
    const snapshot = this.store.insertCreated({
      pageTargetRef: ref,
      runId: input.runId,
      daemonId: String(input.daemonRef.id),
      urlPreview: sanitizeNavigationUrlPreview(input.targetUrl),
      titlePreview: undefined,
      createdAt: now,
      updatedAt: now,
    });
    let rawTargetId: string;
    try {
      ({ rawTargetId } = await this.#transport.createTarget({
        daemonRef: input.daemonRef,
        targetUrl: input.targetUrl,
      }));
    } catch (error) {
      // Roll back the reservation, and never surface a raw transport error: it may
      // carry a ws://devtools URL. A structured PageTargetError passes through
      // (e.g. the not-implemented transport's `transport-unavailable`); any other
      // error is wrapped without its message.
      this.store.delete(ref);
      if (isPageTargetError(error)) throw error;
      throw new PageTargetError('transport-unavailable', 'CDP target create failed', {
        pageTargetRef: refForError(ref),
        diagnostics: { reason: 'transport createTarget threw' },
      });
    }
    // A concurrent lifecycle op (closeTarget / navigate / markStale) may have mutated
    // or removed the reserved record during the await above. If it is no longer
    // `created`, binding this freshly-opened raw target to it would orphan a live CDP
    // target on a closed/stale ref and return a snapshot that lies about the state.
    // Close the raw target and surface the store's CURRENT state instead.
    const current = this.store.get(ref);
    if (!current || current.state !== 'created') {
      try {
        await this.#transport.close({ rawTargetId });
      } catch {
        /* best-effort: the ref is already gone/closed, the target must not leak */
      }
      if (!current) {
        throw new PageTargetError('unknown-target', 'page target was removed during creation', {
          pageTargetRef: refForError(ref),
        });
      }
      return current;
    }
    this.#rawByRef.set(ref, rawTargetId);
    return snapshot;
  }

  protected async performNavigation(
    input: NavigatePageTargetInput,
    context: NavigationEffectContext,
  ): Promise<NavigationEffectResult> {
    const rawTargetId = this.#rawByRef.get(context.pageTargetRef);
    if (!rawTargetId) {
      throw new PageTargetError('unknown-target', 'no CDP target mapped for ref', {
        pageTargetRef: refForError(context.pageTargetRef),
      });
    }
    const result = await this.#transport.navigate({
      rawTargetId,
      url: input.url,
      waitUntil: context.waitUntil,
      timeoutMs: context.timeoutMs,
    });
    return {
      ok: result.ok,
      status: result.status,
      finalUrl: result.finalUrl,
      titlePreview: result.titlePreview,
      durationMs: result.durationMs,
    };
  }

  protected override async onClose(ref: PageTargetRef | string): Promise<void> {
    const key = String(ref);
    const rawTargetId = this.#rawByRef.get(key);
    if (rawTargetId) {
      // Best-effort: state still moves to closed even if the transport close fails.
      try {
        await this.#transport.close({ rawTargetId });
      } catch {
        /* swallow: the page target is being torn down regardless */
      }
      this.#rawByRef.delete(key);
    }
  }
}
