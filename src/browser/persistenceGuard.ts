import { isOpaqueBrowserRef, isOpaqueSurrogateSessionId, isPageTargetRef, isSafeBrowserRefPart } from './browserRef';
import { isLoopbackHost } from './daemonClient';
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
  // Convert ONCE and validate/return that exact snapshot (same discipline as
  // guardPageTargetRef): the predicate's regex tests would otherwise coerce a caller
  // object repeatedly, letting a stateful toString() pass validation as one ref and be
  // consumed downstream as another.
  const canonical = String(value);
  if (!isOpaqueSurrogateSessionId(canonical)) {
    throw new BrowserPersistenceError(
      field,
      'must be an opaque surrogate (not the transparent daemon:...:session:... form, no secrets/paths)',
    );
  }
  return canonical;
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
  // Convert ONCE and return that exact snapshot: a JS caller can pass an object whose
  // stateful toString() yields a valid ref during validation and a different one afterwards,
  // so validating one conversion and returning a second would bless a never-validated ref.
  const canonical = String(value);
  if (!isPageTargetRef(canonical)) {
    throw new BrowserPersistenceError(
      field,
      'must be a page target ref (page:<opaque-id>; not a session/transparent ref, ws/devtools URL, or profile path)',
    );
  }
  return canonical;
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
 * form `daemon:<daemonId>:session:<runId>`, but each part must be a colon-free
 * safe ref part.
 *
 * Anything in the `daemon:` namespace is ALWAYS validated as the transparent form
 * — it must NOT short-circuit on `isOpaqueBrowserRef`, which permits colons. That
 * short-circuit (added in an earlier round to let the ws:// case fall through to
 * segment checks) let colon-smuggled/extra-segment refs bypass validation
 * entirely: `daemon:a:b:session:run` (daemonId `a:b`), `daemon:…:session:run:extra`
 * (tail), `daemon:ws://…/devtools/…:session:run`. `[^:]+` forbids extra `:`
 * segments structurally; `isSafeBrowserRefPart` adds the opaque / no-`/` /
 * no-keyword / no-whitespace checks. Only a NON-`daemon:` value may use the plain
 * opaque-ref fallback.
 */
export function guardTransparentRef(field: string, value: string): string {
  if (/^daemon:/i.test(value)) {
    const match = /^daemon:([^:]+):session:([^:]+)$/i.exec(value);
    if (match && isSafeBrowserRefPart(match[1]) && isSafeBrowserRefPart(match[2])) {
      return value;
    }
    throw new BrowserPersistenceError(
      field,
      'must be a clean transparent session ref: daemon:<part>:session:<part> with colon-free opaque parts',
    );
  }
  if (isOpaqueBrowserRef(value)) return value;
  throw new BrowserPersistenceError(field, 'must be a clean transparent session ref or opaque ref');
}

/**
 * SANITIZE: a URL *preview*. Query, fragment, and userinfo are stripped so a
 * secret in the URL is never persisted. Only http/https previews are kept: a
 * non-web scheme (`ws`/`wss`/`chrome`/`devtools`/`file`/`data`/…) is not a page URL
 * but a raw endpoint/path (a CDP debugger socket, a profile/file path) that must
 * not land in a checkpoint, so it is dropped (returns `undefined`) rather than
 * persisted with only its query stripped. Query, fragment, AND path parameters
 * (`;jsessionid=…`) are removed; relative/non-URL strings are truncated at the first
 * query/fragment/path-parameter delimiter.
 */
export function sanitizeUrlPreview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    // A loopback host is the local daemon / a CDP debugger endpoint (`/devtools/...`,
    // `/json/...`) / an SSRF target, never a public page -> drop it. `new URL` canonicalizes
    // octal/decimal/IPv6 spellings (`0177.0.0.1`, `2130706433`, `[::1]`), so `isLoopbackHost`
    // catches every encoding with no path regex or percent-decode to get wrong.
    if (isLoopbackHost(parsed.hostname)) {
      return undefined;
    }
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    // Strip RFC-3986 path parameters AND any percent-encoded query/fragment/param delimiter
    // (`%3B`=`;`, `%26`=`&`, `%3F`=`?`, `%23`=`#`) a server decodes before reading: they live
    // in `pathname`, not `search`, so a `;jsessionid=`/`%3Fcode=` redirect URL would
    // otherwise persist a live session id or auth code in a checkpoint preview.
    // `%3a` included: an encoded colon in an ABSOLUTE path re-opens the smuggle once a
    // consumer decodes it (`https://app.example.com/http%3a//127.0.0.1%3a9222/...`).
    parsed.pathname = parsed.pathname.split(/[;&]|%3b|%26|%3f|%23|%3a/i)[0];
    return parsed.toString();
  } catch {
    // Not an absolute URL. Keep ONLY a clean relative path (single leading slash,
    // printable ASCII, query stripped). Drop everything else: a scheme-relative
    // `//host`, OR a whitespace/tab/control/zero-width-smuggled form that a URL
    // parser normalizes to `//host` (e.g. `/<tab>/127.0.0.1:9222/devtools/...`,
    // `<NUL>//host`, `<ZWSP>//host`) — all can carry a raw host:port endpoint and
    // are not explicit http(s) URLs. A `startsWith('//')` test misses every smuggled
    // variant, so allow-list the safe shape instead of deny-listing.
    // A relative path with a percent-encoded query/fragment/param/colon delimiter (`%3B`/
    // `%26`/`%3F`/`%23`/`%3A`) would persist a secret a consumer decodes -> drop it.
    if (/%(?:3[abf]|26|23)/i.test(value)) return undefined;
    const path = value.split(/[?#;&]/, 1)[0];
    // No `:` (0x3a) in a relative preview: a colon lets a whole absolute URL hide inside it
    // (`/http://127.0.0.1:9222/...`), same class as browserObservation's CLEAN_RELATIVE_PATH.
    return /^\/(?!\/)[\x21-\x22\x24-\x25\x27-\x39\x3c-\x3e\x40-\x5b\x5d-\x7e]*$/.test(path) ? path : undefined;
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
