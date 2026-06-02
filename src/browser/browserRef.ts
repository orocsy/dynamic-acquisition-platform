import type { BrowserSessionRef } from '../runtime';
import type { BrowserSessionRefParts } from './types';

const BROWSER_REF_UNSAFE_PATTERN =
  /(?:^\/|^~\/|^[a-z]:[\\/]|[\\/]|[?&#=]|\b(?:cookie|authorization|bearer|set-cookie|profile|user-data-dir|password|secret|api[-_]?key|mfa|otp|captcha|websocket|devtools|chrome:\/\/|ws:\/\/|wss:\/\/|http:\/\/|https:\/\/)\b)/i;

export function isOpaqueBrowserRef(value: string): boolean {
  // Canonical only. The old check trimmed for the length test but matched the
  // unsafe pattern on the raw value, so `" page:x "` validated as opaque while the
  // *untrimmed* value was what got minted, persisted, and used as a map key —
  // a validate-trimmed / store-untrimmed mismatch (a padded ref became an
  // unreachable target). Surrounding whitespace in an opaque machine ref is always
  // a bug, so reject it outright rather than silently tolerate it.
  return value.length > 0 && value === value.trim() && !BROWSER_REF_UNSAFE_PATTERN.test(value);
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
