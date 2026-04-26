# Dynamic Acquisition Platform — Schemas v0

**Status:** Draft v0  
**Purpose:** Define the first machine-readable contract shapes for platform-owned acquisition workflows.

---

## 1. Design rules

- Contracts are platform-owned and backend-neutral.
- Provider-specific identifiers must stay in `externalIds`, `metadata`, or adapter-owned fields.
- Every executable step names a stable platform capability ID.
- Every object carries enough provenance for debugging and replay.
- Failures are structured so the runtime can retry, fallback, or re-plan.

---

## 2. Shared conventions

### IDs

IDs are opaque strings with type prefixes:

- `intent_...`
- `evidence_...`
- `entity_...`
- `obs_...`
- `plan_...`
- `step_...`
- `artifact_...`
- `failure_...`

### Timestamps

Use ISO-8601 UTC strings.

### Confidence

Confidence is a number from `0` to `1`.

### Capability IDs

Capability IDs use dot-separated platform semantics:

```text
<domain>.<subdomain>.<action>[.<variant>]
```

Examples:

- `discover.browser.network.capture`
- `evidence.request_family.infer`
- `strategy.acquire.select`
- `plan.acquire.build`
- `execute.request.replay`
- `artifact.bundle.write`
- `validate.artifact.contract`

---

## 3. `Intent`

Represents the normalized acquisition objective.

```json
{
  "version": "0.1",
  "intentId": "intent_01",
  "kind": "acquire",
  "target": {
    "kind": "url",
    "value": "https://example.com/resource",
    "scope": "single-resource"
  },
  "objective": {
    "action": "capture",
    "outputs": ["html", "pdf", "metadata"],
    "quality": "production"
  },
  "constraints": {
    "authMode": "unknown",
    "allowBrowser": true,
    "allowRequestReplay": true,
    "allowAI": false,
    "deadlineMs": 300000
  },
  "context": {
    "workflowId": "workflow_01",
    "requester": "local"
  },
  "timestamps": {
    "createdAt": "2026-04-27T00:00:00.000Z"
  }
}
```

### Required fields

- `version`
- `intentId`
- `kind`
- `target.kind`
- `target.value`
- `objective.action`
- `objective.outputs`

---

## 4. `Evidence`

Represents normalized knowledge about a target.

```json
{
  "version": "0.1",
  "evidenceId": "evidence_01",
  "intentId": "intent_01",
  "target": {
    "kind": "url",
    "value": "https://example.com/resource",
    "scope": "single-resource"
  },
  "entities": [
    {
      "id": "entity_01",
      "kind": "document",
      "label": "Primary content document",
      "externalIds": {},
      "attributes": {
        "title": "Example Resource"
      },
      "confidence": 0.8,
      "sources": ["obs_01"]
    }
  ],
  "observations": [
    {
      "id": "obs_01",
      "kind": "network-request",
      "summary": "Observed candidate content endpoint",
      "source": {
        "kind": "har",
        "ref": "fixture.har"
      },
      "data": {
        "method": "GET",
        "urlPattern": "https://example.com/api/resource/*",
        "status": 200
      },
      "confidence": 0.72,
      "timestamp": "2026-04-27T00:00:00.000Z"
    }
  ],
  "requestFamilies": [
    {
      "id": "request_family_01",
      "purpose": "content-fetch",
      "method": "GET",
      "urlPattern": "https://example.com/api/resource/*",
      "authSignals": ["cookie"],
      "sources": ["obs_01"],
      "confidence": 0.7
    }
  ],
  "strategySignals": [
    {
      "kind": "request-replay-candidate",
      "strength": 0.7,
      "sources": ["obs_01"]
    }
  ],
  "gaps": [],
  "provenance": [
    {
      "kind": "har-analysis",
      "tool": "dynamic-acquisition-platform",
      "timestamp": "2026-04-27T00:00:00.000Z"
    }
  ]
}
```

### Required fields

- `version`
- `evidenceId`
- `target`
- `observations`
- `provenance`

---

## 5. `Plan`

Represents an ordered acquisition plan.

```json
{
  "version": "0.1",
  "planId": "plan_01",
  "intentId": "intent_01",
  "evidenceId": "evidence_01",
  "status": "draft",
  "strategy": {
    "kind": "request-replay-first",
    "rationale": "Network evidence contains a replayable content endpoint.",
    "confidence": 0.7
  },
  "steps": [],
  "expectedArtifacts": [
    {
      "kind": "html",
      "required": true
    },
    {
      "kind": "metadata",
      "required": true
    }
  ],
  "risk": {
    "level": "medium",
    "reasons": ["auth-dependent"]
  },
  "timestamps": {
    "createdAt": "2026-04-27T00:00:00.000Z"
  }
}
```

### Required fields

- `version`
- `planId`
- `intentId`
- `status`
- `strategy.kind`
- `steps`

---

## 6. `PlanStep`

Represents one executable step in a plan.

```json
{
  "stepId": "step_01",
  "capabilityId": "execute.request.replay",
  "backendPolicy": {
    "preferred": "native",
    "fallbacks": ["browser"]
  },
  "inputs": {
    "requestFamilyId": "request_family_01"
  },
  "outputs": [
    {
      "name": "rawResponse",
      "kind": "json"
    }
  ],
  "preconditions": [
    {
      "kind": "auth-context-present",
      "required": true
    }
  ],
  "onFailure": {
    "retry": {
      "maxAttempts": 2
    },
    "fallback": "discover.browser.network.capture"
  }
}
```

### Required fields

- `stepId`
- `capabilityId`
- `backendPolicy.preferred`
- `inputs`
- `outputs`

---

## 7. `ArtifactContract`

Represents expected and produced outputs.

```json
{
  "version": "0.1",
  "artifactId": "artifact_01",
  "planId": "plan_01",
  "kind": "bundle",
  "status": "ready",
  "items": [
    {
      "kind": "html",
      "path": "artifacts/page.html",
      "required": true,
      "contentType": "text/html",
      "checks": [
        {
          "kind": "non-empty",
          "passed": true
        }
      ]
    }
  ],
  "manifest": {
    "path": "artifacts/manifest.json"
  },
  "validation": {
    "status": "passed",
    "checks": []
  },
  "timestamps": {
    "createdAt": "2026-04-27T00:00:00.000Z"
  }
}
```

### Required fields

- `version`
- `artifactId`
- `kind`
- `status`
- `items`

---

## 8. `StructuredFailure`

Represents a runtime or planning failure in a resumable form.

```json
{
  "version": "0.1",
  "failureId": "failure_01",
  "kind": "execution-failed",
  "severity": "recoverable",
  "scope": {
    "planId": "plan_01",
    "stepId": "step_01"
  },
  "code": "AUTH_CONTEXT_MISSING",
  "message": "Required auth context was unavailable.",
  "retryable": true,
  "fallbackCandidates": [
    "discover.browser.storage.capture",
    "discover.browser.network.capture"
  ],
  "evidenceRefs": ["obs_01"],
  "diagnostics": {
    "backend": "native",
    "attempt": 1
  },
  "timestamps": {
    "createdAt": "2026-04-27T00:00:00.000Z"
  }
}
```

### Required fields

- `version`
- `failureId`
- `kind`
- `severity`
- `code`
- `message`
- `retryable`

---

## 9. v0 implementation notes

The first code implementation should keep validation simple:

- no external schema dependency yet
- plain JavaScript modules exporting schema metadata and `validate*` helpers
- fixtures should be neutral and synthetic
- adapters should not exist until contracts pass basic fixture tests
