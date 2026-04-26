# Contracts

Platform-owned contract shapes live here.

Start with plain JavaScript schema modules before introducing heavier validation dependencies.

Planned v0 contracts:

- `intent.schema.js`
- `evidence.schema.js`
- `plan.schema.js`
- `artifact.schema.js`
- `failure.schema.js`

Rules:

- contracts are backend-neutral
- provider-specific IDs belong in `externalIds` / metadata fields
- every executable plan step should name a platform capability ID
- every failure should be structured enough to support retry, fallback, or re-plan
