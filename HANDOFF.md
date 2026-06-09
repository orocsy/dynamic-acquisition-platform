# Handoff — Phase 3.3 complete (hardening + codex + adversarial review applied), ready for 3.4

Snapshot for picking this up in a fresh session (e.g. Claude Code). Read this
first, then `docs/phase3-low-level-design.md` for the slice you're building.

## What this project is

A TypeScript/Node **library** (not a web app) for browser-assisted content
acquisition. A `RuntimeCoordinator` (Phase 2) owns run lifecycle via optimistic
concurrency; Phase 3 connects it to a dedicated local Chrome daemon over **raw
CDP** without letting browser details own platform state. No deps beyond
`typescript` + `@types/node`. Tests run on `node --test` against `dist/`.

Commands: `npm run typecheck`, `npm test` (builds then tests), `npm run check`
(typecheck + contract sample validation). All three must pass before any slice
is "done".

## Current state

- **Phase 3.1** (browser contracts, opaque refs) — done.
- **Phase 3.2** (daemon health/start boundary) — done.
- **Phase 3.3** (page target lifecycle) — **done this session.**
- **Phase 3.4+** — not started. `docs/phase3-low-level-design.md` specs them.

`git` works but `git diff` errors with `mmap failed: Resource deadlock avoided`
(a FUSE-mount quirk, not a repo problem). Review via direct file reads, or try
`git -c core.preloadindex=false diff`. Remote: `github.com/orocsy/dynamic-acquisition-platform`.

Tests: **197 pass / 0 fail.** Browser layer is `src/browser/*` with 7
`test/browser-*.js` files. An independent abuse probe (run outside the suite,
per the gate below) is green this session.

## What was built in 3.2

In `src/browser/`:

- `daemonClient.ts` — `BrowserDaemonClient` interface + real `ChromeDaemonClient`
  (CDP `/json/version` health check over `fetch`). `safeDaemonOrigin` strips
  userinfo/path/query and **requires a loopback host**; `healthUrlPreview` is
  origin-only and never leaks the `webSocketDebuggerUrl`. `startIfMissing` is
  **not implemented** — it returns `daemon-start-failed` (launch needs a startup
  adapter, deferred).
- `fakeDaemonClient.ts` — `FakeBrowserDaemonClient`, deterministic, failure
  injection, no network/Chrome. Mirrors the real client's contract.
- `daemonErrors.ts` — `BrowserDaemonError` + failure-code union.
- `browserSessionRegistry.ts` — opaque `session:<uuid>` surrogate persisted in
  checkpoints; maps to `{ daemonId, runId, pageTargetRef, targetUrlPreview }`.
  Interface, so a durable impl can replace the in-memory one. **In-memory only ⇒
  same-process resume only** (documented in the module header).
- `persistenceGuard.ts` — see below.

## The persistence guard (read this before touching the registry)

Seven review rounds found the **same defect class**: a browser value that bypassed
a guard the author had already written (header values → `targetUrlPreview` →
`pageTargetRef` presence → its *shape* + controller error/diagnostic echo →
*whitespace* canonicalization + bare-credential diagnostics → the **transparent-ref
fallback regex, the registry's unsafe-id error echo, and `sanitizeUrlPreview`'s
scheme handling**). The consolidation fix:

`src/browser/persistenceGuard.ts` is now the single place that classifies every
persisted browser value. The registry **cannot** build a stored record except
via `toPersistableSessionRecord(...)`, which routes every field through its
contract. Adding a field to the persisted record without classifying it there is
a **TypeScript error**, not a silent leak.

Two deliberate disposals (do not unify them):

- **REJECT (throw `BrowserPersistenceError`)** — operational handles that must be
  correct or absent: `sessionId` (opaque surrogate, no `daemon:…:session:…`
  form), `pageTargetRef` (via `guardPageTargetRef`: the strict `page:<id>` shape,
  **not merely "opaque"** — a session ref or arbitrary token is rejected), ref
  parts `daemonId`/`runId` (no `:` or whitespace).
- **SANITIZE (rewrite)** — lossy previews: `targetUrlPreview` (strip
  query/fragment/userinfo).

Rationale: redacting an operational handle would hand back an unusable value and
hide the caller's bug; a preview is informational so dropping secrets is fine.

**Rule for any new persisted browser field:** add it to
`PersistableSessionFields` and classify it in `toPersistableSessionRecord`. Don't
re-validate field-by-field at call sites.

