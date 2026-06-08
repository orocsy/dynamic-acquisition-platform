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
- [ ] Phase 3.4: Implement network capture -> evidence bridge
  - acceptance (round-8 review Finding 2, deferred here): `assertSafeBrowserObservation` must also cover `request.url` / `response` / `pageTargetRef`, not just header previews — strip secret query *values* while keeping query *names* for evidence, reject non-http(s) schemes and unsafe `pageTargetRef`. Deferred to 3.4 because 3.4 is what produces observations and defines the url-handling contract.
- [ ] Phase 3.5: Implement auth boundary -> human intervention bridge
- [ ] Phase 3.6: Implement browser-backed resume auth recheck
- [ ] Phase 3.7: Promote daemon runner to default browser entrypoint and audit policy/docs
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
