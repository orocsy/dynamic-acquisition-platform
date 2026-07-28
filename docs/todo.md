# TODO

## Immediate
- [x] Commit low-level implementation design v0
- [x] Add authenticated-web runtime design: login waits, human intervention, timeout, resume/checkpoint contracts
- [x] Implement first neutral discovery primitive: network evidence normalizer from synthetic fixtures
- [x] Document Phase 2 runtime checkpoint and human-intervention design, including resume-vs-subscribe boundary and diagrams
- [x] Break Phase 2 into quality-focused implementation slices: `docs/phase2-implementation-breakdown.md`
- [x] Add Phase 2 implementation diagrams under `docs/diagrams/`
- [x] Phase 2.1: Implement runtime contracts and state invariants
- [x] Phase 2.2: Implement in-memory checkpoint/intervention stores plus token/redaction helpers
- [x] Phase 2.3: Implement runtime coordinator core transitions
- [x] Phase 2.4: Implement human intervention request/completion/resume-entry lifecycle
- [x] Phase 2.5: Implement deterministic resume simulation
- [x] Phase 2.6: Harden runtime tests/docs and update TODOs after verification

## Browser/runtime follow-up after Phase 2 foundation is stable
- [x] Draft Phase 3 docs-first design package before implementation
- [x] Define Phase 3 implementation breakdown and quality gates
- [x] Add Phase 3 low-level design for 3.1–3.7 implementation slices
- [ ] Add/share Phase 3 daemon/runtime and auth-resume diagrams if needed
- [x] Phase 3.1: Implement browser contracts and opaque refs
- [x] Phase 3.2: Implement daemon health/start boundary (CDP `ChromeDaemonClient` + `FakeBrowserDaemonClient` + opaque session registry + header redaction-by-construction)
- [x] Phase 3.3: Implement page target lifecycle (`PageTargetController` state machine, `navigationPolicy`, `pageTargetErrors`, `FakePageTargetController` + real `ChromePageTargetController` behind an injected CDP transport port; cleaned up 3 speculative unused types in `browser/types.ts`)
- [x] Phase 3.4: Implement network capture -> evidence bridge (MERGED to main 2026-07-21 via PR #3, e6ef1cd; codex loop converged to zero across 9 rounds)
  - acceptance (round-8 review Finding 2): the `assertSafeBrowserObservation` invariant now ALSO validates `request.url` and `pageTargetRef` -- done in the hardening rounds (rejects query/userinfo/non-http(s)/scheme-relative/backslash-smuggled URLs and any non-`page:<id>` ref). REMAINING for 3.4 (the construction side): the network->evidence normalizer must strip secret query *values* while keeping query *names* for evidence, and classify `response` fields, when 3.4 produces observations.
  - DONE (3.4 bridge): `BrowserObservation.request.queryParamNames` (validated value-less names) carries the names the sanitized `url` strips; `mapBrowserObservationToNetworkEntry` maps observation->`RawNetworkEntry` (source `daemon-fixture`->`fixture`; reconstructs a values-less `?a=&b=` query so the existing normalizer keeps NAMES, drops VALUES via `sanitizeUrlForEvidence`); `BrowserNetworkCaptureSession` (start/stop/listObservations) gates observations through `assertSafeBrowserObservation`; `runBrowserNetworkCaptureFlow` maps->`normalizeNetworkEvidence`->`coordinator.recordNormalizedEvidence` (never touches `checkpointStore.update`; an `error`-level normalizer diagnostic stops the flow before any transition). Exit criteria 7.7 verified (normalizer is the only Evidence creator; secrets absent from coordinator events). +8 tests across 3 new test files.
- [~] Phase 3.5: Implement auth boundary -> human intervention bridge (IMPLEMENTED as PR #4; codex loop converged to ZERO across 6 rounds 2026-07-21 (findings 5->4->4->3->1->0, incl. C3 resume-step + E1 getter-TOCTOU); 279 tests; READY TO MERGE)
  - DONE (3.5): `ConservativeAuthBoundaryDetector` (LLD §8.3-8.4: nav 401/403 -> login, network 401/403 -> login, login-path redirect, MFA/captcha/consent page markers; weak markers -> diagnostics only; every output field fixed-vocabulary or `sanitizeUrlPreview`-sanitized; scans bounded). `requestHumanInterventionFromBrowser` (LLD §8.5-8.6: surrogate-ref guard without echo, explicit kind map, KNOWN_AUTH_BOUNDARY_REASONS forwarding, fixed instruction template, coordinator-backed `waiting_for_human`, once-only resume token never stored, optional post-record `markStale` that never jeopardizes the token). +14 tests (abuse first), independent probe green.
- [~] Phase 3.6: Implement browser-backed resume auth recheck (IMPLEMENTED on branch phase3.6-resume-auth-recheck as PR #5, head f66e7a2; 357 tests; codex loop at 13 rounds / 66 findings all fixed (9->7->5->8->4->4->3->2->3->8->6->4->3), round 14 outstanding; NOT merged -- merge is a user action). **Full engineering record: `docs/phase3.6-resume-auth-recheck.md`** (invariant catalogue, the two URL gates, daemon binding, four recurring defect classes, post-merge checklist).
  - DONE (3.6): `authRecheck.ts` (BrowserAuthRechecker contract §9.3; FakeBrowserAuthRechecker; DetectorBackedAuthRechecker reusing the 3.5 detector as the auth-signal oracle via a deferred AuthStateProbe port -> a persisting boundary is `still-unauthorized`, a probe failure fails safe as `session-stale`; fixed per-code messages). `resumeBrowserRun.ts` (§9.4 flow: resumeRun -> recheck [+ §9.5 policy-gated one-shot target recreation, blocked by side-effect-in-progress] -> markFailed on fail BEFORE any evidence, or confirmResumeAuthRecheck -> reuse runBrowserNetworkCaptureFlow -> markCompleted; owns the capture-window start on the possibly-recreated target; re-derives a SAFE message from a validated code and never forwards a foreign rechecker's message/diagnostics/pageTargetRef). +18 tests; deterministic event order verified; independent probe green.
- [ ] **Constrain the Intent contract before Phase 3.7** (scheme allowlist on `target.value`, required `intentId`). ROOT CAUSE surfaced by the 3.6 review: `intentSnapshot` is typed `unknown` and `src/contracts/intent.schema.js` constrains no schemes, so a run can carry `javascript:`/`file:`/`data:`/credential-bearing/loopback URLs as its own recorded intent, and an intent id from another acquisition can be attributed to this run's evidence. `resumeBrowserRun` now defends against both, but every OTHER consumer of an intent snapshot has the same exposure -- patching each consumer does not fix the class. See `docs/phase3.6-resume-auth-recheck.md` §8.
- [ ] Phase 3.7: Promote daemon runner to default browser entrypoint and audit policy/docs (this is the slice where the deferred transports stop being deferrable: `CdpTargetTransport`, `AuthStateProbe`, `NetworkObservationSource` are all `NotImplemented*` today, so NO real browser test is possible before it -- budget for an integration harness a fixture suite cannot replace)
- [ ] Demote default `profile=user` attach routes to explicit/manual mode
- [ ] Design explicit desktop/UI bridge fallback adapter (Peekaboo candidate) as an operator-selected GUI-only/manual fallback, not a daemon-failure fallback
- [ ] Build desktop/UI bridge fallback spike after Phase 3.7: provider-neutral port, fake adapter, policy/redaction tests, optional harmless manual smoke
- [ ] Push current stable-daemon phase to GitHub
- [ ] Audit all scripts/docs for old browser attach assumptions

## Next research
- [ ] Study OpenCLI install/integration strategy
- [ ] Evaluate which OpenCLI pieces are worth direct adoption
- [ ] Design shared browser-core module boundaries
- [ ] Define strategy-engine interface for public/cookie/header/intercept/ui
- [ ] Define fallback policy taxonomy for `desktop_ui_bridge_candidate`, `desktop_ui_bridge_selected`, and `desktop_ui_bridge_declined`
- [ ] Turn a generic authenticated HAR fixture into the first authenticated discovery -> request-replay provider test
- [ ] Build a HAR analyzer that extracts provider-relevant ids/endpoints without depending on UI visibility

## Future
- [ ] Decide whether shared browser-core remains local or becomes a separate repo
- [ ] Define adapter contract for different task families
- [ ] Unify artifact/state conventions across projects

## Update rule
When new architecture thinking appears, update one of these docs or add a new one under `docs/`.
