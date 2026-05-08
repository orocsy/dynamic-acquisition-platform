# Phase 2 Implementation Breakdown — Runtime Checkpoint and Human Intervention

**Status:** Implemented through Phase 2.6 hardening
**Parent design:** `docs/runtime-checkpoint-human-intervention-phase2.md`
**Goal:** document the Phase 2 implementation slices so each slice can be reviewed, tested, and maintained before Phase 3 browser integration.

---

## Guiding Rule

Phase 2 should not land as one large runtime rewrite.

Each sub-phase must:

1. introduce one coherent runtime capability,
2. include focused tests,
3. keep browser integration out of scope,
4. avoid storing sensitive auth material,
5. leave the repo in a shippable state after completion.

Recommended sequence:

```text
2.1 contracts + invariants
  -> 2.2 stores + token/redaction helpers
  -> 2.3 coordinator transitions
  -> 2.4 human intervention lifecycle
  -> 2.5 deterministic resume simulation
  -> 2.6 quality hardening + docs cleanup
```

## Diagrams

Editable Excalidraw sources are split into overview diagrams and implementation-level diagrams.

Overview diagrams:

- `docs/diagrams/dynamic-acquisition-platform-phase2-implementation-roadmap.excalidraw` — Phase 2.1–2.6 roadmap and quality gates
- `docs/diagrams/dynamic-acquisition-platform-phase2-2-runtime-persistence-boundary.excalidraw` — Phase 2.2 store/helper boundaries

Implementation-level diagrams:

- `docs/diagrams/dynamic-acquisition-platform-phase2-runtime-module-relations.excalidraw` — ERD-like module/data relationship diagram for runtime coordinator, stores, token/redaction helpers, checkpoints, events, and human intervention requests
- `docs/diagrams/dynamic-acquisition-platform-phase2-state-transition-flow.excalidraw` — low-level checkpoint status/phase transition flow for 2.3–2.5, including auth wait, resume, expiry, cancellation, and terminal states
- `docs/diagrams/dynamic-acquisition-platform-phase2-human-intervention-resume-sequence.excalidraw` — sequence diagram for request/complete/resume/auth-recheck/evidence continuation message order

Diagram-to-phase map:

- 2.1: contracts appear as data shapes in the module relationship diagram.
- 2.2: store/helper boundaries appear in the persistence boundary and module relationship diagrams.
- 2.3: legal coordinator transitions appear in the state transition flow diagram.
- 2.4: pause/complete/resume-entry behavior appears in the human intervention sequence diagram.
- 2.5: deterministic continuation after `auth_state_recheck` appears in both the state transition flow and sequence diagrams.
- 2.6: all diagrams must be checked against final implementation decisions before Phase 3 browser integration begins.

---

## Phase 2.1 — Runtime Contracts and State Invariants

### Purpose

Create the stable type foundation for checkpoint-first execution without implementing behavior yet.

This phase answers:

- What is a run?
- What is a checkpoint?
- What statuses and phases are legal?
- What is a human intervention request?
- What is persisted versus returned once?
- What does a runtime event look like?

### Proposed files

```text
src/runtime/types.ts
src/runtime/index.ts
src/runtime/README.md
test/runtime-types.test.js
```

If runtime types become large, split later. Do not split prematurely before the model stabilizes.

### Implementation details

Add TypeScript contracts for:

- `RunId`
- `CheckpointId` if needed, otherwise keep checkpoint keyed by `runId`
- `RunStatus`
- `RunPhase`
- `RunCheckpoint`
- `CheckpointPatch`
- `HumanInterventionKind`
- `HumanInterventionStatus`
- `HumanInterventionRequest`
- `HumanInterventionCompletion`
- `RuntimeEvent`
- `RuntimeEventType`
- `RuntimeDiagnostic`
- `RuntimeErrorCode`
- `ResumeTokenIssue`
- `ResumeTokenVerificationResult`

Recommended initial statuses:

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

Recommended initial phases:

```ts
type RunPhase =
  | 'intent_accepted'
  | 'target_opened'
  | 'auth_boundary_detected'
  | 'waiting_for_human'
  | 'auth_state_recheck'
  | 'discovering_network'
  | 'normalizing_evidence'
  | 'finalizing'
  | 'terminal';
```

