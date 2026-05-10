# Phase 3 Browser Daemon Integration Design — Runtime Meets Real Browser

**Status:** Draft v0 — docs-first, pre-implementation
**Phase:** 3
**Depends on:** Phase 2 runtime checkpoint/human-intervention foundation
**Parent docs:**
- `docs/runtime-checkpoint-human-intervention-phase2.md`
- `docs/phase2-implementation-breakdown.md`
- `docs/stable-chrome-daemon.md`
- `docs/authenticated-runtime-and-resume.md`

---

## 1. Goal

Phase 3 connects the Phase 2 runtime spine to a real, dedicated browser daemon.

The goal is not “browser automation everywhere”. The goal is:

> use a stable Chrome daemon as an execution and discovery backend while preserving the platform-owned runtime, evidence, artifact, and safety contracts.

Phase 2 proved that a run can pause, persist state, request human intervention, resume, recheck auth, normalize evidence, and complete without a browser. Phase 3 replaces the deterministic simulation boundary with real browser daemon capture, but must not weaken the checkpoint-first runtime model.

---

## 2. Phase 3 Success Criteria

Phase 3 is successful when the platform can:

1. start or attach to a dedicated Chrome daemon,
2. create or select a page target deterministically,
3. navigate to a target URL,
4. observe network events through CDP or equivalent capture,
5. normalize captured network observations into existing `Evidence`,
6. detect auth boundaries and request human intervention through the Phase 2 coordinator,
7. resume after explicit human completion,
8. recheck auth state before continuing,
9. preserve opaque browser session/page refs without leaking profile paths, cookies, headers, or tokens,
10. make daemon mode the default routine execution route,
11. keep `profile=user` / live-browser attach as explicit manual bridge mode only.

---

## 3. Non-Goals

Phase 3 should not yet:

- build a full strategy engine,
- synthesize provider adapters,
- generate OpenCLI commands,
- implement every public/cookie/header/intercept/ui backend,
- make product-specific capture flows first-class core logic,
- persist raw cookies, auth headers, credentials, screenshots, HARs, or profile paths in runtime checkpoints,
- use Sean's daily Chrome profile as the default automation target.

Phase 3 may include minimal fixtures or examples, but production product flows should remain downstream adapters until core browser runtime boundaries stabilize.

---

## 4. Guiding Principles

### 4.1 Daemon-first, user-browser-last

Routine automation defaults to a dedicated Chrome daemon.

`profile=user` exists only for explicit bridge/discovery work where Sean knowingly wants live-user-session context. It must not be the default path for recurring jobs or platform tests.

### 4.2 Checkpoint-first, browser-second

The browser is a capability backend. It is not the source of truth.

The Phase 2 `RuntimeCoordinator` remains the only legal owner of run lifecycle mutation.

### 4.3 Opaque browser references only

Runtime state may contain opaque refs such as:

```text
browserSessionRef: daemon:local:9333/session/<opaque-id>
pageTargetRef: cdp-target:<opaque-id>
```

It must not contain:

- Chrome profile directory paths,
- cookies,
- authorization headers,
- raw CDP websocket URLs if they expose local details beyond what is necessary,
- user account names,
- raw resume tokens,
- query parameters with secrets.

### 4.4 Browser capture emits raw observations; discovery emits Evidence

The browser bridge should capture request/response/page facts in a neutral intermediate shape.

Existing discovery modules then normalize those facts into `Evidence`.

Do not let browser/CDP vocabulary leak into platform-level contracts except through provenance metadata.

### 4.5 Human resume requires auth recheck

After Sean completes login/MFA/captcha/consent, the runtime must not assume success.

The resume path is:

```text
completeHumanIntervention
  -> resumeRun
  -> running_after_resume/auth_state_recheck
  -> browser auth recheck
  -> confirmResumeAuthRecheck
  -> continue capture/evidence
```

---

## 5. Proposed Phase 3 Architecture

