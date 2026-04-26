# Dynamic Acquisition Platform — Core Contracts and Control Policies

**Status:** Draft v1  
**Language:** English only  
**Audience:** Platform engineers, orchestration/runtime engineers, backend integrators, AI workflow engineers  
**Companion docs:**
- `dynamic-acquisition-platform-system-design.md`
- `opencli-runtime-analysis.md`
- `opencli-integration-recommendation.md`

---

# 1. Purpose

This document defines the first contract layer beneath the high-level architecture.

It specifies:
- the evidence schema
- the capability catalog model
- the plan schema
- backend routing policy
- AI harness intervention contract
- OpenCLI wrapper mapping model

This is the layer that prevents the platform from collapsing into:
- ad hoc provider scripts
- backend-defined models
- AI freeform orchestration without deterministic structure

---

# 2. Contract Design Principles

## 2.1 Contracts are platform-owned
All schemas in this document are **platform-native**. Backends map into them; they do not define them.

## 2.2 Contracts are execution-oriented but backend-neutral
Schemas must be expressive enough for planning and execution, without embedding OpenCLI-specific or provider-specific semantics.

## 2.3 Contracts should preserve explainability
Each major object should carry enough provenance and reason metadata to explain:
- what was observed
- why a strategy was chosen
- why a backend was selected
- why a re-plan occurred

## 2.4 Contracts should support partial progress
The system must be able to persist incomplete discovery, partial execution, failed branches, and resumable checkpoints.

---

# 3. Evidence Schema

## 3.1 Purpose
The evidence schema represents everything the system has learned about a target in a form reusable by:
- strategy selection
- plan synthesis
- backend routing
- AI harness steering
- debugging and validation

It is **not** a raw log dump.
It is a normalized interpretation layer over raw observations.

---

## 3.2 Top-Level Evidence Object

```json
{
  "version": "1.0",
  "evidenceId": "ev_...",
  "intentId": "in_...",
  "target": {},
  "entities": [],
  "observations": [],
  "requestFamilies": [],
  "authHints": [],
  "candidateFlows": [],
  "strategySignals": [],
  "gaps": [],
  "provenance": [],
  "confidence": {},
  "timestamps": {}
}
```

---

## 3.3 Target Section

Describes what the evidence is about.

```json
{
  "kind": "url|site|query|app|workflow",
  "value": "https://example.com/article/123",
  "siteKey": "authenticated-content-portal",
  "domain": "authenticated-content-portal.com",
  "scope": "single-page|course|site-search|multi-site|workflow-run"
}
```

### Notes
- `siteKey` is our logical site identifier, not a backend identifier.
- `scope` helps downstream planning decide whether it is handling a single target, enumeration, course capture, or recurring workflow.

---

## 3.4 Entity Model

Entities are normalized things the platform may operate on.

### Common entity kinds
- `site`
- `page`
- `document`
- `file`
- `lesson`
- `asset`
- `video`
- `api-endpoint`
- `export-target`
- `session-context`
- `query-result-set`

### Entity object

```json
{
  "id": "ent_...",
  "kind": "document",
  "label": "Main article body",
  "externalIds": {
    "fsid": "595983391672548",
    "nfsid": "997312243457695"
  },
  "attributes": {
    "title": "Quick Reference Cheat Sheet",
    "mimeType": "application/json"
  },
  "confidence": 0.92,
  "sources": ["obs_12", "obs_19"]
}
```

### Rules
- Entities must remain backend-neutral.
- Site-specific raw IDs should live inside `externalIds`, not replace entity identity.
- Every non-trivial entity should reference its source observations.

---

## 3.5 Observation Model

Observations are normalized facts derived from raw input sources.

### Observation kinds
- `dom-signal`
- `network-request`
- `network-response`
- `storage-entry`
- `cookie`
- `har-entry`
- `browser-state`
- `manual-note`
- `backend-capability-discovery`

### Observation object