### Important modeling decisions

- `RunCheckpoint` owns current materialized state.
- `RuntimeEvent` owns audit/history.
- `HumanInterventionRequest` owns human-facing wait state.
- `resumeTokenHash` may be persisted.
- raw `resumeToken` must never be persisted in checkpoint/request/event objects.
- `browserSessionRef` is opaque and must not expose profile paths, cookies, or headers.
- `version` is mandatory on checkpoint for optimistic concurrency.
- `nextStepId` is mandatory when entering `waiting_for_human`.

### Tests

Use tests mostly as contract guards:

- exported runtime types/module can be imported from `src/runtime/index.ts`
- status/phase constants or helpers expose expected values if constants are used
- checkpoint fixture can be created without unsafe fields
- intervention fixture stores token hash, not token
- runtime diagnostic fixture redacts URL query values if a helper already exists; otherwise defer to 2.2

### Definition of done

- `npm run typecheck` passes.
- `npm test` passes.
- No runtime behavior is implemented yet beyond exports/fixtures/helpers required by tests.
- Docs mention Phase 2.1 as completed before moving to 2.2.

---

## Phase 2.2 — In-Memory Stores, Token Helpers, and Redaction Helpers

### Purpose

Build the persistence boundary behind interfaces, still without full coordinator behavior.

This phase answers:

- Can checkpoints be created/read/updated safely?
- Can events be appended and listed for debugging/tests?
- Can intervention requests be stored separately from checkpoints?
- Can resume tokens be issued and verified without persisting raw tokens?
- Can diagnostics/events avoid leaking query params or credential-like values?

### Proposed files

```text
src/runtime/checkpointStore.ts
src/runtime/inMemoryCheckpointStore.ts
src/runtime/interventionStore.ts
src/runtime/inMemoryInterventionStore.ts
src/runtime/resumeToken.ts
src/runtime/runtimeRedaction.ts
test/runtime-stores.test.js
test/runtime-token-redaction.test.js
```

### Store interfaces

Checkpoint store:

```ts
interface CheckpointStore {
  create(checkpoint: RunCheckpoint): Promise<RunCheckpoint>;
  get(runId: string): Promise<RunCheckpoint | undefined>;
  update(runId: string, patch: CheckpointPatch): Promise<RunCheckpoint>;
  appendEvent(event: RuntimeEvent): Promise<void>;
  listEvents(runId: string): Promise<RuntimeEvent[]>;
  listWaiting(now: string): Promise<RunCheckpoint[]>;
}
```

Intervention store:

```ts
interface InterventionStore {
  create(request: HumanInterventionRequest): Promise<HumanInterventionRequest>;
  get(requestId: string): Promise<HumanInterventionRequest | undefined>;
  complete(input: HumanInterventionCompletion): Promise<HumanInterventionRequest>;
  expire(requestId: string, now: string): Promise<HumanInterventionRequest>;
  cancel(requestId: string, now: string): Promise<HumanInterventionRequest>;
}
```

### Implementation details

In-memory stores should:

- clone objects on read/write to avoid accidental mutation leaks,
- reject duplicate `runId` / `requestId`,
- reject updates to missing records,
- increment checkpoint `version` on update,
- preserve `createdAt`,
- update `updatedAt`,
- make terminal states explicit rather than silently overwriting them,
- keep event append order deterministic.

Resume token helpers should:

- generate high-entropy opaque tokens,
- hash tokens before persistence,
- expose a short preview for UI/debugging,
- verify candidate token against persisted hash,
- avoid logging raw tokens.

Redaction helpers should:

- sanitize URLs by removing or masking query values,
- redact likely credential keys such as `password`, `token`, `secret`, `authorization`, `cookie`, `set-cookie`, API key fields, `mfa`, `otp`,
- work recursively on shallow diagnostic/event payloads,
- be conservative: false-positive redaction is acceptable; leaks are not.

### Tests

Checkpoint store:

- create/get returns equivalent checkpoint
- get missing returns `undefined`
- duplicate create rejects
- update increments `version`
- update missing rejects
- `listWaiting(now)` returns only waiting checkpoints not terminal checkpoints
- event append/list keeps order

Intervention store:

- create/get returns equivalent request
- complete pending request succeeds with completion metadata
- duplicate complete is idempotent or structured rejection; choose one and document it
- expire pending request succeeds
- cancel pending request succeeds
- completed request cannot be expired afterward unless explicitly allowed

Token/redaction:

- issued token has hash + preview
- raw token is not equal to hash or preview
- correct token verifies
- wrong token rejects
- sanitized diagnostic removes URL query values
- credential-like keys are redacted recursively

### Definition of done

- Store tests pass without coordinator.
- Token/redaction tests pass.
- No browser, UI, websocket, or notification behavior is introduced.
- The in-memory implementation is clearly behind interfaces.

---

## Phase 2.3 — Runtime Coordinator Core Transitions

**Status:** Completed in code with focused transition/invalid-transition tests. Human intervention lifecycle remains deferred to Phase 2.4.

### Purpose

Centralize legal runtime state transitions.

This phase answers:

- Who is allowed to mutate checkpoint state?
- Which state transitions are legal?
- How are events appended consistently?
- How do stale versions and terminal states get rejected?

### Proposed files

```text
src/runtime/runtimeCoordinator.ts
src/runtime/runtimeErrors.ts
test/runtime-coordinator-transitions.test.js
test/runtime-coordinator-invalid-transitions.test.js
```

### Coordinator API for this slice

Implement only non-human core methods first:

```ts
class RuntimeCoordinator {
  createRun(input): Promise<RunCheckpoint>;
  markRunning(input): Promise<RunCheckpoint>;
  markFailed(input): Promise<RunCheckpoint>;
  markCompleted(input): Promise<RunCheckpoint>;
  markExpired(input): Promise<RunCheckpoint>;
  cancelRun(input): Promise<RunCheckpoint>;
}
```

Human-specific methods come in 2.4.

### Legal transitions for 2.3

```text
created -> running
running -> failed
running -> completed
running -> cancelled
waiting_for_human -> expired
waiting_for_human -> cancelled
expired -> failed
expired -> cancelled
```

`waiting_for_human` is included as an input state for expiry/cancel tests, but the creation of that state can still use fixtures until 2.4.

### Implementation details

Coordinator should:

- use stores rather than direct object mutation,
- require expected version when appropriate,
- append a `RuntimeEvent` for every accepted transition,
- emit structured diagnostics for rejected transitions,
- avoid throwing raw strings,
- preserve `evidenceRefs`, `artifactRefs`, and existing diagnostics unless explicitly patched,
- treat terminal statuses as terminal:
  - `failed`
  - `completed`
  - `cancelled`

### Tests

Happy path:

- `createRun` creates checkpoint + `run.created` event
- `markRunning` moves created run to running + event
- `markCompleted` moves running run to completed + event
- `markFailed` moves running run to failed + event
- `cancelRun` works from running/waiting/expired where allowed

Invalid path:

- running cannot go back to created
- completed cannot be resumed/rerun
- failed cannot become completed
- wrong expected version rejects
- unknown run rejects
- invalid transition appends no event

### Definition of done

- All legal transition tests pass.
- Invalid transition tests prove the coordinator is the gatekeeper.
- No human intervention request/completion behavior yet.

### Implementation notes

- `RuntimeCoordinator` requires `expectedVersion` for existing-run transitions and throws `RuntimeCoordinatorError` with a structured diagnostic for rejected mutations.
- Accepted transitions persist exactly one event through the same store mutation call as the checkpoint create/update; rejected transitions append no events.
- `expired` remains non-terminal so it can still transition to `failed` or `cancelled`; terminal checkpoints are `failed`, `completed`, and `cancelled`.
- Expiry preserves the `waiting_for_human` phase to keep the audit state clear until the run is terminally failed or cancelled.

---

## Phase 2.4 — Human Intervention Request, Completion, Expiry, and Resume Entry

