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
- [ ] Add/share Phase 3 daemon/runtime and auth-resume diagrams if needed
- [ ] Phase 3.1: Implement browser contracts and opaque refs
- [ ] Phase 3.2: Implement daemon health/start boundary
- [ ] Phase 3.3: Implement page target lifecycle
- [ ] Phase 3.4: Implement network capture -> evidence bridge
- [ ] Phase 3.5: Implement auth boundary -> human intervention bridge
- [ ] Phase 3.6: Implement browser-backed resume auth recheck
- [ ] Phase 3.7: Promote daemon runner to default browser entrypoint and audit policy/docs
- [ ] Demote default `profile=user` attach routes to explicit/manual mode
- [ ] Push current stable-daemon phase to GitHub
- [ ] Audit all scripts/docs for old browser attach assumptions

## Next research
- [ ] Study OpenCLI install/integration strategy
- [ ] Evaluate which OpenCLI pieces are worth direct adoption
- [ ] Design shared browser-core module boundaries
- [ ] Define strategy-engine interface for public/cookie/header/intercept/ui
- [ ] Turn a generic authenticated HAR fixture into the first authenticated discovery -> request-replay provider test
- [ ] Build a HAR analyzer that extracts provider-relevant ids/endpoints without depending on UI visibility

## Future
- [ ] Decide whether shared browser-core remains local or becomes a separate repo
- [ ] Define adapter contract for different task families
- [ ] Unify artifact/state conventions across projects

## Update rule
When new architecture thinking appears, update one of these docs or add a new one under `docs/`.
