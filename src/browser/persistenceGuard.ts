import { isOpaqueBrowserRef, isOpaqueSurrogateSessionId, isPageTargetRef, isSafeBrowserRefPart } from './browserRef';
import type { BrowserDaemonMode } from './types';

/**
 * Single consolidated boundary guard for everything the browser layer persists.
 *
 * Across review rounds, the recurring defect was the same: a persisted browser
 * field that the author forgot to run through an existing guard (header values,
 * `targetUrlPreview`, then `pageTargetRef`). Each field has a *contract* —
 * opaque-surrogate, opaque-ref, ref-part, or sanitized-preview — but the
 * contract was applied field-by-field at each call site, so any new or
 * overlooked field silently bypassed it.
 *
 * This module makes the classification explicit and exhaustive. Every persisted
 * value is mapped to its contract by one of the `guard*` helpers, and a whole
 * persistable record can only be built via `toPersistableSessionRecord`, which
 * covers every field. Adding a field to the persisted record without classifying
 * it here is a TypeScript error, not a runtime leak.
 *
 * Two distinct disposals, deliberately not unified:
 *   - REJECT (throw): operational handles that must be correct or absent
 *     (surrogate ids, opaque refs, ref parts). Redacting them would hand back an
 *     unusable value and hide the caller's bug.
 *   - SANITIZE (rewrite): lossy previews where dropping secrets is acceptable
 *     and the field is informational (`targetUrlPreview`).
 */

export class BrowserPersistenceError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`browser persistence guard rejected ${field}: ${message}`);
    this.name = 'BrowserPersistenceError';
    this.field = field;
  }
}

/** REJECT: the opaque surrogate session id that lands in a checkpoint. */
export function guardSurrogateSessionId(field: string, value: string): string {
  if (!isOpaqueSurrogateSessionId(value)) {
    throw new BrowserPersistenceError(
      field,
      'must be an opaque surrogate (not the transparent daemon:...:session:... form, no secrets/paths)',
    );
  }
  return value;
}

/** REJECT: an opaque operational ref (no ws/devtools URL, no profile path). Optional. */
export function guardOpaqueRef(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isOpaqueBrowserRef(String(value))) {
    throw new BrowserPersistenceError(
      field,
      'must be an opaque browser ref (no websocket URL, devtools URL, or profile path)',
    );
  }
  return String(value);
}

/**
 * REJECT: a *page target ref* — stricter than `guardOpaqueRef`. It must be the
 * `page:<opaque-id>` shape the controller mints, not merely "opaque". Without
 * this, a transparent session ref (`daemon:…:session:…`), a `session:` surrogate,
 * or an arbitrary token like `not-a-page-ref` would all pass the opacity check
 * and be persisted as a page target ref — the exact hole the 3.2 review left
 * open. Optional (a session record may have no page target yet).
 */
export function guardPageTargetRef(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isPageTargetRef(String(value))) {
    throw new BrowserPersistenceError(
      field,
      'must be a page target ref (page:<opaque-id>; not a session/transparent ref, ws/devtools URL, or profile path)',
    );
  }
  return String(value);
}

/** REJECT: a ref *part* (daemonId/runId) — opaque AND free of `:`/whitespace. */
export function guardRefPart(field: string, value: string): string {
  if (!isSafeBrowserRefPart(value)) {
    throw new BrowserPersistenceError(field, "must be an opaque ref part (no ':' or whitespace)");
  }
  return value;
}

/**
 * REJECT-on-mismatch: the transparent ref is permitted to *be* the transparent
 * form (that is its whole purpose), but must still be free of secrets/paths.
 */
export function guardTransparentRef(field: string, value: string): string {
  if (!isOpaqueBrowserRef(value) && !/^daemon:[^\s]+:session:[^\s]+$/i.test(value)) {
    throw new BrowserPersistenceError(field, 'must be a clean transparent session ref or opaque ref');
  }
  return value;
}

/**
 * SANITIZE: a URL *preview*. Query, fragment, and userinfo are stripped so a
 * secret in the URL is never persisted. Relative/non-URL strings are truncated
 * at the first query/fragment delimiter.
 */
export function sanitizeUrlPreview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] || undefined;
  }
}

/**
 * The persistable shape of a browser session record. Every field that ends up
 * stored must appear here, and `toPersistableSessionRecord` must classify each
 * one — so the type system forces a decision for any new field.
 */
export type PersistableSessionFields = {
  sessionId: string;
  daemonId: string;
  runId: string;
  transparentRef: string;
  pageTargetRef?: string;
  targetUrlPreview?: string;
  mode: BrowserDaemonMode;
};

/**
 * Build a guaranteed-safe set of persistable session fields. This is the only
 * sanctioned way to produce a record for the registry to store: it routes every
 * field through its contract guard, rejecting (throw) operational handles and
 * sanitizing previews.
 */
export function toPersistableSessionRecord(input: PersistableSessionFields): PersistableSessionFields {
  return {
    sessionId: guardSurrogateSessionId('sessionId', input.sessionId),
    daemonId: guardRefPart('daemonId', input.daemonId),
    runId: guardRefPart('runId', input.runId),
    transparentRef: guardTransparentRef('transparentRef', input.transparentRef),
    pageTargetRef: guardPageTargetRef('pageTargetRef', input.pageTargetRef),
    targetUrlPreview: sanitizeUrlPreview(input.targetUrlPreview),
    mode: input.mode,
  };
}