```text
Intent / Run Request
        |
        v
RuntimeCoordinator  <------------------------------------+
        |                                                |
        | owns checkpoint + intervention lifecycle         |
        v                                                |
BrowserRuntimeAdapter                                    |
        |                                                |
        | uses                                            |
        v                                                |
BrowserDaemonClient  ---> Chrome daemon health/start      |
        |                                                |
        v                                                |
PageTargetController ---> create/select/navigate target   |
        |                                                |
        v                                                |
NetworkCaptureSession ---> raw browser observations       |
        |                                                |
        v                                                |
Network Evidence Normalizer ---> Evidence[]              |
        |                                                |
        +--> RuntimeCoordinator.recordNormalizedEvidence--+
```

Key boundary: `BrowserRuntimeAdapter` can ask the coordinator to transition state, but cannot mutate checkpoints directly.

---

## 6. New Runtime Concepts

### 6.1 BrowserDaemonRef

Opaque description of the daemon endpoint the platform selected.

```ts
type BrowserDaemonRef = {
  kind: 'local-chrome-daemon';
  id: string;
  healthUrlPreview: string;
  mode: 'dedicated-daemon';
};
```

Rules:

- `healthUrlPreview` may be safe and local, e.g. `http://127.0.0.1:9333/json/version`.
- Do not persist websocket debugger URLs in checkpoints.
- Do not persist profile directory paths.

### 6.2 BrowserSessionRef

Opaque runtime ref persisted only as a resumable handle.

```ts
type BrowserSessionRef = string;
```

Example:

```text
daemon:local:9333/session/run_abc123
```

It should be produced by a helper, not manually concatenated across modules.

### 6.3 PageTargetRef

Opaque page target ref used by browser adapter internals.

```ts
type PageTargetRef = string;
```

Rules:

- can be stored in browser adapter state or a browser session registry,
- may be summarized in checkpoint diagnostics only after redaction,
- should survive resume only if the daemon and target remain valid,
- invalid/stale target should trigger a controlled restart from the last safe checkpoint.

### 6.4 BrowserObservation

Intermediate capture shape before platform evidence normalization.

```ts
type BrowserObservation = {
  id: string;
  runId: string;
  source: 'cdp' | 'playwright' | 'daemon-fixture';
  capturedAt: string;
  pageTargetRef?: string;
  request?: {
    url: string;
    method: string;
    headersPreview?: Record<string, string>;
    resourceType?: string;
  };
  response?: {
    status?: number;
    mimeType?: string;
    headersPreview?: Record<string, string>;
  };
  timing?: {
    startedAt?: string;
    durationMs?: number;
  };
};
```

`headersPreview` must be redacted before persistence or diagnostics. Raw secret-bearing headers are not platform evidence.

---

## 7. Primary Flow: Public or Already-Authenticated Capture

```text
createRun
  -> markRunning(target_opened)
  -> ensure daemon healthy
  -> create/select page target
  -> navigate target URL
  -> capture network observations
  -> normalize observations into Evidence
  -> recordNormalizedEvidence
  -> markCompleted
```

Definition of done for this flow:

- no human intervention required,
- no live user browser attachment,
- evidence normalization reuses existing discovery module,
- checkpoint event order is deterministic,
- tests can run against fixtures without launching Chrome,
- one manual/dev integration path can run against a local daemon.

---

## 8. Primary Flow: Auth Boundary and Resume

```text
createRun
  -> markRunning(target_opened)
  -> ensure daemon healthy
  -> navigate target URL
  -> detect login/MFA/consent/captcha boundary
  -> requestHumanIntervention(kind, instructions, browserSessionRef)
  -> wait outside the agent/browser call stack
  -> human completes action
  -> completeHumanIntervention(rawResumeToken)
  -> resumeRun
  -> browser auth state recheck
  -> confirmResumeAuthRecheck
  -> capture network observations
  -> normalize observations into Evidence
  -> recordNormalizedEvidence
  -> markCompleted
```

