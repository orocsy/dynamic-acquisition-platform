# Dynamic Acquisition Platform

A standalone platform project for browser-assisted content acquisition, evidence normalization, planning, execution contracts, and artifact validation.

## Mission

Build a reusable acquisition substrate that can support many browser/content workflows without hard-coding product-specific or provider-specific logic into the core.

The platform owns:

- normalized intent contracts
- evidence contracts
- acquisition plan contracts
- backend-neutral capability names
- structured failure semantics
- artifact/output contracts
- adapter boundaries for downstream consumers

## Design principles

1. **Contracts first** — platform contracts are the source of truth; backends map into them.
2. **Evidence before execution** — observe, normalize, and reason before choosing an execution strategy.
3. **Capabilities over flows** — reusable capability primitives matter more than one-off end-to-end scripts.
4. **Backend neutrality** — browser, request replay, local renderers, and external tools are all implementation choices behind contracts.
5. **Safe adapters** — downstream products consume stable adapters; core does not import product code.

## Repository layout

```text
docs/                  Architecture and design documents
docs/diagrams/         Editable Excalidraw diagrams
src/contracts/         Machine-readable contract definitions
src/discovery/         Provider-neutral discovery primitives
src/planning/          Strategy and plan synthesis primitives
src/runtime/           Checkpoint, retry, and execution control primitives
src/adapters/          Consumer-facing adapter boundaries
examples/              Neutral fixtures and examples
```

## First implementation target

The first implementation slice is the v0 contract package:

- Intent
- Evidence
- Plan
- PlanStep
- ArtifactContract
- StructuredFailure

After that, the next slice is a provider-neutral HAR/network discovery normalizer that emits the Evidence contract.

## Status

Early incubation. Contracts, network evidence normalization, and the Phase 2 checkpoint/human-intervention runtime foundation are implemented. Phase 3 is currently in docs-first design for dedicated Chrome daemon integration.

Current Phase 3 docs:

- `docs/phase3-browser-daemon-integration-design.md`
- `docs/phase3-implementation-breakdown.md`
- `docs/browser-daemon-runtime-boundary.md`
- `docs/phase3-testing-validation-plan.md`
