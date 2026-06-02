import { randomUUID } from 'node:crypto';
import type { BrowserSessionRef } from '../runtime';
import { toPersistableSessionRecord } from './persistenceGuard';
import type { BrowserDaemonMode, PageTargetRef } from './types';

/**
 * Refinement #2 — opaque browser session registry.
 *
 * `createBrowserSessionRef` produces a structurally-transparent ref
 * (`daemon:<id>:session:<runId>`), which is safe from *secrets* but lets anyone
 * holding a checkpoint read the runId/daemon back out and link runs. For state
 * that lands in a persisted checkpoint we prefer an opaque surrogate: a random
 * `session:<uuid>` handle whose mapping to `{ daemonId, runId, pageTargetRef,
 * targetUrl }` lives only in this registry.
 *
 * The registry is also the natural home for stale-target recreation context
 * (Phase 3.6): when a page target goes stale after resume, the recreation logic
 * looks up the original target/url here rather than reading it from the
 * checkpoint.
 *
 * Runtime never imports this module — only `src/browser/*` does. The checkpoint
 * stores the opaque `sessionId` string and nothing else about the browser.
 *
 * DURABILITY BOUNDARY (Phase 3.2 scope): `BrowserSessionRegistry` is an
 * interface so a durable (file/DB-backed) implementation can be dropped in
 * later without touching callers. The only implementation shipped here,
 * `InMemoryBrowserSessionRegistry`, is process-local. Consequently, after a
 * process restart a checkpoint holds only its `session:<uuid>` surrogate and
 * the `{ daemonId, runId, pageTargetRef, targetUrlPreview }` mapping is gone —
 * so **Phase 3.2 supports same-process resume only**. Cross-restart resume
 * requires either a durable registry implementation or persisting enough
 * recreation context in the checkpoint itself, both deferred to later Phase 3
 * work (see Phase 3.6 stale-target recreation). Do not assume the in-memory
 * registry survives a restart.
 */

export type BrowserSessionRecord = {
  /** Opaque surrogate persisted in the checkpoint, e.g. `session:<uuid>`. */
  sessionId: BrowserSessionRef | string;
  daemonId: string;
  runId: string;
  /** Transparent ref form, kept registry-side only for diagnostics/back-compat. */
  transparentRef: string;
  pageTargetRef?: PageTargetRef | string;
  targetUrlPreview?: string;
  mode: BrowserDaemonMode;
  createdAt: string;
  updatedAt: string;
};

export type RegisterBrowserSessionInput = {
  daemonId: string;
  runId: string;
  transparentRef: string;
  mode: BrowserDaemonMode;
  pageTargetRef?: PageTargetRef | string;
  targetUrlPreview?: string;
  now?: string;
};

export type UpdateBrowserSessionInput = {
  sessionId: BrowserSessionRef | string;
  pageTargetRef?: PageTargetRef | string;
  targetUrlPreview?: string;
  now?: string;
};

export interface BrowserSessionRegistry {
  register(input: RegisterBrowserSessionInput): BrowserSessionRecord;
  get(sessionId: BrowserSessionRef | string): BrowserSessionRecord | undefined;
  update(input: UpdateBrowserSessionInput): BrowserSessionRecord;
  forget(sessionId: BrowserSessionRef | string): void;
}

export type SessionIdFactory = () => string;

function defaultSessionIdFactory(): string {
  return `session:${randomUUID()}`;
}

function defaultClock(): string {
  return new Date().toISOString();
}

// Field-level safety is centralized in `persistenceGuard.ts`. The registry
// never stores a raw value; every record is built via `toPersistableSessionRecord`,
// which classifies and disposes each field (reject vs sanitize). `sanitizeUrlPreview`
// is re-exported above for back-compat with existing callers/tests.

export type InMemoryBrowserSessionRegistryOptions = {
  sessionIdFactory?: SessionIdFactory;
  clock?: () => string;
};

export class InMemoryBrowserSessionRegistry implements BrowserSessionRegistry {
  readonly #records = new Map<string, BrowserSessionRecord>();
  readonly #sessionIdFactory: SessionIdFactory;
  readonly #clock: () => string;

  constructor(options: InMemoryBrowserSessionRegistryOptions = {}) {
    this.#sessionIdFactory = options.sessionIdFactory ?? defaultSessionIdFactory;
    this.#clock = options.clock ?? defaultClock;
  }

  register(input: RegisterBrowserSessionInput): BrowserSessionRecord {
    const sessionId = this.#sessionIdFactory();
    // Every persisted field is classified and disposed here; an unsafe field
    // throws (operational handles) or is sanitized (previews). Adding a field
    // without classifying it in the guard is a TypeScript error.
    const safe = toPersistableSessionRecord({
      sessionId,
      daemonId: input.daemonId,
      runId: input.runId,
      transparentRef: input.transparentRef,
      pageTargetRef: input.pageTargetRef,
      targetUrlPreview: input.targetUrlPreview,
      mode: input.mode,
    });
    if (this.#records.has(safe.sessionId)) {
      throw new Error(`browser session ${safe.sessionId} already registered`);
    }
    const now = input.now ?? this.#clock();
    const record: BrowserSessionRecord = {
      ...safe,
      createdAt: now,
      updatedAt: now,
    };
    this.#records.set(safe.sessionId, { ...record });
    return { ...record };
  }

  get(sessionId: BrowserSessionRef | string): BrowserSessionRecord | undefined {
    const record = this.#records.get(String(sessionId));
    return record ? { ...record } : undefined;
  }

  update(input: UpdateBrowserSessionInput): BrowserSessionRecord {
    const key = String(input.sessionId);
    const existing = this.#records.get(key);
    if (!existing) {
      throw new Error(`browser session ${key} not found`);
    }
    // Re-run the full merged record through the guard so incoming fields
    // (pageTargetRef, targetUrlPreview) are classified on every write, not just
    // at register. Throws before mutating if an incoming field is unsafe.
    const safe = toPersistableSessionRecord({
      sessionId: existing.sessionId,
      daemonId: existing.daemonId,
      runId: existing.runId,
      transparentRef: existing.transparentRef,
      pageTargetRef: input.pageTargetRef ?? existing.pageTargetRef,
      targetUrlPreview: input.targetUrlPreview !== undefined ? input.targetUrlPreview : existing.targetUrlPreview,
      mode: existing.mode,
    });
    const updated: BrowserSessionRecord = {
      ...existing,
      ...safe,
      updatedAt: input.now ?? this.#clock(),
    };
    this.#records.set(key, { ...updated });
    return { ...updated };
  }

  forget(sessionId: BrowserSessionRef | string): void {
    this.#records.delete(String(sessionId));
  }
}