```json
{
  "id": "obs_...",
  "kind": "network-request",
  "sourceType": "browser|har|opencli|native|ai-note",
  "summary": "GET /api/videomark/note?method=query",
  "data": {
    "method": "GET",
    "host": "pan.cloud-provider.com",
    "path": "/api/videomark/note",
    "query": {
      "method": "query"
    }
  },
  "confidence": 0.98,
  "capturedAt": "2026-04-21T00:43:09.303Z"
}
```

### Rules
- Observation data can be rich, but should be normalized enough to avoid backend-specific parsing everywhere else.
- Observations are the bridge between raw capture and higher-level evidence.

---

## 3.6 Request Family Model

Request families group network observations that represent the same functional contract.

```json
{
  "id": "rf_...",
  "label": "videomark-note-query",
  "classification": "read|write|export|search|enumeration|media",
  "signature": {
    "host": "pan.cloud-provider.com",
    "path": "/api/videomark/note"
  },
  "methods": ["GET"],
  "exampleObservationIds": ["obs_12", "obs_13"],
  "entityRefs": ["ent_doc_1"],
  "confidence": 0.95
}
```

### Why it matters
Strategy selection should reason over request families, not isolated raw entries.

---

## 3.7 Auth Hint Model

Auth hints describe what kind of authenticated context appears necessary or available.

```json
{
  "id": "auth_...",
  "kind": "cookie|header|storage-token|browser-session|intercept-only",
  "scope": "site|endpoint-family|entity",
  "targetRef": "rf_12",
  "details": {
    "requiresBrowserContext": true,
    "headerNames": ["Authorization", "x-csrf-token"],
    "storageKeys": ["__user_token.v3"]
  },
  "confidence": 0.88
}
```

### Rules
- Auth hints do not hold secret values unless the selected execution step explicitly needs them.
- They primarily inform strategy and preconditions.

---

## 3.8 Candidate Flow Model

Candidate flows describe plausible acquisition paths inferred from evidence.

```json
{
  "id": "cf_...",
  "name": "document-replay-then-export",
  "kind": "request-replay|browser-export|render-extract|mixed",
  "entryRefs": ["rf_12", "rf_18"],
  "outputKinds": ["structured-json", "png-export"],
  "preconditions": ["auth.browser-session", "discovered-export-target"],
  "confidence": 0.84,
  "notes": [
    "request family suggests stable read endpoint",
    "export path appears available through copyfile"
  ]
}
```

### Why it matters
Candidate flows are the bridge from evidence to strategy/planning.

---

## 3.9 Strategy Signal Model

Signals that influence strategy selection.

Examples:
- `public-json-endpoint-observed`
- `cookie-context-works`
- `storage-token-present`
- `export-surface-observed`
- `browser-only-interaction-required`
- `request-payload-incomplete`

```json
{
  "id": "sig_...",
  "code": "export-surface-observed",
  "strength": "weak|medium|strong",
  "sourceRefs": ["obs_21", "rf_7"],
  "note": "copyfile-like path suggests export retrieval"
}
```

---

## 3.10 Gap Model

Represents missing knowledge that blocks or weakens planning.

```json
{
  "id": "gap_...",
  "code": "missing-request-body-shape",
  "severity": "info|warning|blocking",
  "relatedRefs": ["rf_22"],
  "resolutionHints": [
    "capture POST body via browser network probe",
    "trigger export path in browser"
  ]
}
```

### Why it matters
This is the main object the AI harness can use to decide whether to enrich discovery.

---

## 3.11 Confidence Model

Top-level confidence should be decomposed.

```json
{
  "discoveryCoverage": 0.78,
  "entityResolution": 0.84,
  "strategyReadiness": 0.72,
  "executionReadiness": 0.66
}
```

This avoids a meaningless single confidence number.

---

# 4. Capability Catalog Schema

## 4.1 Purpose
The capability catalog is the platform-owned inventory of what the system can do.

It is not the same as:
- OpenCLI registry
- provider code inventory
- CLI command list

A capability is a platform concept. Backends may implement it differently.

---

## 4.2 Top-Level Capability Object

