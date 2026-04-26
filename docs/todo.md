# TODO

## Immediate
- [ ] Promote daemon runner to default browser entrypoint
- [ ] Demote default `profile=user` attach routes to explicit/manual mode
- [ ] Push current stable-daemon phase to GitHub
- [ ] Audit all scripts/docs for old browser attach assumptions

## Next research
- [ ] Study OpenCLI install/integration strategy
- [ ] Evaluate which OpenCLI pieces are worth direct adoption
- [ ] Design shared browser-core module boundaries
- [ ] Define strategy-engine interface for public/cookie/header/intercept/ui
- [ ] Turn the cloud document notes HAR case into the first authenticated discovery -> request-replay provider test
- [ ] Build a HAR analyzer that extracts provider-relevant ids/endpoints without depending on UI visibility

## Future
- [ ] Decide whether shared browser-core remains local or becomes a separate repo
- [ ] Define adapter contract for different task families
- [ ] Unify artifact/state conventions across projects

## Update rule
When new architecture thinking appears, update one of these docs or add a new one under `docs/`.
