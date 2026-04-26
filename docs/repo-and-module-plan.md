# Repo and Module Plan

## Why a new repo
A shared automation platform is itself an evolving codebase.
If it stays as scattered code inside one existing product repo, it will:
- inherit the wrong ownership boundary
- be harder to test and version
- become coupled to one product’s needs
- slow future reuse

So yes, this should become a new repo.

## Proposed repo purpose
A shared automation platform that provides:
- stable browser infrastructure
- strategy-aware execution
- adapter/plugin contracts
- OpenCLI integration points
- shared exporters/state utilities

## Suggested repo name candidates
- `browser-automation-platform`
- `automation-core`
- `browser-core-platform`
- `agent-browser-core`

## Suggested package sequence
1. `daemon-manager`
2. `browser-bridge`
3. `strategy-engine`
4. `adapter-contracts`
5. `artifact-state`
6. `opencli-bridge`
7. exporters and provider plugins

## First migration target
`production workflow` browser hunt is the best first consumer because:
- browser stability is already the bottleneck
- daemon-first success has already been proven
- it needs strategy evolution beyond DOM scraping
- it produces real structured outputs to validate

## Second migration target
A content capture flow such as authenticated learning portal or authenticated content portal, because it stresses:
- protected content
- resume state
- PDF export
- profile persistence

## Ownership model
- shared repo owns low-level browser and strategy layers
- product repos own domain flows and business outputs
- adapters can live in shared repo or product repo depending on reuse potential

## Decision rule for where code goes
Put code in the shared repo if it is reusable by 2+ systems.
Keep code in the product repo if it is domain-specific and unlikely to generalize.