**Status:** Completed in code with request/completion/resume-entry tests. Deterministic acquisition continuation remains deferred to Phase 2.5.

### Purpose

Implement the actual pause/resume boundary, but only up to entering `running_after_resume`. The deterministic acquisition continuation stays in 2.5.

This phase answers:

- How does a run safely pause for login/MFA/captcha/consent/decision?
- How is the raw resume token issued once?
- How does human completion update request and checkpoint state?
- How are unsafe/cancelled/expired human outcomes handled?
- How does `resumeRun` validate the checkpoint before continuing?

### Proposed files

```text
src/runtime/humanIntervention.ts
src/runtime/resumePolicy.ts
test/runtime-human-intervention.test.js
test/runtime-resume-entry.test.js
```

### Coordinator API added in this slice

```ts
requestHumanIntervention(input): Promise<{
  checkpoint: RunCheckpoint;
  request: HumanInterventionRequest;
  resumeToken: string;
}>;

completeHumanIntervention(input): Promise<{
  checkpoint: RunCheckpoint;
  request: HumanInterventionRequest;
}>;

resumeRun(input): Promise<RunCheckpoint>;
```

### Required behavior

`requestHumanIntervention` must:

- accept only a running run,
- require a `kind`, `reason`, `instructions`, `nextStepId`, and timeout/expiry,
- create resume token,
- persist only token hash + preview,
- create intervention request,
- update checkpoint to `waiting_for_human`,
- set `pendingInterventionId`, `resumeTokenHash`, `nextStepId`, and expiry,
- append `intervention.requested` + `checkpoint.updated` or a combined event pattern chosen in 2.3.

`completeHumanIntervention` must:

- validate request exists,
- validate request belongs to run,
- validate request is pending,
- verify raw resume token against hash,
- accept outcomes:
  - `completed`
  - `cancelled`
  - `unsafe`
  - `expired`
- mark request accordingly,
- for `completed`, keep checkpoint resumable,
- for `cancelled`/`unsafe`, cancel checkpoint and do not resume,
- for `expired`, mark checkpoint expired and do not resume,
- append event.

`resumeRun` must:

- accept only completed human intervention with valid run/checkpoint status,
- move checkpoint from `waiting_for_human` to `running_after_resume`,
- increment `resumeAttempts`,
- require/validate expected version,
- start from `nextStepId`, which should normally be `auth_state_recheck`,
- clear or preserve `pendingInterventionId` based on chosen audit semantics; document the choice,
- append `run.resumed`.

Recommended choice: preserve `pendingInterventionId` until the next successful checkpoint update after auth recheck, then clear it. This makes debugging easier during the fragile resume boundary.

### Tests

Request:

- running run can request login intervention
- request returns raw token once
- stored request/checkpoint contain hash, not raw token
- non-running run cannot request intervention
- request requires `nextStepId`

Completion:

- correct token completes request
- wrong token rejects without changing state
- duplicate completion is safe or structured rejection
- cancelled completion cancels run
- unsafe completion cancels run with diagnostic
- expired completion marks run/request expired

Resume:

- completed intervention can resume run
- resume moves to `running_after_resume`
- resume increments attempts
- resume starts at `auth_state_recheck`
- stale checkpoint version rejects
- cancelled/unsafe/expired intervention cannot resume

### Definition of done

- Human pause/complete/resume-entry tests pass.
- Token persistence safety is proven by tests.
- No real browser or UI subscription is introduced.

### Implementation notes

- `RuntimeCoordinator` now accepts an optional `InterventionStore`; human lifecycle methods reject with a structured coordinator error if it is not configured.
- `requestHumanIntervention` validates a running checkpoint, issues a one-time raw resume token, creates a pending request, updates the checkpoint to `waiting_for_human`, and appends `intervention.requested` through the checkpoint store's accepted-transition event path.
- `completeHumanIntervention` verifies the raw token before mutating request/checkpoint state. Duplicate completion is a structured rejection, not idempotent success.
- Human outcomes are explicit: `completed` keeps the run resumable, `cancelled`/`unsafe` cancel the run, and `expired` marks the run/request expired.
- `resumeRun` only accepts a completed request and a fresh checkpoint version, moves the run to `running_after_resume`, increments `resumeAttempts`, and requires the first resumed step to be `auth_state_recheck`.
- Pending intervention metadata is preserved through `running_after_resume` for audit/debugging; clearing it is deferred until a later successful post-auth checkpoint update.

