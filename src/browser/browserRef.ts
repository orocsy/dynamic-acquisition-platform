import type { BrowserSessionRef } from '../runtime';
import type { BrowserSessionRefParts } from './types';

// STRUCTURAL endpoint/path/scheme/delimiter checks that disqualify ANY ref (part OR whole):
// an absolute/home/drive path, any slash/backslash, a query/fragment/matrix/`=` delimiter,
// an explicit URL scheme, or a GENERIC opaque `<scheme>:<non-slash>` (excluding the ref
// prefixes session:/page:/daemon: and the structural `X:session` colon). These catch a
// smuggled CDP socket / profile path / endpoint by STRUCTURE, not by wordlist.
const STRUCTURAL_REF_UNSAFE_PATTERN =
  /(?:^\/|^~\/|^[a-z]:[\\/]|[\\/]|[?&#=]|chrome:\/\/|ws:\/\/|wss:\/\/|http:\/\/|https:\/\/|(?<![a-z0-9])(?!(?:session|page|daemon):)[a-z][a-z0-9+.-]*:(?!(?:session|page|daemon)\b)[^\s/])/i;

// A CREDENTIAL marker WORD (alnum-bounded). Applied ONLY to a value that could be echoed as
// a standalone secret-bearing id (a surrogate session id; see isOpaqueSurrogateSessionId) --
// NOT to ref PARTS. A descriptive run/daemon id like `run_signature_check` or
// `run_sim_wrong_token_001` is a legitimate runtime identifier, not a secret, so rejecting
// it (the old behavior) was a functional regression. A keyword that is only a PREFIX of a
// longer word (tokenizer, jwtable, csrfDefense) is NOT matched.
const CREDENTIAL_KEYWORD_PATTERN =
  /(?<![a-z0-9])(?:cookie|authorization|bearer|set-cookie|profile|user-data-dir|password|passwd|pwd|secret|api[-_]?key|mfa|otp|captcha|websocket|devtools|token|jwt|credential|private[-_]?key|csrf|xsrf|pat|sig|signature|auth[-_]?code|session[-_]?id)(?![a-z0-9])/i;

function hasStructuralRefUnsafe(value: string, folded: string): boolean {
  return STRUCTURAL_REF_UNSAFE_PATTERN.test(value) || STRUCTURAL_REF_UNSAFE_PATTERN.test(folded);
}

// Insert a `_` separator at each lower->UPPER camelCase boundary so `accessToken_x` /
// `sessionApiKey` expose the marker word to the alnum-bounded keyword test (the lookbehind
// otherwise sees the preceding lowercase letter and skips it). `_` -- not a space -- so
// multi-part keywords (`api[-_]?key`) still match across the inserted boundary. Applied as
// an EXTRA view; the raw/folded views still catch everything they caught before.
function splitCamelBoundaries(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
}

function hasCredentialKeyword(value: string, folded: string): boolean {
  return (
    CREDENTIAL_KEYWORD_PATTERN.test(value) ||
    CREDENTIAL_KEYWORD_PATTERN.test(folded) ||
    CREDENTIAL_KEYWORD_PATTERN.test(splitCamelBoundaries(value)) ||
    CREDENTIAL_KEYWORD_PATTERN.test(splitCamelBoundaries(folded))
  );
}

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
  // A whole opaque ref must clear BOTH the structural checks AND the credential-keyword
  // denylist (the latter so a secret-looking surrogate session id is not echoed verbatim).
  return !hasStructuralRefUnsafe(value, folded) && !hasCredentialKeyword(value, folded);
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
  // STRUCTURAL-only (NO credential-keyword denylist): a ref part (daemonId/runId) is a
  // runtime identifier that may legitimately contain a descriptive marker WORD
  // (`run_signature_check`, `run_token_refresh_001`). It is assembled only into the
  // transparent `daemon:…:session:…` ref, which is itself redacted in any echo (the
  // `daemon:` surrogate check), so a marker word in a part never surfaces as a standalone
  // secret. The structural checks still reject a part smuggling a path/URL/scheme/delimiter,
  // and REF_PART_DELIMITER_PATTERN additionally forbids the `:`/whitespace used to assemble
  // the transparent form.
  if (value.length === 0) return false;
  if (REF_FORBIDDEN_CHAR_PATTERN.test(value)) return false;
  if (REF_PART_DELIMITER_PATTERN.test(value)) return false;
  const folded = value.normalize('NFKD').replace(/\p{M}/gu, '');
  return !hasStructuralRefUnsafe(value, folded);
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
