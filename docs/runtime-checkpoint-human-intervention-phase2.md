# Runtime Checkpoint and Human Intervention — Phase 2 Design

**Status:** Draft v0
**Phase:** 2 — runtime foundation before real browser integration
**Scope:** checkpoint lifecycle, human-intervention lifecycle, resumable continuation, deterministic simulation
**Out of scope:** Phase 3 browser/daemon integration details, real authenticated capture, strategy engine execution

---

## 1. Why This Phase Exists

Phase 1 made discovery concrete:

- synthetic network observations can be normalized into platform `Evidence`
- evidence URLs are sanitized
- auth-like network signals can be classified without leaking raw credentials
- the repo now has a TypeScript foundation

The next missing layer is not a browser yet. The next missing layer is the runtime spine:

> When an acquisition run hits login, MFA, consent, captcha, timeout, crash, or a human decision point, the platform must pause safely, persist enough state, and resume deterministically without losing evidence or pretending the run failed.

Phase 2 turns that into executable contracts and tests.

---

## 2. Design Principle

The runtime must be **checkpoint-first**, not promise-first.

Bad shape:

```text
agent starts browser
  -> awaits human login in a long live promise
  -> process dies / context compacts / tab expires
  -> state is gone
```

Target shape:

```text
run reaches auth boundary
  -> checkpoint persisted
  -> intervention request persisted
  -> notification/event emitted best-effort
  -> human completes work
  -> explicit resume command continues from checkpoint
```

The persisted checkpoint is the source of truth. Subscriptions, UI updates, message prompts, and in-memory events are delivery mechanisms only.

---

## 3. Phase 2 Deliverables

### 3.1 Runtime contracts

Add stable TypeScript contracts for:

- `RunCheckpoint`
- `RunStatus`
- `RunPhase`
- `HumanInterventionRequest`
- `HumanInterventionCompletion`
- `ResumeToken`
- `RuntimeEvent`
- `RuntimeDiagnostic`

### 3.2 Checkpoint store

Start with an in-memory implementation behind an interface:

```ts
interface CheckpointStore {
  create(checkpoint: RunCheckpoint): Promise<RunCheckpoint>;
  get(runId: string): Promise<RunCheckpoint | undefined>;
  update(runId: string, patch: CheckpointPatch): Promise<RunCheckpoint>;
  appendEvent(event: RuntimeEvent): Promise<void>;
  listWaiting(now: string): Promise<RunCheckpoint[]>;
}
```

The interface matters more than the first backend. A later durable store can replace the in-memory store without changing runtime semantics.

### 3.3 Intervention store

Track human intervention requests separately from checkpoints:

```ts
interface InterventionStore {
  create(request: HumanInterventionRequest): Promise<HumanInterventionRequest>;
  get(requestId: string): Promise<HumanInterventionRequest | undefined>;
  complete(input: HumanInterventionCompletion): Promise<HumanInterventionRequest>;
  expire(requestId: string, now: string): Promise<HumanInterventionRequest>;
}
```

A checkpoint may point to `pendingInterventionId`, but the request itself has its own lifecycle.

### 3.4 Runtime coordinator

The coordinator owns legal transitions:

- `createRun`
- `markRunning`
- `requestHumanIntervention`
- `completeHumanIntervention`
- `resumeRun`
- `markExpired`
- `markFailed`
- `markCompleted`
- `cancelRun`

No module should mutate runtime state directly around the coordinator.

### 3.5 Deterministic simulation

Add a test-only flow that proves the lifecycle without launching a real browser:

```text
intent accepted
  -> target opened
  -> auth required detected
  -> human intervention requested
  -> human intervention completed
  -> auth state rechecked
  -> network evidence normalized
  -> completed
```

This keeps Phase 2 testable and avoids dragging Phase 3 browser complexity into the runtime foundation.

---

## 4. Core State Model

### 4.1 Run statuses

```ts
type RunStatus =
  | 'created'
  | 'running'
  | 'waiting_for_human'
  | 'running_after_resume'
  | 'expired'
  | 'failed'
  | 'completed'
  | 'cancelled';
```

`waiting_for_human` and `expired` are not fatal states.

`cancelled` is intentionally included in Phase 2. It was missing from the first sketch, but it is needed because a human may decide not to continue after seeing a login wall, captcha, payment boundary, or unsafe target.

### 4.2 Checkpoint shape

```ts
type RunCheckpoint = {
  runId: string;
  status: RunStatus;
  phase: RunPhase;

  intentSnapshot: unknown;
  evidenceRefs: string[];
  artifactRefs: string[];

  browserSessionRef?: string;
  pendingInterventionId?: string;
  lastCompletedStepId?: string;
  nextStepId?: string;

  resumeTokenHash?: string;
  resumeAttempts: number;
  version: number;

  diagnostics: RuntimeDiagnostic[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};
```