---

## Phase 2.5 — Deterministic Resume Simulation

**Status:** Completed in code with deterministic happy-path, auth-recheck failure, cancellation, and wrong-token tests. Browser integration remains deferred to Phase 3.

### Purpose

Prove the full runtime lifecycle without launching a browser.

This phase answers:

- Can a synthetic acquisition flow pause for auth and resume deterministically?
- Does post-human auth recheck happen before evidence work continues?
- Do evidence refs, artifact refs, diagnostics, and events survive the wait/resume gap?
- Can discovery output plug into runtime without coupling runtime to browser implementation?

### Proposed files

```text
src/runtime/simulatedRuntimeFlow.ts
test/runtime-deterministic-simulation.test.js
```

Optional fixture:

```text
src/fixtures/runtime/simulated-auth-resume-flow.json
```

### Simulation flow

```text
intent accepted
  -> createRun
  -> markRunning
  -> target opened
  -> auth required detected
  -> requestHumanIntervention(kind: login-required, nextStepId: auth_state_recheck)
  -> completeHumanIntervention(result: completed)
  -> resumeRun
  -> auth_state_recheck
  -> normalize synthetic network evidence
  -> attach evidence ref
  -> markCompleted
```

### Implementation details

The simulation should be boring and explicit.

Avoid building a general workflow engine in Phase 2.5. A simple test harness/function is enough:

```ts
runDeterministicAuthenticatedSimulation(deps, fixture)
```

Dependencies should be injected:

- `RuntimeCoordinator`
- `CheckpointStore`
- `InterventionStore`
- synthetic network fixture or already-normalized discovery fixture
- clock/id providers if needed for deterministic tests

The simulation must prove:

- `auth_state_recheck` runs after resume and before evidence normalization,
- normalized evidence is attached only after successful recheck,
- failure in auth recheck does not continue to evidence normalization,
- final event order is understandable.

### Tests

Happy path:

- full lifecycle reaches completed
- event sequence includes request, completion, resume, auth recheck, completion
- final checkpoint contains evidence refs
- final checkpoint has no raw token material

Negative path:

- auth recheck failure marks failed or returns to waiting, choose one and document it
- cancelled human intervention never normalizes evidence
- wrong resume token never resumes

Recommended first negative behavior:

```text
resume -> auth_state_recheck fails -> failed
```

Later phases can add smarter re-request behavior.

### Definition of done

- Full simulation passes in `npm test`.
- Simulation uses existing network evidence normalizer rather than duplicating discovery behavior.
- Runtime is still browser-free.

### Implementation notes

- `runDeterministicAuthenticatedSimulation` is a small injected harness, not a workflow engine.
- The post-resume boundary is explicit: `resumeRun` enters `running_after_resume` at `auth_state_recheck`; `confirmResumeAuthRecheck` must pass before evidence normalization can run.
- Successful auth recheck clears pending intervention id, next step id, resume-token hash, and wait expiry metadata from the active checkpoint.
- `recordNormalizedEvidence` uses normalized evidence ids from the existing network evidence normalizer and appends an `evidence.normalized` event.
- Auth recheck failure marks the resumed run failed before normalizing evidence; cancelled human intervention and wrong resume token paths never resume.

---

## Phase 2.6 — Quality Hardening, Review, and Documentation Cleanup

**Status:** Completed in code/docs with duplicate-resume regression coverage, browser-session-ref redaction hardening, parent-doc alignment, and final verification.

### Purpose

Turn the Phase 2 slices from working code into trusted foundation.

This phase answers:

- Are contracts too broad or too narrow?
- Are types strict enough?
- Are transition rules documented and tested?
- Are sensitive fields protected by tests?
- Is `docs/todo.md` accurate after implementation?

### Proposed files to update

