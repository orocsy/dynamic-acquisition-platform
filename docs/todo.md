# TODO

## Immediate
- [x] Commit low-level implementation design v0
- [x] Add authenticated-web runtime design: login waits, human intervention, timeout, resume/checkpoint contracts
- [x] Implement first neutral discovery primitive: network evidence normalizer from synthetic fixtures
- [x] Document Phase 2 runtime checkpoint and human-intervention design, including resume-vs-subscribe boundary and diagrams
- [ ] Implement Phase 2 runtime contracts and in-memory checkpoint/intervention stores
- [ ] Implement Phase 2 runtime coordinator transitions and deterministic resume simulation
- [ ] Add Phase 2 token/redaction/idempotency tests

## Browser/runtime follow-up after Phase 2 foundation is stable
- [ ] Promote daemon runner to default browser entrypoint
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
