# Handoff — Phase 3.3 complete (review round 8 applied), ready for 3.4

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

Tests: **133 pass / 0 fail.** Browser layer is `src/browser/*` with 7
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