```text
docs/runtime-checkpoint-human-intervention-phase2.md
docs/phase2-implementation-breakdown.md
docs/todo.md
src/runtime/README.md
```

### Hardening checklist

Types:

- remove unused exported types,
- avoid `unknown` where a stable shape is now clear,
- keep `unknown` where user/domain payloads are intentionally opaque,
- ensure public APIs return readonly-ish cloned data or immutable copies where practical.

Runtime safety:

- audit all diagnostics/events for raw token leakage,
- audit URL handling for query redaction,
- audit `browserSessionRef` naming and examples,
- audit duplicate resume behavior,
- audit terminal-state behavior.

Tests:

- check happy path and at least one failure path per coordinator method,
- include regression tests for raw token non-persistence,
- include event ordering tests for the simulation,
- include version conflict tests,
- include cancellation tests.

Docs:

- update parent Phase 2 doc if implementation decisions differ,
- mark completed Phase 2 sub-slices in `docs/todo.md`,
- document any deferred decisions clearly,
- do not leave stale diagrams claiming behavior that code does not implement.

### Verification gate

Run at minimum:

```bash
npm run typecheck
npm test
npm run check
```

If `npm run check` duplicates other commands, still run it because it is the repo-level confidence gate.

### Definition of done

- All verification commands pass.
- Runtime docs match implementation.
- TODO is updated.
- Remaining Phase 3/browser work is clearly separated from Phase 2.

### Implementation notes

- Added duplicate-resume regression coverage: a second `resumeRun` call against `running_after_resume` is a structured rejection and appends no second `run.resumed` event.
- Hardened runtime redaction for `browserSessionRef`: opaque refs remain visible, but profile paths, URL/query-like strings, and cookie/header-bearing values redact to `[redacted]` in persisted checkpoints/events/diagnostics.
- Updated `docs/runtime-checkpoint-human-intervention-phase2.md` from draft sketch to implemented behavior, including `auth.rechecked`, `evidence.normalized`, completed-request resume semantics, and expired-run limitations.
- Phase 2 remains browser-free: no daemon lifecycle, real HAR capture, live UI subscription adapter, durable store, or worker queue was added.

---

## Recommended Commit Strategy

Use one commit per sub-phase unless a slice is tiny:

```text
phase2.1 runtime contracts
phase2.2 runtime stores and token redaction helpers
phase2.3 runtime coordinator transitions
phase2.4 human intervention pause/resume entry
phase2.5 deterministic authenticated resume simulation
phase2.6 runtime hardening and docs cleanup
```

This keeps review focused and makes rollback easier.

---

## Phase 2.1–2.6 Dependency Map

```text
2.1 contracts
  required by: all later slices

2.2 stores/helpers
  requires: 2.1
  required by: 2.3, 2.4

2.3 coordinator core
  requires: 2.1, 2.2
  required by: 2.4, 2.5

2.4 human intervention lifecycle
  requires: 2.1, 2.2, 2.3
  required by: 2.5

2.5 deterministic simulation
  requires: 2.1, 2.2, 2.3, 2.4, existing discovery normalizer
  required by: Phase 3 browser work

2.6 hardening
  requires: all Phase 2 implementation slices
  required by: Phase 3 confidence
```

---

## What Must Stay Out of Phase 2

Do not implement these during Phase 2 unless a later decision explicitly changes scope:

- real browser launch/attach logic,
- Chrome daemon lifecycle,
- websocket/live UI subscription adapter,
- Telegram/notification delivery adapter,
- durable SQLite/JSONL backend,
- distributed worker queue,
- authenticated HAR capture from a real site,
- provider-specific acquisition strategies,
- payment/submission side-effect replay.

Phase 2 earns the right to integrate those later by making pause/resume state reliable first.

---

## Recommended Immediate Next Step

Phase 2 is now ready for final review/commit as a browser-free runtime foundation.

Recommended next work after this checkpoint:

```text
Phase 3 browser integration design
  -> daemon runner boundary
  -> authenticated capture adapter
  -> durable checkpoint backend decision
```

Keep Phase 3 separate from this runtime foundation so any browser-specific instability does not contaminate the core pause/resume contracts.