```json
{
  "id": "discover.browser.network",
  "category": "discovery",
  "summary": "Collect and normalize browser network observations for a target context",
  "inputSchemaRef": "cap.discover.browser.network.input",
  "outputSchemaRef": "cap.discover.browser.network.output",
  "sideEffects": "none|local-state|remote-read|remote-write",
  "checkpointBehavior": "none|recommended|required",
  "eligibleBackends": ["opencli", "native-browser"],
  "preferredBackends": ["opencli"],
  "preconditions": ["browser.session.available"],
  "postconditions": ["observations.network.present"],
  "tags": ["browser", "network", "discovery"]
}
```

---

## 4.3 Capability Categories

Recommended categories:
- `intent`
- `discovery`
- `evidence`
- `strategy`
- `planning`
- `execution`
- `artifact`
- `validation`
- `control`

Examples:
- `intent.interpret`
- `discover.har`
- `discover.browser.network`
- `evidence.normalize`
- `strategy.select`
- `plan.build`
- `execute.request.replay`
- `render.html_to_pdf`
- `artifact.bundle.media`
- `validate.artifact.contract`
- `control.replan`

---

## 4.4 Input / Output Schema Discipline

Every capability should reference explicit input and output schemas.

### Input schema example

```json
{
  "required": ["targetRef", "context"],
  "properties": {
    "targetRef": { "type": "string" },
    "context": { "type": "object" },
    "backendHints": { "type": "array" }
  }
}
```

### Output schema example

```json
{
  "required": ["status", "artifacts"],
  "properties": {
    "status": { "type": "string" },
    "artifacts": { "type": "array" },
    "checkpoint": { "type": "object" },
    "diagnostics": { "type": "array" }
  }
}
```

---

## 4.5 Side Effect Model

Side effects matter for retries and resume.

Allowed values:
- `none`
- `local-state`
- `remote-read`
- `remote-write`
- `mixed`

### Examples
- `discover.har` -> `none`
- `discover.browser.network` -> `remote-read`
- `execute.request.replay` -> `remote-read` or `remote-write`
- `artifact.bundle.media` -> `local-state`

---

## 4.6 Checkpoint Model

Checkpoint behavior determines persistence requirements.

Allowed values:
- `none`
- `recommended`
- `required`

### Examples
- expensive or branch-heavy steps should usually be `recommended` or `required`
- side-effecting write steps should often be `required`

---

# 5. Plan Schema

## 5.1 Purpose
A plan is the platform’s executable toolchain.
It is synthesized from:
- normalized intent
- evidence
- strategy ranking
- capability availability
- backend routing policy

---

## 5.2 Top-Level Plan Object

```json
{
  "version": "1.0",
  "planId": "pl_...",
  "intentId": "in_...",
  "evidenceId": "ev_...",
  "selectedStrategy": {},
  "steps": [],
  "fallbacks": [],
  "checkpoints": [],
  "validation": {},
  "routingSummary": {},
  "createdAt": "..."
}
```

---

## 5.3 Selected Strategy Object

```json
{
  "primary": "authenticated_request_replay",
  "alternatives": ["browser_action_export", "browser_render_extract"],
  "reasonCodes": [
    "stable-read-endpoint-observed",
    "auth-context-available",
    "export-surface-observed"
  ],
  "confidence": 0.81
}
```

---

## 5.4 Plan Step Schema

```json
{
  "id": "step_01",
  "capabilityId": "discover.browser.network",
  "backend": "opencli",
  "inputs": {},
  "dependsOn": [],
  "produces": ["obs.network"],
  "sideEffects": "remote-read",
  "checkpoint": "recommended",
  "retryPolicy": "safe-retry",
  "failureHandling": {
    "mode": "fallback|replan|abort",
    "fallbackStepIds": ["step_05"]
  }
}
```

### Important fields
- `capabilityId`: platform-native
- `backend`: chosen implementation source
- `dependsOn`: explicit dependency graph
- `produces`: semantic outputs, not only files
- `failureHandling`: allows deterministic fallbacks before AI-assisted re-planning

---

## 5.5 Plan Validation Section