Important additions beyond the earlier draft:

- `version` for optimistic concurrency and duplicate-resume protection
- `resumeAttempts` for retry control
- `nextStepId` so resume is explicit, not guessed
- `resumeTokenHash` instead of storing raw resume tokens
- `cancelled` status for safe human stop paths

### 4.3 Event log plus latest checkpoint

The checkpoint is the latest materialized view. Runtime events provide audit and replay context.

```ts
type RuntimeEvent = {
  id: string;
  runId: string;
  type:
    | 'run.created'
    | 'checkpoint.updated'
    | 'intervention.requested'
    | 'intervention.completed'
    | 'intervention.expired'
    | 'run.resumed'
    | 'run.failed'
    | 'run.completed'
    | 'run.cancelled';
  at: string;
  data: Record<string, unknown>;
};
```

For Phase 2, event storage can be in-memory. The contract should already assume append-only semantics.

---

## 5. Human Intervention Lifecycle

### 5.1 Request shape

```ts
type HumanInterventionRequest = {
  id: string;
  runId: string;
  kind:
    | 'login-required'
    | 'mfa-required'
    | 'consent-required'
    | 'captcha-required'
    | 'decision-required';

  status: 'pending' | 'completed' | 'expired' | 'cancelled';
  url?: string;
  reason: string;
  instructions: string[];

  resumeTokenPreview: string;
  resumeTokenHash: string;
  safeToRetry: boolean;
  timeoutMs: number;

  createdAt: string;
  expiresAt: string;
  completedAt?: string;
  cancelledAt?: string;
};
```

The raw `resumeToken` is returned once to the caller/UI layer. Persistent storage keeps only `resumeTokenHash` and a short preview for debugging.

### 5.2 Completion shape

```ts
type HumanInterventionCompletion = {
  requestId: string;
  runId: string;
  resumeToken: string;
  result: 'completed' | 'cancelled' | 'unsafe' | 'expired';
  completedBy: 'human' | 'agent' | 'system';
  browserSessionRef?: string;
  notes?: string;
  completedAt: string;
};
```

Completion does not automatically mean acquisition should blindly continue. It means the runtime may attempt a controlled resume.

### 5.3 Required post-human verification

After a human completes login/MFA/captcha/consent, the first resumed step must be a verification step:

```text
human completed
  -> running_after_resume
  -> auth_state_recheck
  -> continue only if access is actually available
```

The runtime must not assume that human completion means auth succeeded. Cookies may still be missing, MFA may fail, captcha may remain, or the page may have navigated to an unsafe flow.

---

## 6. Subscribe vs Explicit Resume

The continuation model should be:

> evented notification, explicit resume, checkpoint-backed recovery.

### 6.1 What subscribes

Subscriptions are useful for delivery and UI:

- Control UI can subscribe to `intervention.requested` to show a waiting card.
- A message layer can subscribe to send Sean a prompt.
- A worker can subscribe to `intervention.completed` to enqueue resume.
- A dashboard can subscribe to `checkpoint.updated` for live status.

### 6.2 What does not depend on subscription

The acquisition run must not depend on a long-lived subscription to survive.

If the process restarts, gateway refreshes, context compacts, or a worker crashes, the runtime should recover by querying persistent state:

```text
list waiting/expired/completed intervention records
  -> find resumable checkpoints
  -> call resumeRun(runId, resumeToken or trusted completion ref)
```

For Phase 2 implementation, an in-memory event bus is fine for tests. The contract should still be designed so a durable event bus or queue can be added later.

### 6.3 Recommended API boundary

```ts
requestHumanIntervention(input)
  -> persists checkpoint + request
  -> emits intervention.requested
  -> returns request + one-time raw resumeToken

completeHumanIntervention(input)
  -> validates token hash and request status
  -> marks request completed/cancelled/unsafe
  -> updates checkpoint
  -> emits intervention.completed

resumeRun(input)
  -> validates checkpoint status/version
  -> moves to running_after_resume
  -> starts at nextStepId, usually auth_state_recheck
```

The key point: **subscribe is a convenience path; `resumeRun` is the durable continuation path.**

---

## 7. Runtime State Machine

Editable diagram source:

- `docs/diagrams/dynamic-acquisition-platform-phase2-runtime-lifecycle.excalidraw`

Text version:

```text
created
  -> running
  -> waiting_for_human
  -> running_after_resume
  -> completed

running
  -> failed
  -> cancelled

waiting_for_human
  -> expired
  -> cancelled

expired
  -> waiting_for_human
  -> failed
  -> cancelled
```

Every transition should append a `RuntimeEvent` and update the checkpoint version.

---

## 8. Human Resume Sequence

Editable diagram source:

- `docs/diagrams/dynamic-acquisition-platform-phase2-human-resume-sequence.excalidraw`

Text version:

```text
RuntimeCoordinator
  -> CheckpointStore: persist waiting checkpoint
  -> InterventionStore: create request + token hash
  -> EventBus/UI: emit intervention.requested
  -> Human: perform login/MFA/captcha/decision
  -> Runtime API: completeHumanIntervention(...resumeToken)
  -> CheckpointStore: mark running_after_resume
  -> RuntimeCoordinator: resumeRun
  -> Acquisition step: auth_state_recheck
  -> Discovery: continue evidence capture/normalization
```

---

## 9. Safety and Privacy Requirements

Phase 2 must enforce these before real browser work begins:

1. Never store raw passwords, API keys, session cookies, auth headers, MFA codes, or captcha answers.
2. Store only `resumeTokenHash`, never raw `resumeToken`, after issuing it.
3. Redact URL query values in runtime diagnostics just like evidence URLs.
4. Treat `browserSessionRef` as opaque; do not serialize profile paths or cookie material into public artifacts.
5. Human intervention may ask the human to act, but must not instruct bypassing MFA, defeating captcha, guessing passwords, or evading access controls.
6. If the next resumed step is side-effecting, require idempotency or explicit confirmation before replay.
7. Duplicate completion/resume attempts must be idempotent or rejected with a structured diagnostic.

---

## 10. Phase 2 Test Plan

Add tests for:

### Checkpoint lifecycle

- created -> running
- running -> waiting_for_human
- waiting_for_human -> running_after_resume
- running_after_resume -> completed
- waiting_for_human -> expired
- waiting_for_human -> cancelled
- expired is resumable and not equivalent to failed

### Intervention lifecycle

- request generation creates token preview + hash
- raw token is not stored in persistent request/checkpoint objects
- completion validates token hash
- duplicate completion is safe
- cancellation does not resume acquisition
- timeout marks request expired and checkpoint expired

### Resume behavior

- resume starts at `nextStepId`
- first resumed step is `auth_state_recheck`
- evidenceRefs/artifactRefs/diagnostics survive wait/resume
- stale version or wrong token rejects resume

### Safety checks

- credential-like input does not appear in diagnostics/events
- URL query values are sanitized
- auth/captcha/MFA instructions stay within allowed human-assisted boundaries

### Simulation

A deterministic test should cover the full happy path without a real browser:

```text
intent accepted
  -> auth boundary
  -> intervention requested
  -> intervention completed
  -> auth rechecked
  -> network fixture normalized
  -> completed
```

---

## 11. Implementation Order

Recommended order for the actual Phase 2 code slice:

1. `src/runtime/types.ts`
2. in-memory `CheckpointStore` and `InterventionStore`
3. token generation/hash/redaction helpers
4. `RuntimeCoordinator` transition methods
5. human intervention request/completion helpers
6. deterministic runtime simulation test
7. safety/redaction tests
8. docs/todo cleanup after verification

Do not add real browser behavior until this passes cleanly.

---

## 12. Future Work After Phase 2 Stabilizes

These are intentionally not Phase 2 implementation requirements:

- durable checkpoint backend, likely JSONL or SQLite first
- UI/websocket subscription adapter for live waiting cards
- message notification adapter for human prompts
- browser daemon integration
- authenticated HAR capture
- request replay provider tests
- distributed worker queue
- metrics and run timeline UI
- multi-user authorization around intervention completion

The Phase 2 contract should leave room for these without implementing them now.

---

## 13. Open Design Notes Added During Review

The first sketch missed several runtime-hardening details. Phase 2 should include them now because they affect the contract shape:

1. **Cancellation path:** human must be able to stop safely.
2. **Token hashing:** raw resume tokens should not be persisted.
3. **Event log:** checkpoint alone is not enough for audit/debug/replay.
4. **Optimistic versioning:** prevents stale duplicate resumes.
5. **Post-human auth recheck:** human completion is not proof of success.
6. **Notification is best-effort:** subscription cannot be the source of truth.
7. **Side-effect fence:** resumed mutation/payment/submit steps need idempotency or confirmation.
8. **Opaque session refs:** runtime can reference a browser/session without leaking cookies/profile internals.

These are cheap to design now and expensive to retrofit after real browser integration.