## What was built in 3.3

Page target lifecycle — `src/browser/`:

- `pageTargetController.ts` — the `PageTargetController` contract (`createTarget /
  getTarget / navigate / markStale / closeTarget`) and the `created → navigating →
  ready → stale → closed` state machine. Every state change funnels through one
  `PageTargetStore`, which asserts the transition table **before** mutating, so an
  illegal transition throws a structured `PageTargetError` and leaves the record
  untouched. It never calls the coordinator: 3.3 produces refs/snapshots that
  *later* slices feed to the runtime; it does not mutate checkpoints.
- `mintPageTargetRef` mints `page:<uuid>` refs and validates the **`page:` shape**
  (`isPageTargetRef`, not just opacity) at the source, so a ref reaching the
  registry passes `guardPageTargetRef`. A rogue factory output (ws/devtools URL,
  profile path, session ref) is rejected at `createTarget`, never echoed. At the
  **public boundary** (`normalizeIncomingRef`), an unsafe caller-supplied ref to
  navigate/markStale/closeTarget is rejected as `unsafe-target-ref` with no echo,
  and every `PageTargetError` routes its ref through `refForError` (defense in
  depth). `ChromePageTargetController.createTarget` reserves the ref **before** the
  CDP create, so a duplicate ref can't open a second raw target or rebind the map.
- `navigationPolicy.ts` — timeout (default + clamp), allowed wait modes, retry
  default, the Phase-3.6 safe-restart predicate, and the canonical nav URL
  sanitizer (delegates to the persistence guard's `sanitizeUrlPreview` — no fourth
  copy of URL-stripping).
- `pageTargetErrors.ts` — `PageTargetError` + code union (`unknown-target |
  invalid-transition | target-stale | target-closed | unsafe-target-ref |
  transport-unavailable`).
- `fakePageTargetController.ts` — `FakePageTargetController`: deterministic, no
  Chrome, injectable navigation planner (script success / auth redirect /
  failure). This is the controller that drives the later 3.4+ adapter tests.
- `ChromePageTargetController` — the real controller behind the same interface.
  Reuses the base state machine + ref discipline; only the CDP wire calls sit
  behind an injected `CdpTargetTransport`. The shipped
  `NotImplementedCdpTargetTransport` fails with `transport-unavailable` — the real
  websocket session is **deferred**, exactly as 3.2 deferred daemon launch. A raw
  CDP `rawTargetId` is mapped to the opaque ref internally and never surfaces in a
  snapshot, result, or persisted field.

Cleanup done alongside 3.3: removed three speculative, unused types from
`browser/types.ts` (`BrowserNavigationResult`, `BrowserAuthBoundarySignal`,
`BrowserRuntimeDiagnostic`). Two conflicted with their real LLD specs;
`BrowserNavigationResult` is now defined by its owning slice in
`pageTargetController.ts` (LLD §6.3), and the auth signal belongs to 3.5.
`BrowserTargetState` stays in `types.ts` as the shared state enum.

**Review round 5 (this session) closed four holes** a fresh adversarial pass
found — all the same "passes its own test, leaks through the gap" class the probe
exists to catch:
1. an unsafe caller-supplied `pageTargetRef` was echoed back in the error →
   rejected without echo at the boundary + `refForError` everywhere;
2. navigation diagnostics leaked secrets in *embedded* URLs and userinfo →
   `browserRedaction` now scrubs URLs anywhere in a string and strips `user:pass`
   (and `sanitizeBrowserUrl` strips userinfo);
3. persisted `pageTargetRef` only checked opacity, not the `page:` shape → new
   `guardPageTargetRef` / `isPageTargetRef`;
4. the real controller created the CDP target before reserving the ref, so a
   duplicate ref corrupted the raw-target map → reserve-before-create with rollback.

**Review round 6 (this session) closed three more**, same class:
1. free-form diagnostic strings still leaked **bare** credentials (`bearer X`,
   `token=Y`, multi-token `cookie: …`) that aren't URLs and aren't under a
   sensitive key → `browserRedaction` now scrubs URLs surgically, then redacts a
   diagnostic string **wholesale** if a credential assignment/auth-scheme survives
   (a bare marker *mention* like "token refresh scheduled" is kept);
