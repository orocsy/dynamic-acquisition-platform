import type { BrowserSessionRef } from '../runtime';
import type { BrowserSessionRefParts } from './types';

// Reject any ref embedding a secret, path, or endpoint. Secret keywords are matched
// with alphanumeric boundaries (lookarounds): an adjacent _ - : or the string end is a
// separator, so a delimited marker (otp_SECRET / access_token_x / pat_ / github_pat_)
// is caught, while a keyword that is only a PREFIX of a longer word (tokenizer,
// jwtable, csrfDefense, path, compatible) is NOT -- those are legitimate run/daemon/page
// ids carrying no secret value. URL schemes carry slashes, already caught above.
const BROWSER_REF_UNSAFE_PATTERN =
  /(?:^\/|^~\/|^[a-z]:[\\/]|[\\/]|[?&#=]|chrome:\/\/|ws:\/\/|wss:\/\/|http:\/\/|https:\/\/|(?<![a-z0-9])(?:cookie|authorization|bearer|set-cookie|profile|user-data-dir|password|passwd|pwd|secret|api[-_]?key|mfa|otp|captcha|websocket|devtools|token|jwt|credential|private[-_]?key|csrf|xsrf|pat|sig|signature|auth[-_]?code|session[-_]?id)(?![a-z0-9]))/i;

// Forbidden code points in any opaque ref: ALL whitespace (the \s class,
// incl. NBSP and line breaks), ALL control chars (Unicode category Cc -- C0,
// DEL, C1), and ALL invisible format / default-ignorable chars (categories Cf
// and Default_Ignorable_Code_Point -- zero-width spaces, bidi marks/overrides/
// isolates, joiners, the Arabic letter mark U+061C, soft hyphen, variation
// selectors, BOM). Using Unicode property classes instead of an enumerated
// list closes the recurring "one more smuggling code point" gap by construction:
// every present and future format character is covered, not just listed ones.
const REF_FORBIDDEN_CHAR_PATTERN = /[\s\p{Cc}\p{Cf}\p{M}\p{Default_Ignorable_Code_Point}]/u;

export function isOpaqueBrowserRef(value: string): boolean {
  // Reject empty, ANY whitespace (internal or edge), control chars, and zero-width/
  // bidi format chars. The old check only compared `value === value.trim()`, which
  // catches EDGE whitespace only — so `daemon\t:d:session:r`, a newline-embedded
  // transparent ref, or a zero-width-split token slipped past every guard built on
  // this predicate (isOpaqueSurrogateSessionId, guardOpaqueRef, isSafeBrowserRefPart).
  if (value.length === 0) return false;
  if (REF_FORBIDDEN_CHAR_PATTERN.test(value)) return false;
  // Test a folded view too: NFKD decomposes full-width / ligature / accented forms
  // to base ASCII, and stripping combining marks (\p{M}) collapses `to<mark>ken` and
  // a precomposed `se<accent>ret` back to the keyword. So neither a full-width form
  // nor a combining-mark split can smuggle a secret past the denylist. (The raw
  // forbidden-char check above already rejects a standalone mark / invisible.)
  const folded = value.normalize('NFKD').replace(/\p{M}/gu, '');
  return !BROWSER_REF_UNSAFE_PATTERN.test(value) && !BROWSER_REF_UNSAFE_PATTERN.test(folded);
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
