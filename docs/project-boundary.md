# Project Boundary

## Decision

This repository is a standalone implementation project for the shared dynamic acquisition platform.

It is not a dump of previous product scripts, and it should not describe private target sites, course portals, account-specific workflows, or historical scraping attempts.

## What belongs here

- platform-owned schemas
- normalized evidence models
- provider-neutral discovery helpers
- plan and plan-step contracts
- backend routing interfaces
- structured failure and checkpoint semantics
- artifact validation contracts
- adapter interfaces for downstream consumers

## What does not belong here

- product-specific workflow names
- target-site-specific scripts
- account-specific examples
- local private data paths
- provider names embedded into core capability IDs
- direct copies of external tool internals

## Core boundary

The core should remain neutral:

```text
Intent -> Discovery -> Evidence -> Strategy -> Plan -> Execution -> Artifacts
```

Adapters may translate between downstream product needs and this platform, but the core should not know the downstream product by name.

## First concrete slice

1. Define the v0 contracts.
2. Add minimal validation helpers for those contracts.
3. Add neutral fixtures.
4. Add provider-neutral HAR/network discovery normalization.
5. Only then introduce adapters.

## Exit criteria for v0

The project is useful when it can:

- normalize one browser/network capture into Evidence
- synthesize one Plan from Intent + Evidence
- validate one ArtifactContract
- return one StructuredFailure that supports retry, fallback, or re-planning