2. ref predicates validated `value.trim()` but mint/persist/lookup used the
   **untrimmed** value, so `" page:space "` validated yet became an unreachable
   target → `isOpaqueBrowserRef` is now canonical-only (`value === value.trim()`),
   and `isPageTargetRef`/`isOpaqueSurrogateSessionId` validate the raw value (this
   also closes the parallel `sessionId` hole, not just `pageTargetRef`);
3. a stale `guardOpaqueRef` mention in `pageTargetController.ts`'s header comment →
   corrected to `guardPageTargetRef` (the README/HANDOFF were already fixed).

**Review round 7 (this session) closed three persistence-layer leaks** — the same
class, in the guards I had *not* adversarially probed (I'd hardened `pageTargetRef`
+ diagnostics, not these). All three reproduced against the live `dist/browser`:
1. `guardTransparentRef`'s fallback `^daemon:[^\s]+:session:[^\s]+$` let `[^\s]+`
   swallow a whole `ws://…/devtools/…` URL between the delimiters →
   `daemon:ws://…/devtools/…:session:run` persisted. **(Round 8 follow-up:** the
   round-7 fix added an `isOpaqueBrowserRef` short-circuit that still let
   colon-smuggled parts `daemon:a:b:session:run` and extra tails
   `daemon:…:session:run:extra` bypass. Final form: any `daemon:`-prefixed value is
   ALWAYS validated as `daemon:[^:]+:session:[^:]+` with `isSafeBrowserRefPart`
   parts — the opaque fallback applies only to non-`daemon:` values.**)**;
2. `InMemoryBrowserSessionRegistry.update()` echoed a caller's unsafe `sessionId`
   (a raw `ws://…?token=…`) in its "not found" error → now redacted via
   `sessionIdForError` (safe surrogates still named);
3. `sanitizeUrlPreview` stripped the query but kept the scheme, so `ws`/`wss`/
   `chrome`/`devtools` survived as a persisted `targetUrlPreview` → now only
   http/https previews are kept; other schemes are dropped.
The whole guard/echo surface of the persistence layer was then swept by probe
(transparent ref, surrogate id, page ref, ref parts, url preview, registry
update/register/get) — all green.

