# Dynamic Acquisition Platform — Implementation Design v0

**Status:** Draft v0  
**Purpose:** Bridge existing high-level architecture into implementable modules, interfaces, functions, and first coding slice.

---

## 1. Design Position

We already have enough **high-level design** in:

- `dynamic-acquisition-platform-system-design.md`
- `dynamic-acquisition-platform-contracts.md`
- `dynamic-acquisition-platform-schemas-v0.md`
- `dynamic-acquisition-platform-capability-catalog-v0.md`
- `repo-and-module-plan.md`

The next step is **not** to immediately write random implementation code.

The next step is a small **low-level implementation design** for the first vertical slice:

> HAR / network evidence normalizer → emits v0 `Evidence` contract from synthetic fixtures.

This gives the platform a real executable core without prematurely building the whole system.

---

## 2. Design Levels

### 2.1 High-Level Design

Already mostly done.

Covers:

- platform purpose
- major subsystems
- evidence-first model
- strategy planning model
- backend composition
- artifact contracts
- OpenCLI / browser runtime positioning

### 2.2 Low-Level Design

Needed now.

Should define:

- module boundaries
- public interfaces
- domain types
- validation boundaries
- error model
- class/function relationships
- extension points
- test fixtures

### 2.3 Implementation Slice

Only after LLD.

First implementation target:

- parse synthetic HAR-like fixture
- normalize requests/responses into `Evidence[]`
- validate against contract schema
- return deterministic diagnostics

---

## 3. First Vertical Slice

### Name

`network-evidence-normalizer`

### Goal

Convert raw network observation into normalized platform evidence.

Input examples:

- HAR entries
- Playwright network logs
- browser CDP request/response captures
- synthetic test fixtures

Output:

- validated `Evidence[]`
- optional diagnostics
- skipped-entry reasons

### Non-Goals

This slice does **not** yet:

- launch a browser
- authenticate to real sites
- replay requests
- infer full provider strategy
- generate final artifacts
- call AI models

---

## 4. Proposed Module Layout

```text
src/
  contracts/
    evidence.schema.js
    validate.js
    index.js

  discovery/
    network/
      normalizeNetworkEvidence.js
      classifyNetworkEntry.js
      extractRequestSignals.js
      extractResponseSignals.js
      types.js
      index.js

  diagnostics/
    diagnostics.js
    index.js

  fixtures/
    network/
      synthetic-har-basic.json
      synthetic-har-authenticated-api.json
      synthetic-har-static-assets.json

test/
  network-evidence-normalizer.test.js
```

TypeScript foundation:

```text
src/
  contracts/
    *.schema.js          # runtime validators for v0

  discovery/network/
    types.ts             # typed domain contracts
    normalizeNetworkEvidence.ts
    classifyNetworkEntry.ts
    extractRequestSignals.ts
    extractResponseSignals.ts
```

The first implementation slice should preserve typed interfaces from the start. Runtime validation remains lightweight CommonJS until the contract layer graduates to a schema library.

---

## 5. Core Types

### RawNetworkEntry

A normalized internal input shape before converting to platform `Evidence`.

```ts
type RawNetworkEntry = {
  id?: string;
  url: string;
  method: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  status?: number;
  mimeType?: string;
  resourceType?: string;
  requestBodyPreview?: string;
  responseBodyPreview?: string;
  startedAt?: string;
  durationMs?: number;
  source: 'har' | 'playwright' | 'cdp' | 'fixture';
};
```

### NetworkEvidenceNormalizerInput

```ts
type NetworkEvidenceNormalizerInput = {
  entries: RawNetworkEntry[];
  targetUrl?: string;
  runId?: string;
};
```

### NetworkEvidenceNormalizerResult

```ts
type NetworkEvidenceNormalizerResult = {
  evidence: Evidence[];
  diagnostics: Diagnostic[];
  skipped: SkippedEntry[];
};
```

---

## 6. Functional Decomposition

### `normalizeNetworkEvidence(input)`

Orchestrator function.

Responsibilities:

1. iterate raw entries
2. classify each entry
3. extract request signals
4. extract response signals
5. construct candidate `Evidence`
6. validate candidate evidence
7. collect diagnostics
8. return deterministic result

Should remain mostly procedural at first.

Avoid premature class hierarchy here.

---

### `classifyNetworkEntry(entry)`

Determines broad category.

Possible categories:

- `api-json`
- `document-html`
- `static-asset`
- `media`
- `graphql`
- `auth-token-refresh`
- `unknown`

Returns:

```ts
type NetworkEntryClassification = {
  category: string;
  confidence: number;
  reasons: string[];
};
```

---

### `extractRequestSignals(entry)`

Extracts useful request-side evidence:

- method
- URL path
- query params
- auth header presence, not secret value
- content type
- body shape hints
- cache hints

Important security rule:

> Never store raw tokens, cookies, or sensitive headers in Evidence.

---

### `extractResponseSignals(entry)`

Extracts response-side evidence:

- status
- content type
- body preview shape
- JSON/list/detail hints
- pagination hints
- downloadable artifact hints

---

## 7. Class vs Function Decision

Use functions first.

Reason:

- first slice is deterministic transformation
- state is minimal
- easier to test
- avoids fake OOP

Introduce classes later only when there is real polymorphism or lifecycle state.

Good future class candidates:

```ts
interface EvidenceSourceAdapter {
  collect(input: AcquisitionIntent): Promise<RawObservation[]>;
}

interface EvidenceNormalizer<TInput> {
  normalize(input: TInput): Promise<NormalizationResult>;
}

interface StrategyPlanner {
  plan(evidence: Evidence[], intent: Intent): Promise<Plan>;
}

interface PlanExecutor {
  execute(plan: Plan): Promise<ArtifactBundle>;
}
```

Likely implementations:

```ts
class HarEvidenceSourceAdapter implements EvidenceSourceAdapter {}
class PlaywrightNetworkAdapter implements EvidenceSourceAdapter {}
class CdpNetworkAdapter implements EvidenceSourceAdapter {}

class NetworkEvidenceNormalizer implements EvidenceNormalizer<RawNetworkEntry[]> {}
class DomEvidenceNormalizer implements EvidenceNormalizer<DomSnapshot> {}

class RuleBasedStrategyPlanner implements StrategyPlanner {}
class AiAssistedStrategyPlanner implements StrategyPlanner {}

class LocalPlanExecutor implements PlanExecutor {}
class OpenCliBackedPlanExecutor implements PlanExecutor {}
```

---

## 8. Polymorphism Boundary

Do **not** use inheritance as the default.

Prefer:

1. interfaces / contracts
2. composition
3. strategy objects
4. small adapters

Use inheritance only for shared mechanics with stable behavior.

Bad early design:

```ts
class BaseProviderCollector {}
class ProviderACollector extends BaseProviderCollector {}
class ProviderBCollector extends BaseProviderCollector {}
```

This recreates provider-centric collection.

Better design:

```ts
interface Capability {
  id: string;
  canRun(context: CapabilityContext): Promise<CapabilityDecision>;
  run(context: CapabilityContext): Promise<CapabilityResult>;
}

class InspectNetworkCapability implements Capability {}
class ReplayRequestCapability implements Capability {}
class RenderPdfCapability implements Capability {}
```

The reusable unit is the capability, not the provider collector.

---

## 9. Dependency Direction

Target dependency rule:

```text
contracts
  ↑
discovery/network
  ↑
planning
  ↑
runtime/execution
  ↑
adapters/providers/products
```

Rules:

- contracts know nothing about discovery
- discovery knows contracts only
- planning consumes evidence, does not collect it
- execution consumes plans, does not invent strategy
- adapters translate external systems into internal contracts

---

## 10. First Test Plan

### Test 1 — Basic JSON API request

Given a HAR entry for a JSON API response:

- emits one evidence item
- category is `api-json`
- includes URL/method/status/content-type
- validates against schema

### Test 2 — Static assets skipped

Given CSS/JS/image/font entries:

- skipped with reason `static-asset`
- no evidence emitted unless configured otherwise

### Test 3 — Auth headers redacted

Given request headers containing cookie/auth tokens:

- detects auth presence
- does not store raw secret values

### Test 4 — GraphQL hint

Given POST `/graphql` or GraphQL-shaped body:

- category is `graphql`
- captures operation hint if safely available

---

## 11. Authenticated Web Scenario

Many real acquisition tasks require login, MFA, consent screens, anti-bot checks, or account-specific navigation.

The platform should treat authentication as an explicit runtime state, not as a hidden browser side effect.

### 11.1 Authentication Policy

Default policy:

> Try automatic authenticated operation only when a reusable, already-authorized browser profile or session artifact is available. Otherwise pause and request human intervention.

The system should not attempt to guess passwords, bypass MFA, defeat bot checks, or store raw credentials.

Supported auth modes:

- `public` — no login needed
- `existing-session` — use an already logged-in browser/profile/session
- `human-assisted` — pause for the human to complete login or consent
- `unsupported` — blocked by security, policy, or missing account access

### 11.2 Human Intervention Contract

When login is needed, runtime should emit a structured intervention request:

```ts
type HumanInterventionRequest = {
  id: string;
  runId: string;
  kind: 'login-required' | 'mfa-required' | 'consent-required' | 'captcha-required' | 'decision-required';
  url?: string;
  reason: string;
  instructions: string[];
  timeoutMs: number;
  resumeToken: string;
  safeToRetry: boolean;
};
```

Recommended timeout defaults:

- interactive foreground run: 10-15 minutes
- background agent run: 30-60 minutes
- long-running batch job: configurable, max 24 hours

After timeout, the run should move to `waiting` or `expired`, not silently restart.

### 11.3 Resume / Checkpoint System

A resume system is needed.

Reason: authenticated discovery can be expensive or stateful. Restarting from zero after login, network capture, or partial artifact generation wastes time and can trigger rate limits or account risk.

The runtime should checkpoint at stable boundaries:

- intent accepted
- target opened
- auth state detected
- human intervention requested
- human intervention completed
- network evidence captured
- evidence normalized
- plan generated
- plan step completed
- artifact emitted

Checkpoint shape:

```ts
type RunCheckpoint = {
  runId: string;
  status: 'running' | 'waiting' | 'expired' | 'failed' | 'completed';
  phase: string;
  intentSnapshot: unknown;
  evidenceRefs: string[];
  artifactRefs: string[];
  browserSessionRef?: string;
  resumeToken?: string;
  lastCompletedStepId?: string;
  diagnostics: Diagnostic[];
  updatedAt: string;
};
```

Resume policy:

- deterministic pure steps should resume from saved outputs
- browser/navigation steps should resume only if the session/profile is still valid
- unsafe side-effecting steps must be idempotent or require explicit confirmation
- expired auth waits should resume from the last pre-auth checkpoint, not the beginning

Some things may still need to restart:

- volatile browser pages after crash
- expired session cookies
- one-time download URLs
- server-side state that cannot be safely replayed

But the run itself should not lose its intent, evidence, diagnostics, completed artifacts, or next action.

---

## 12. Build Order

1. Confirm / refine `Evidence` schema fields needed for network evidence.
2. Add synthetic network fixture files.
3. Implement pure classifier and signal extractor functions.
4. Implement `normalizeNetworkEvidence` orchestrator.
5. Add contract validation around emitted evidence.
6. Add tests.
7. Add runtime design docs for auth waits, resume tokens, and checkpoints before browser integration.
8. Run `npm run check` and `npm test`.
9. Only then consider browser integration.

---

## 13. Decision

Proceed with low-level implementation design first, then implement the first neutral discovery primitive.

The immediate next coding task is **not** a browser runner.

The immediate next coding task is:

> deterministic network evidence normalization from synthetic fixtures.

In parallel, define the runtime-level authenticated-web contract:

> login is human-assisted when needed; runs wait with timeout; checkpoints make resume first-class.

This gives the platform its first real reusable core while keeping scope controlled.