Important: completion is not continuation. Human completion only makes the checkpoint resumable. `resumeRun` and auth recheck are explicit runtime actions.

---

## 9. Auth Boundary Signals

Phase 3 only needs conservative detection.

Potential signals:

- HTTP `401`, `403`, or redirect to login path,
- login form visible in page snapshot,
- MFA/OTP/captcha/consent text visible,
- known auth endpoints or token-refresh failures,
- navigation lands on account chooser,
- expected content API returns unauthorized/empty-with-auth-hint.

Do not over-classify. If unsure, record a diagnostic and either fail safely or request explicit human decision.

---

## 10. Failure and Recovery Semantics

| Failure | Runtime behavior |
|---|---|
| Daemon unavailable | fail or request operator action; do not fallback to `profile=user` silently |
| Daemon starts but health check fails | fail with daemon diagnostic |
| Page target creation fails | fail before navigation; no partial evidence |
| Navigation timeout | checkpoint diagnostic; retry only if policy allows |
| Auth boundary detected | `waiting_for_human` via coordinator |
| Human cancels or marks unsafe | cancel run terminally |
| Human completes but auth recheck fails | fail from `running_after_resume`; do not normalize evidence |
| Target/page stale after resume | recreate target from checkpoint if safe; otherwise request human or fail |
| Secret-like data observed | redact before checkpoint/event/diagnostic persistence |
| Browser crash mid-run | preserve checkpoint; later retry starts from last safe phase |

---

## 11. Module Boundary Proposal

```text
src/browser/
  README.md
  types.ts
  daemonClient.ts
  chromeDaemonClient.ts
  pageTargetController.ts
  networkCaptureSession.ts
  browserObservation.ts
  browserRuntimeAdapter.ts
  browserRedaction.ts

src/runtime/
  # existing Phase 2 code remains source of truth

src/discovery/network/
  # existing normalizer accepts browser observations after mapping

test/browser-daemon-client.test.js
 test/browser-observation-normalizer.test.js
 test/browser-runtime-adapter-fixture.test.js
 test/browser-auth-resume-flow.test.js
```

Keep actual daemon launch scripts outside core until the interface is stable. Phase 3 may call an existing script through a dev adapter, but core contracts should not depend on a shell path.

---

## 12. Testing Strategy

Use three tiers:

1. **Pure unit tests** — daemon/page/network interfaces using fake clients.
2. **Fixture integration tests** — browser observation fixtures map into existing `Evidence` contracts.
3. **Manual/dev daemon smoke test** — optional local Chrome daemon check, not required for CI by default.

No test should require Sean's real Chrome session.

---

## 13. Security Rules

- Never persist raw cookies, headers, tokens, passwords, MFA/OTP, or captcha payloads.
- Never make `profile=user` the default fallback.
- Redact browser diagnostics before checkpoint/event storage.
- Keep browser refs opaque.
- Human instructions should be specific but not credential-seeking.
- Runtime should support explicit cancellation when the target looks unsafe.

---

## 14. Documentation Deliverables for Phase 3

This design is paired with the committed markdown docs:

- `docs/phase3-implementation-breakdown.md`
- `docs/phase3-low-level-design.md`
- `docs/browser-daemon-runtime-boundary.md`
- `docs/phase3-testing-validation-plan.md`

Optional Excalidraw sketches may exist locally during design, but they are not required for the Phase 3 markdown documentation package.

---

## 15. Open Questions

1. Should the first real daemon adapter use direct raw CDP only, or keep Playwright as an optional implementation behind the same interface?
2. Should browser session refs be persisted in checkpoint only, or also in a separate browser-session registry?
3. What is the smallest manual smoke test that proves daemon capture without making CI brittle?
4. Which downstream workflow should be the first adapter consumer after core Phase 3 passes fixture tests?
5. Should OpenCLI be tested as a backend in Phase 3, or deferred until Phase 4 strategy/backend composition?