**Review rounds 8-9 (this session) -- codex auto-review (PR #1) + a fresh
adversarial pass, all the same denylist-drift / smuggle class:**

Codex flagged two enumerated-denylist gaps: (a) the ref denylist omitted `pat`, so a
`session:pat_...` surrogate was echoed on a registry miss -> added
`pat`/`passwd`/`pwd`/`signature`; (b) the redaction denylist view stripped only a
hand-listed set of zero-width chars and missed U+061C (Arabic Letter Mark) -> BOTH
the ref forbidden-char check and the redaction view now use Unicode property classes
(categories Cc, Cf, and Default_Ignorable_Code_Point), so every present/future format
char is covered by construction, not by enumeration.

Six independent adversarial passes then found eleven more, all fixed + regression-tested. Pass 1 found four:
1. `keyword_<secret>` defeated the word-boundary group (`_` is a word char, so
   `otp_X` had no trailing boundary, was classed opaque, persisted, and echoed) ->
   the secret words now use alnum-boundary lookarounds that treat `_`/`-`/`:` as
   separators;
2. `isOpaqueBrowserRef` did not NFKC-fold, so a full-width keyword passed as opaque
   -> it now tests an NFKC-folded view too;
3. a relative path containing a backslash (which `new URL` reinterprets into a
   `//host` authority) slipped past the relative AND absolute URL allow-lists -> the
   backslash byte (0x5c) is now excluded from both;
4. `assertSafeBrowserObservation` validated only header previews -> it now also
   validates `request.url` and `pageTargetRef`, folding in the round-8 Finding-2 item
   that had been deferred to 3.4.
Pass 2 then found two deeper denylist-evasion siblings:
5. a combining mark between keyword letters (`to<mark>ken`, or a precomposed accented
   `secret`) -- the views stripped format / zero-width chars but not Unicode Marks, and
   NFKC recomposes accents rather than dropping them -> the ref forbidden-char check now
   includes `\p{M}`, and both the ref check and the redaction view fold via NFKD then
   strip `\p{M}` (a shared `foldForDenylist`);
6. `PROFILE_LIKE_VALUE_PATTERN` (devtools / chrome:// / user-data-dir / profile paths)
   was tested on the raw value only -> now tested on the NFKD-folded view too, so a
   full-width endpoint / path keyword can't survive verbatim.
Pass 3 found a symmetric gap:
7. `shouldRedactKey` folded the diagnostic VALUE but not the KEY name, so a sensitive
   key disguised full-width / accented (`authorization`, `cookie`) dodged redaction and
   a keyword-free secret value under it leaked -> the key name is now folded too (the
   same `foldForDenylist` the value side uses).
Pass 4 found a construction-vs-invariant asymmetry:
8. the `assertSafeBrowserObservation` invariant's relative-path allow-list admitted
   `?`/`#` (they sit in the printable-ASCII range), so a query/fragment-bearing relative
   `request.url` / redirect (a keyword-free OAuth `code` / CAS `ticket`) passed the
   prebuilt-observation gate even though construction strips it -> the relative allow-list
   now excludes `?`/`#`, symmetric with the absolute one.
Pass 5 found a URL-component gap and a false-reject:
9. URL sanitization stripped `?query`/`#fragment` but NOT RFC-3986 path parameters
   (`;jsessionid=…`) — they live in `pathname`, so a Java/Spring post-redirect URL would
   persist a live session id in `targetUrlPreview` -> both sanitizers now strip `;`/`&`
   path params (absolute `pathname` split + relative `[?#;&]` split), and both allow-lists
   exclude `;`/`&` so the invariant rejects a prebuilt one.
10. `assertHeaderPreviewSafe` ran the sensitive-substring check BEFORE the URL-bearing
    check, so a legitimately-sanitized Location whose path merely contains
    `session`/`secret`/`token` as a segment (e.g. `/api/v2/sessions`) was falsely rejected
    by its own gate -> URL-bearing headers are validated by `isSanitizedUrlField` first now.
Pass 6 found the same path-param gap in the THIRD URL sanitizer:
11. `sanitizeBrowserUrl` (the diagnostics-path sanitizer in `browserRedaction.ts`) was
    missed by the round-5 fix — it stripped query/fragment/userinfo but kept
    `;jsessionid=` path params, so a redirect session id surfaced verbatim through
    persisted navigation diagnostics -> it now strips path params too (try-branch
    `pathname` split + the two relative `[?#;&]` splits), matching its siblings.
There are exactly THREE URL sanitizers (`sanitizeUrlPreview`, `sanitizeHeaderUrlValue`,
`sanitizeBrowserUrl`) plus two origin-only `daemonClient` parsers (no path); all are now
enumerated and consistent. Every RFC-3986 secret-carrying URL component (scheme,
userinfo, query, fragment, path-params) is stripped; host + path segments are the
intentional preview. Percent-encoded delimiters stay opaque path segments (by design,
and consistent construction-vs-invariant). The browser ref/redaction/persistence/
observation guard surface was re-swept by each independent probe. A SEVENTH independent
pass returned CLEAN (no secret-leak — converged) and confirmed the URL-sanitizer class
is closed by enumeration; one trivial in-intent follow-up was applied (PROFILE_LIKE now
also redacts `file://` local paths in diagnostics, alongside `chrome://`/`ws://`/`devtools`).
Codex re-review of the pushed commit then flagged a false-positive (the secret-keyword
group was substring-matched, so legit ids like `run_tokenizer_eval`/`run_jwtable`/
`run_csrfDefense` were rejected and failed session registration) -> the two keyword
groups are merged into ONE alnum-bounded group: a keyword that is only a PREFIX of a
longer word is accepted, a separator-delimited marker (`access_token_x`, `pat_`) is still
rejected. A SECOND codex re-review (of the merged-keyword commit) then flagged five more,
all fixed: (a) `CLEAN_ABSOLUTE_URL` forbade `@` everywhere, false-rejecting a legit path
`@` (`/@scope/pkg`) -> authority/path split, `@` allowed only in the path; (b)
`SENSITIVE_KEY_PATTERN` drifted behind the credential names, so a bare secret under a
`jwt`/`pat`/`csrf`/`private_key`/`auth_code` KEY leaked -> key pattern re-synced; (c)
`ABSOLUTE_URL_PATTERN` missed opaque schemes (`data:`/`javascript:`/`chrome-extension:`,
no `//`) in diagnostic prose -> matched and dropped via `sanitizeBrowserUrl`; (d) the
path-param strip ran only whole-string, missing a relative URL embedded in prose
(`/account;jsessionid=…`) -> stripped globally; (e) the ref denylist omitted
`auth_code`/`session_id` (which the value side flags) -> added. A THIRD codex re-review
then found three more in the diagnostic-string sanitizer: (a) the opaque-scheme matcher
truncated at `<>` and missed `mailto:`, leaving partial payloads -> opaque schemes
(`data:`/`javascript:`/`mailto:`/`blob:`/`chrome-extension:`/`file:`) are now redacted
wholesale via `OPAQUE_URL_SCHEME_PATTERN`; (b) my path-param strip mutated `out` before
the whole-string `//host` redaction, leaking the raw endpoint (a regression) -> the
`//host` check runs BEFORE the strip; (c) `pat` in the value-side credential pattern used
`\b`, missing `github_pat=` -> separator-bounded like the ref/key denylists.
A FOURTH codex re-review found three more (two the embedded-in-prose counterparts of the
above): (a) embedded `//host` endpoints in prose were not redacted (only whole-string) ->
the `//host` drop now runs globally (`(^|\s)//host`, leaving `http://` and `// comment`);
(b) an embedded relative URL's `?`/`#` query/fragment was not stripped (only `;`/`&`) ->
the relative-token strip now covers `[?#;&]` globally; (c) the ref denylist omitted the
short `sig` marker -> added (alnum-bounded, so `design`/`signal`/`assign` are not false
positives). The whole-string `wholeString` special-casing was removed — relative URLs are
now handled identically whether whole-string or embedded. Tests: 180 pass / 0 fail.

**After four codex re-review rounds all landing in the one free-form diagnostic-string
sanitizer (a whack-a-mole — in-place sanitizing of arbitrary prose is a long tail of URL
shapes), `sanitizeStringForDiagnostics` was REDESIGNED (operator decision) to be
aggressive instead of surgical:** if a diagnostic value contains ANY URL/endpoint token
(`scheme://`, a scheme-relative `//host`, or a relative path with a `?`/`#`/`;`/`&`
delimiter — `RISKY_DIAGNOSTIC_PATTERN`), an opaque scheme (`OPAQUE_URL_SCHEME_PATTERN`),
or a credential assignment / auth-scheme value (`CREDENTIAL_ASSIGNMENT_PATTERN` on the
NFKD-folded view), the WHOLE string is redacted to `[redacted]`. A bare path (a route
like `/api/users`, no delimiter) and plain prose are kept. This trades diagnostic context
for a guarantee that no secret can ever surface — diagnostics are debug context, not a
data channel. The in-place helpers (`sanitizeBrowserUrl`, `ABSOLUTE_URL_PATTERN`) were
deleted. This ends the diagnostic-sanitizer edge-case hunt by construction. (The persisted
checkpoint data — refs, `targetUrlPreview`, observation invariant — is unchanged and stays
the precise, enumeration-verified path; only the lossy *diagnostic* layer went aggressive.)

**The aggressive redesign ended the in-place diagnostic hunt, but a FIFTH codex re-review
then surfaced nine genuine gaps in OTHER files (pre-existing, not diagnostic-sanitizer):**
(1) HTTP CDP debugger endpoints (`http://127.0.0.1:9222/devtools/browser/<id>`, `/json/version`)
passed the http(s) gate in `sanitizeUrlPreview` + `sanitizeHeaderUrlValue` + the observation
invariant -> a `CDP_ENDPOINT_URL` regex now drops `/devtools/<…>` and the `/json` discovery
paths even over http(s) (narrow: a legit public `/json/users` API URL is still kept, which
Phase 3.4 capture needs); (2) percent-encoded matrix delimiters (`%3Bjsessionid=`) survived
the raw `[;&]` split -> the split + invariant now also reject `%3b`/`%26`; (3) opaque
slash-less URL schemes (`javascript:`/`mailto:`/`data:`…) bypassed the slash-assuming ref
denylist (`session:javascript:alert(…)` echoed) -> added to `BROWSER_REF_UNSAFE_PATTERN`;
(4) compound credential names (`csrf_token=`, `github_jwt=`) used `\b` (misses `_`) ->
`CREDENTIAL_ASSIGNMENT_PATTERN` now alnum-bounds all keywords; (5) URLs after
punctuation/quote/bracket (`(/oauth?code=`, `{"next":"/sso?…"`) escaped the
whitespace-anchored `RISKY_DIAGNOSTIC_PATTERN` -> it now uses `(?<![a-z0-9])` boundaries.

**A SIXTH codex re-review refined the round-5 fixes (five findings):** (1) the CDP-endpoint
regex ignored the host and wrongly redacted a PUBLIC `/json/version` -> scoped to a LOOPBACK
host (`isLoopbackHost`, exported from `daemonClient`) so public `/json|/devtools` URLs are
kept; (2) the opaque-scheme diagnostic check was raw-only (a zero-width char in the scheme
name dodged it) -> it now folds via `foldForDenylist` first; (3) the ref denylist enumerated
only a few opaque schemes -> a GENERIC `<scheme>:<non-slash>` detector (excluding the ref
prefixes `session:`/`page:`/`daemon:` AND the structural `X:session`/`X:page`/`X:daemon`
colon, so a transparent ref stays opaque); (4) the CDP path was matched raw (`%64evtools`
bypassed) -> a `safeDecodePath` percent-decodes (a few rounds) before matching; (5) encoded
query/fragment delimiters (`%3F`/`%23`) survived -> the preview split + invariant now reject
`%3b`/`%26`/`%3f`/`%23`. Tests: 188 pass / 0 fail.

**A SEVENTH codex re-review found five MORE narrow URL-encoding/host-spelling edge cases
(octal/decimal loopback `0177.0.0.1`/`2130706433`, malformed `%ZZ` escapes, encoded `%3F`
in relative paths), so the URL-preview sanitizers were REDESIGNED to converge by
construction (operator-authorized), mirroring the diagnostic redesign:** the fragile
CDP-path regex + percent-decoder were DELETED. Instead `sanitizeUrlPreview` /
`sanitizeHeaderUrlValue` / the `isSanitizedUrlField` invariant now (a) reject ANY loopback
host outright -- a loopback URL is the local daemon / a CDP debugger endpoint / an SSRF
target, never a public page, and `new URL` canonicalizes every host spelling
(octal/decimal/IPv6) so `isLoopbackHost(parsed.hostname)` catches them all with no path
regex or decode to get wrong; and (b) reject any percent-encoded query/fragment/param
delimiter (`%3B`/`%26`/`%3F`/`%23`). The invariant now PARSES the value (not a raw host
regex) to get the canonicalized host. The diagnostic `RISKY_DIAGNOSTIC_PATTERN` also gained
the encoded-delimiter forms. This removes the host-spelling / percent-decode edge-case
surface entirely. Tests: 191 pass / 0 fail.

**An EIGHTH codex re-review found three DISTINCT (not encoding-tail) findings, all fixed:**
(1) `shouldRedactKey` exempted any key ending in `ref`, so a snake_case credential key
`jwt_ref`/`pat_ref` leaked its value -> `BROWSER_REF_KEY_PATTERN` narrowed to a camelCase
`…Ref`/`…Id` suffix (case-sensitive), so snake `_ref` credential keys fall through to the
SENSITIVE check while legit `browserSessionRef`/`daemonId` stay exempt; (2) a slashless
special-scheme URL (`http:example.com/cb?code=…`, which `new URL` still parses as absolute)
escaped the `://`-only `RISKY_DIAGNOSTIC_PATTERN` -> added a `(?<![a-z0-9])(?:https?|ftp|wss?):`
alternative; (3) an IPv4-mapped IPv6 loopback (`[::ffff:127.0.0.1]` -> canonicalized
`::ffff:7f00:1`) wasn't recognized -> `isLoopbackHost` now matches `::ffff:127.x` and
`::ffff:7fxx:` forms. Tests: 194 pass / 0 fail.

**A NINTH codex re-review found three refinements of the round-8 fixes (findings trend
9->5->5->3->3->3, converging):** (1) a bare `sig` key was missing from the key denylist ->
added `(?<![a-z0-9])sig(?![a-z0-9])` (bounded, so `design`/`signal` aren't false positives);
(2) the camelCase `*Ref`/`*Id` ref-key exemption still exempted credential-marker keys like
`sessionId`/`jwtRef`/`authorizationId` -> `BROWSER_REF_KEY_PATTERN` is now an EXACT
known-handle allow-list (`^(?:browserSessionRef|pageTargetRef|browserDaemonRef|
browserObservationId|daemonId|targetRef)$`), so anything else falls through to the sensitive
check; (3) the IPv4-mapped hex loopback match `7f[0-9a-f]{0,2}` wrongly accepted `::ffff:7f1:1`
(= 7.241.0.1) -> tightened to `7f[0-9a-f]{2}` (exactly `0x7f00`-`0x7fff` = first byte 127).
Tests: 196 pass / 0 fail.

**A TENTH codex re-review found ONE finding -- and it flagged OVER-REACH, not a leak (a
strong convergence signal): the credential-keyword denylist in `browserRef` rejected
legitimate DESCRIPTIVE run/daemon ids like `run_signature_check` / `run_sim_wrong_token_001`
(a real run id used in runtime-deterministic-simulation), so `createBrowserSessionRef`/
`guardRefPart` threw and blocked browser setup -- a functional regression from my own
hardening accretion (codex only ever requested the structural SCHEME detection, never the
credential wordlist).** Fix: SPLIT `BROWSER_REF_UNSAFE_PATTERN` into `STRUCTURAL_REF_UNSAFE_PATTERN`
(paths/slashes/delimiters/URL-schemes/generic-opaque-scheme) and `CREDENTIAL_KEYWORD_PATTERN`.
`isOpaqueBrowserRef`/`isOpaqueSurrogateSessionId` keep BOTH (the echo path still redacts a
secret-looking surrogate session id -- earlier codex findings preserved), but
`isSafeBrowserRefPart` (daemonId/runId) is now STRUCTURAL-ONLY: a ref part is a runtime
identifier that may legitimately contain a marker word, and it is only ever assembled into
the transparent `daemon:…:session:…` ref (itself redacted in any echo via the `daemon:`
check), so a marker word in a part never surfaces as a standalone secret. Findings trend
9->5->5->3->3->3->1, shifting from leaks to over-reach. Tests: 197 pass / 0 fail.

## Design decisions already locked (don't relitigate)

- Real adapter is **raw CDP**, not Playwright. `playwright` stays in the
  `BrowserObservation.source` union as a future option behind the same interface.
- Daemon is **local/loopback only**; `profile=user` is never a default or a
  silent fallback. Daemon failure ⇒ structured failure, full stop.
- Runtime must stay **browser-free**: `src/runtime/*` must not import
  `src/browser/*`. There's a test (`browser-types.test.js`) that greps the
  runtime source to enforce this — keep it green.

## Known open boundaries (intentional, not bugs)

1. **Cross-restart resume** — in-memory registry loses the surrogate→context map
   on restart. Needs a durable registry impl or checkpoint-side recreation
   context. Deferred (touches Phase 3.6).
2. **Daemon launch** (`startIfMissing`) — rejected, not implemented. Needs a
   narrow startup adapter. Deferred (Phase 3.7-ish).
3. **Real CDP page transport** — `ChromePageTargetController` is interface-complete,
   but its `CdpTargetTransport` is `NotImplemented`: a real Chrome target needs a
   CDP websocket session. Page bookkeeping/state/refs are real and tested; the wire
   protocol is deferred alongside daemon launch.

## Next slice: Phase 3.4 — network capture → evidence bridge

Spec: `docs/phase3-low-level-design.md` §7. Build `NetworkCaptureSession`
(start / stop / list observations) and `mapBrowserObservationToNetworkEntry`,
then a small `browserCaptureFlow` that chains: capture `BrowserObservation`s →
map to `RawNetworkEntry[]` → the **existing** `normalizeNetworkEvidence(...)` →
`coordinator.recordNormalizedEvidence(...)`. The browser layer must **not** create
Evidence itself or call `checkpointStore.update` directly — the existing network
normalizer stays the only evidence creator, and the coordinator owns the write.

Reuse, don't rebuild: `src/discovery/network/*` already defines `RawNetworkEntry`
and emits validated Evidence; `browserObservation.ts` already redacts header
previews by construction (`toSafeHeaderPreview` / `assertSafeBrowserObservation`).
The page refs you attach come from 3.3's controller and are already opaque.

**Process expectation (unchanged):** abuse cases *first* — a missing request URL
maps to `undefined` (skipped, not a crash); static/media observations are skipped
by the existing normalizer; auth-bearing headers and query values never reach a
persisted entry; mapped entries keep method/path/query *names* but not query
*values* — then the happy fixture→Evidence path. The recurring failure here has
been redaction code that passes its own tests while leaving structural holes, so
adversarial inputs go in up front.

## Verification gate (run before declaring any slice done)

```bash
npm run typecheck && npm test && npm run check
```

Then a targeted probe: try to store/return each known-unsafe value
(ws:// ref, profile path, secret URL, transparent surrogate, remote endpoint) and
assert it's rejected or sanitized — independently of the test suite, since the
suite is what keeps missing these.
