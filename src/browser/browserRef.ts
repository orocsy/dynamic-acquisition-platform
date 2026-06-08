import type { BrowserSessionRef } from '../runtime';
import type { BrowserSessionRefParts } from './types';

const BROWSER_REF_UNSAFE_PATTERN =
  /(?:^\/|^~\/|^[a-z]:[\\/]|[\\/]|[?&#=]|\b(?:cookie|authorization|bearer|set-cookie|profile|user-data-dir|password|secret|api[-_]?key|mfa|otp|captcha|websocket|devtools|chrome:\/\/|ws:\/\/|wss:\/\/|http:\/\/|https:\/\/)\b|(?:token|jwt|credential|private[-_]?key|csrf|xsrf))/i;

// Whitespace (the `\s` class, incl. NBSP and line breaks), C0/C1 control chars,
// and zero-width / bidi format chars. `\ufeff` (BOM/ZWNBSP) is already part of `\s`.
const REF_FORBIDDEN_CHAR_PATTERN = /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060]/;

export function isOpaqueBrowserRef(value: string): boolean {
  // Reject empty, ANY whitespace (internal or edge), control chars, and zero-width/
  // bidi format chars. The old check only compared `value === value.trim()`, which
  // catches EDGE whitespace only — so `daemon\t:d:session:r`, a newline-embedded
  // transparent ref, or a zero-width-split token slipped past every guard built on
  // this predicate (isOpaqueSurrogateSessionId, guardOpaqueRef, isSafeBrowserRefPart).
  if (value.length === 0) return false;
  if (REF_FORBIDDEN_CHAR_PATTERN.test(value)) return false;
  return !BROWSER_REF_UNSAFE_PATTERN.test(value);
}

/**
 * A *ref part* (daemonId, runId) is stricter than a whole opaque ref: it must
 * also be free of the structural delimiters `:` and whitespace that
 * `createBrowserSessionRef` uses to assemble the transparent
 * `daemon:<id>:session:<runId>` form. Without this, a colon-bearing part (e.g.
 * `daemonId = "a:b"`) could smuggle extra `daemon:`/`session:` segments into the
 * assembled ref and defeat `isTransparentSessionRef`'s structural check.
 */
const REF_PART_DELIMITER_PATTERN = /[:\s]/;

export function isSafeBrowserRefPart(value: string): boolean {
  return isOpaqueBrowserRef(value) && !REF_PART_DELIMITER_PATTERN.test(value);
}

function assertSafeBrowserRefPart(label: string, value: string): void {
  if (!isSafeBrowserRefPart(value)) {
    throw new Error(`${label} must be an opaque browser ref part (no ':' or whitespace)`);
  }
}

export function createBrowserSessionRef(parts: BrowserSessionRefParts): BrowserSessionRef | string {
  assertSafeBrowserRefPart('daemonId', parts.daemonId);
  assertSafeBrowserRefPart('runId', parts.runId);
  return `daemon:${parts.daemonId}:session:${parts.runId}` as BrowserSessionRef;
}

/**
 * The structurally-transparent session ref form produced by
 * `createBrowserSessionRef`: `daemon:<id>:session:<runId>`. Safe from secrets,
 * but it embeds the runId/daemon and is therefore cross-run linkable.
 *
 * The `<id>` segment is matched non-greedily and is allowed to contain colons,
 * so a malformed/smuggled `daemon:a:b:session:run` is still classified as
 * transparent (defends against the colon-in-part bypass even if a ref was built
 * outside `createBrowserSessionRef`).
 */
const TRANSPARENT_SESSION_REF_PATTERN = /^daemon:.+:session:.+/i;

export function isTransparentSessionRef(value: string): boolean {
  return TRANSPARENT_SESSION_REF_PATTERN.test(value.trim());
}

/**
 * A surrogate session id is one that may be persisted in a checkpoint: it must
 * be opaque (no secrets/paths/URLs), must not be the transparent
 * `daemon:...:session:...` form, and — belt and suspenders — must not carry the
 * `daemon:` prefix at all, so the runId/daemon cannot be read back out of
 * checkpoint data. This is stricter than `isOpaqueBrowserRef`, which allows the
 * transparent form.
 */
export function isOpaqueSurrogateSessionId(value: string): boolean {
  // Validate the raw value (no internal trim): `isOpaqueBrowserRef` now rejects a
  // padded value, so a `" session:x "` surrogate is rejected here too rather than
  // validated-trimmed and then persisted untrimmed.
  return isOpaqueBrowserRef(value) && !isTransparentSessionRef(value) && !/^daemon:/i.test(value);
}

/**
 * A *page target ref* is the opaque handle the Phase 3.3 `PageTargetController`
 * mints: `page:<opaque-id>`. It is strictly narrower than `isOpaqueBrowserRef`,
 * which accepts ANY non-secret string — including the transparent session ref
 * (`daemon:…:session:…`), the `session:` surrogate, and arbitrary tokens like
 * `not-a-page-ref`. Requiring the known `page:` prefix and a constrained id
 * charset means none of those can masquerade as a page target ref and be
 * persisted as one. This closes the 3.2 review hole where the persisted
 * `pageTargetRef` was only checked for opacity, never for shape: the `page:`
 * prefix alone excludes every `daemon:`/`session:` form, and the charset excludes
 * `/`, `?`, `#`, `=`, `@`, `:` (after the prefix) and whitespace; `isOpaqueBrowserRef`
 * additionally rejects an id that smuggles a keyword like `devtools`/`cookie`.
 */
const PAGE_TARGET_REF_PATTERN = /^page:[A-Za-z0-9_-]+$/;

export function isPageTargetRef(value: string): boolean {
  // Validate the raw value: the anchored pattern rejects surrounding whitespace,
  // and `isOpaqueBrowserRef` now also rejects it, so the ref a caller validates is
  // byte-for-byte the one that gets minted/persisted/keyed (no trim mismatch).
  return PAGE_TARGET_REF_PATTERN.test(value) && isOpaqueBrowserRef(value);
}
