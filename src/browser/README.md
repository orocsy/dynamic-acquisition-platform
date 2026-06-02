# Browser

Browser daemon integration contracts live here.

Phase 3.1 scope:

- define browser-domain refs and observations,
- create opaque browser session refs for runtime checkpoints,
- redact browser diagnostics before persistence,
- keep raw debugger URLs, websocket URLs, cookies, auth headers, profile paths, and local Chrome state out of public contracts.

Phase 3.2 scope:

- `daemonClient.ts` — `BrowserDaemonClient` interface plus the real `ChromeDaemonClient`, which checks daemon health via the CDP HTTP `/json/version` endpoint (raw CDP, not Playwright). Health results are sanitized and never include the raw `webSocketDebuggerUrl`.
- `fakeDaemonClient.ts` — `FakeBrowserDaemonClient` for deterministic unit/fixture tests with failure injection; no network, no Chrome launch.
- `daemonErrors.ts` — `BrowserDaemonError` and the `daemon-unavailable | daemon-unhealthy | daemon-start-failed | daemon-response-invalid` failure codes.
- Daemon failures surface as structured failures; they never silently fall back to `profile=user`. Only `dedicated-daemon` mode is accepted by default.
- `healthUrlPreview` is reduced to the endpoint **origin** (`scheme://host:port`) plus `/json/version`; userinfo/path/query are rejected, so endpoint secrets can never reach public output. The endpoint host must be **loopback** (`localhost`, `127.0.0.0/8`, `::1`) — a `local-chrome-daemon` ref cannot point at a remote host.
- `startIfMissing` is **not implemented** in 3.2 (daemon launch needs a startup adapter, deferred). It is rejected with `daemon-start-failed` rather than silently ignored.

Design refinements applied alongside 3.2:

- **Opaque session registry** (`browserSessionRegistry.ts`): checkpoints store an opaque `session:<uuid>` surrogate; the registry maps it to `{ daemonId, runId, pageTargetRef, targetUrlPreview }`. The transparent `daemon:<id>:session:<runId>` ref from `createBrowserSessionRef` is kept registry-side only. Ref *parts* (daemonId/runId) reject `:` and whitespace so a colon-bearing part can't smuggle extra `daemon:`/`session:` segments; minted surrogate ids are validated with `isOpaqueSurrogateSessionId`, which rejects secret-bearing refs, the transparent linkable form, and any `daemon:`-prefixed value. `targetUrlPreview` is sanitized on write (query/fragment/userinfo stripped), since it is a *preview*, not a raw URL. This is also where Phase 3.6 stale-target recreation context lives.
  - **Durability boundary:** the registry is an interface; only an in-memory (process-local) implementation ships in 3.2, so **cross-restart resume is not supported yet** — a restart loses the surrogate→context mapping. A durable implementation or checkpoint-side recreation context is deferred to later Phase 3 work.
- **Header redaction by construction** (`browserObservation.ts`): `toSafeHeaderPreview` classifies headers into three tiers — values kept raw only for low-cardinality protocol headers; URL-bearing headers (`location`, etc.) have their values **sanitized** (query/fragment/userinfo stripped); and presence-only headers (`etag`, `content-disposition`) keep the name but drop the value. Everything else is `[redacted]`. `assertSafeBrowserObservation` enforces this as a hard invariant, including rejecting a `location` value that still carries a query string.

Phase 3.3 scope:

- `pageTargetController.ts` — the `PageTargetController` contract (`createTarget / getTarget / navigate / markStale / closeTarget`) and the `created → navigating → ready → stale → closed` state machine. State changes go through one `PageTargetStore`, so the transition table is enforced once and an illegal transition throws a structured `PageTargetError` **before** any mutation — it never touches a runtime checkpoint (the coordinator still owns lifecycle).
- Page refs are minted as `page:<uuid>` and validated **for the `page:` shape** (`isPageTargetRef`, not merely opacity) at the source, so the value that later lands in the session registry passes that registry's `guardPageTargetRef`. An unsafe factory output (`ws://`/`devtools` URL, profile path) or a wrong-shaped one (a session/transparent ref, an arbitrary token) is rejected at creation, never at persist time, and never echoed. Caller-supplied refs are validated the same way at the public boundary (`normalizeIncomingRef`): an unsafe ref to navigate/markStale/closeTarget is rejected as `unsafe-target-ref` **with no echo**, and every `PageTargetError` routes its ref through `refForError` as defense in depth. `ChromePageTargetController.createTarget` reserves the ref **before** opening the CDP target, so a duplicate ref can neither open a second raw target nor rebind the mapping.
- `navigationPolicy.ts` — central navigation knobs (default/clamped timeout, allowed wait modes, retry default, safe-restart conditions for Phase 3.6) and the canonical nav URL sanitizer, which delegates to the persistence guard's `sanitizeUrlPreview` so there is no fourth copy of URL-stripping. Final-URL previews and diagnostics are sanitized before they are surfaced — `browserRedaction` strips query/fragment/userinfo from URLs anywhere inside a free-form diagnostic string (not only whole-string URLs), so a secret embedded mid-message or in `user:pass@` userinfo does not leak. A diagnostic string that still carries a credential assignment (`token=…`, `password: …`) or an auth scheme (`Bearer …`) after URL scrubbing is redacted **wholesale**, since those values (multi-token cookies, `Scheme token`) can't be reliably delimited; a bare marker *mention* with no adjacent value is kept.
- `pageTargetErrors.ts` — `PageTargetError` and the `unknown-target | invalid-transition | target-stale | target-closed | unsafe-target-ref | transport-unavailable` code union.
- `fakePageTargetController.ts` — `FakePageTargetController`: deterministic, no Chrome, with an injectable navigation planner so tests can script success, an auth redirect, or a failure. This is the controller that drives the later Phase 3.4+ runtime-adapter tests.
- `ChromePageTargetController` is the real controller behind the same interface. It reuses the base state machine and ref discipline; only the CDP wire calls live behind an injected `CdpTargetTransport` port. The shipped `NotImplementedCdpTargetTransport` fails with a structured `transport-unavailable` error — the real websocket session is deferred (same bucket as the daemon launch adapter from 3.2). A raw CDP `rawTargetId` is mapped to the opaque ref internally and never surfaces in a snapshot, result, or persisted field.

Cleanup applied with 3.3: the three speculative, unused types in `types.ts` (`BrowserNavigationResult`, `BrowserAuthBoundarySignal`, `BrowserRuntimeDiagnostic`) were removed. The first is now defined by its owning slice here in `pageTargetController.ts` (per LLD §6.3); the auth ones belong to Phase 3.5. `BrowserTargetState` stays in `types.ts` as the shared state enum.

This package may depend on runtime public types and discovery helpers. Runtime must remain browser-neutral and must not import from `src/browser`.