```json
{
  "artifactContractRef": "ac.capture.article.v1",
  "requiredChecks": [
    "artifact.exists",
    "artifact.non_empty",
    "pdf.readable",
    "manifest.complete"
  ],
  "domainChecks": [
    "course.lesson.bundle.complete"
  ]
}
```

---

## 5.6 Routing Summary

```json
{
  "backendSelections": [
    {
      "capabilityId": "discover.browser.network",
      "backend": "opencli",
      "reason": "best overlap and existing capability surface"
    },
    {
      "capabilityId": "render.html_to_pdf",
      "backend": "native-render",
      "reason": "platform-owned artifact quality requirement"
    }
  ]
}
```

This keeps backend decisions explainable.

---

# 6. Backend Routing Policy

## 6.1 Purpose
Backend routing determines which implementation fulfills a capability.

It is **not** left to individual backends.
It is a platform policy decision.

---

## 6.2 Routing Inputs

Routing should consider:
- capability support
- current runtime context
- evidence-specific constraints
- side-effect risk
- output quality needs
- operational stability
- policy preference
- freedom/lock-in cost

---

## 6.3 Routing Decision Model

```json
{
  "capabilityId": "render.html_to_pdf",
  "candidates": ["native-render", "opencli"],
  "selected": "native-render",
  "reasons": [
    "artifact quality requirement",
    "platform-owned PDF contract",
    "native implementation already proven"
  ]
}
```

---

## 6.4 Routing Rules

### Rule 1 — Use OpenCLI when overlap is high and abstraction loss is low
Examples:
- browser-assisted discovery
- browser primitives
- existing site commands
- command-level adapter execution

### Rule 2 — Prefer native modules when artifact quality or output contracts are critical
Examples:
- render/PDF bundle generation
- run-meta generation
- validators
- manifest packaging

### Rule 3 — Never let backend choice redefine the plan model
The plan chooses the backend; the backend does not choose the plan.

### Rule 4 — Side-effecting write capabilities require stricter backend confidence
Because OpenCLI has known limitations around write payload capture/generation, routing for write-heavy paths should be stricter.

### Rule 5 — Capability-level fallback is preferred over run-level backend failover
Fallback should remain local to plan steps when possible.

---

# 7. AI Harness Intervention Contract

## 7.1 Purpose
The AI harness is a bounded controller, not an unbounded executor.

It may influence:
- intent clarity
- discovery completeness
- strategy ranking
- re-planning
- fallback selection

It may not break deterministic guarantees.

---

## 7.2 Intervention Modes

### `off`
- no AI intervention
- deterministic only

### `assist`
- AI may annotate, suggest, and rank
- final plan still mostly deterministic

### `explore`
- AI may request additional discovery steps
- AI may recommend plan revisions

### `orchestrate`
- AI may actively steer discovery and re-planning at bounded control points

---

## 7.3 Allowed Intervention Points

1. **intent.interpret**
2. **discover.enrich**
3. **evidence.classify**
4. **strategy.reprioritize**
5. **plan.patch**
6. **failure.recover**

---

## 7.4 AI Intervention Object

```json
{
  "id": "aii_...",
  "mode": "explore",
  "trigger": "blocking-gap-detected",
  "target": "gap_12",
  "requestedAction": "discover.additional.browser-network",
  "reason": "request body shape still unknown",
  "constraints": [
    "must-not-bypass-validation",
    "must-not-change-artifact-contract"
  ]
}
```

---

## 7.5 Forbidden AI Actions

AI may not:
- alter artifact contracts silently
- bypass validation failures
- directly redefine platform schemas
- directly mutate backend state outside approved capabilities
- claim completion without passing required validators

---

# 8. OpenCLI Wrapper Mapping Model

## 8.1 Purpose
The OpenCLI wrapper maps platform-native capabilities to OpenCLI command invocations and normalizes the results back into platform contracts.

This is the anti-corruption layer.

---

## 8.2 Wrapper Responsibilities

- capability-to-command mapping
- command argument translation
- execution invocation
- output normalization
- error normalization
- capability availability discovery
- backend metadata annotation

---

## 8.3 Example Mapping Table

| Platform Capability | OpenCLI Surface | Notes |
|---|---|---|
| `discover.browser.network` | `opencli browser network ...` | Strong candidate for wrapper use |
| `discover.browser.snapshot` | `opencli browser state/get/...` | Useful for AI-guided browsing |
| `discover.site.command.list` | `opencli list` | Can seed backend capability inventory |
| `execute.site.command` | `opencli <site> <command>` | Good when command already exists |
| `discover.browser.open` | `opencli browser open` | Browser session entry primitive |

---

## 8.4 Wrapper Result Normalization

Example OpenCLI command result should be normalized into:
- observations
- evidence enrichments
- artifacts
- diagnostics
- structured failures

### Example normalized result

```json
{
  "status": "ok",
  "backend": "opencli",
  "capabilityId": "discover.browser.network",
  "observationsAdded": ["obs_44", "obs_45"],
  "artifacts": [],
  "diagnostics": []
}
```

---

## 8.5 Error Mapping

OpenCLI errors should be mapped into platform-native classes such as:
- `backend_unavailable`
- `capability_not_supported`
- `browser_session_missing`
- `auth_context_missing`
- `command_execution_failed`
- `output_mapping_failed`

The wrapper must not leak raw backend semantics into higher layers unless included as diagnostic detail.

---

## 8.6 Capability Inventory Integration

OpenCLI should not be our capability catalog.

But the wrapper can surface OpenCLI availability as a backend inventory input:

```json
{
  "backend": "opencli",
  "availableCommands": [
    "twitter/search",
    "browser/open",
    "browser/network"
  ],
  "wrappedCapabilities": [
    "discover.browser.network",
    "execute.site.command"
  ]
}
```

This is a backend capability view, not the core platform catalog.

---

# 9. Minimal Artifact Contract Shape

Because plan execution must end in validated outputs, every plan should reference an artifact contract.

```json
{
  "id": "ac.capture.page.v1",
  "requiredArtifacts": [
    { "kind": "html", "pathRule": "page.html" },
    { "kind": "pdf", "pathRule": "page.pdf" }
  ],
  "optionalArtifacts": [
    { "kind": "manifest", "pathRule": "manifest.json" },
    { "kind": "media", "pathRule": "media/*" }
  ],
  "validators": [
    "exists",
    "non_empty",
    "readable_if_pdf"
  ]
}
```

This keeps the connection between planning and operational output explicit.

---

# 10. Example End-to-End Contract Chain

## Scenario: Protected article capture

### Step 1 — intent
```json
{
  "intentType": "capture.page",
  "outputs": ["html", "pdf", "assets"]
}
```

### Step 2 — evidence
```json
{
  "requestFamilies": ["rf_article_json"],
  "authHints": ["auth_cookie_site"],
  "strategySignals": ["cookie-context-works"]
}
```

### Step 3 — strategy
```json
{
  "primary": "authenticated_request_replay",
  "alternatives": ["browser_render_extract"]
}
```

### Step 4 — plan
```json
{
  "steps": [
    "discover.browser.network via opencli",
    "execute.request.replay via specialized backend",
    "render.html_to_pdf via native-render",
    "validate.artifact.contract via native-validation"
  ]
}
```

### Step 5 — artifact contract
```json
{
  "requiredArtifacts": ["page.html", "page.pdf"],
  "validators": ["exists", "non_empty", "readable_if_pdf"]
}
```

This is the full contract chain the platform is meant to preserve.

---

# 11. What Still Comes Next

This document defines the first contract layer, not the final implementation detail.

The next package should specify:
- concrete JSON schema definitions
- capability ID namespace conventions
- plan step retry policy matrix
- failure taxonomy object model
- checkpoint persistence format
- artifact validator registry
- initial OpenCLI wrapper capability set

---

# 12. Final Design Rule

If a backend, provider, or AI behavior cannot be expressed through these platform-native contracts, the answer is **not** to weaken the contracts.

The answer is either:
- extend the contracts carefully, or
- treat that backend/path as out of scope

That rule is what keeps the platform coherent over time.
