# Runtime

Execution/checkpoint/retry primitives live here.

Do not start by building a full browser runtime. First prove that contracts and discovery output can drive a small plan.

## Phase 2.1 Scope

Phase 2.1 only defines runtime contracts and state invariants:

- run statuses and phases
- checkpoint shape
- human intervention request/completion shape
- runtime events and diagnostics
- resume-token issue/verification result contracts

Behavioral implementations stay out of this slice. Stores, token generation, redaction, coordinator transitions, and deterministic simulations belong to later Phase 2 slices.

Important invariants:

- persisted checkpoint and intervention request contracts may contain `resumeTokenHash` and `resumeTokenPreview`, but not the raw `resumeToken`
- the raw token appears only on input/output boundary types that intentionally issue or verify it
- `waiting_for_human` checkpoints must include `pendingInterventionId`, `nextStepId`, `resumeTokenHash`, and `expiresAt`
- terminal checkpoints must use `phase: 'terminal'`
- pending intervention requests cannot include completion/cancellation timestamps
- completed/cancelled intervention requests must include the matching timestamp
- runtime event and diagnostic payloads are typed as JSON-safe data and must be redacted before persistence

## Phase 2.2 Scope

Phase 2.2 adds the persistence boundary and safety helpers, still without a coordinator or browser runtime:

- `CheckpointStore` interface and `InMemoryCheckpointStore`
- `InterventionStore` interface and `InMemoryInterventionStore`
- `RuntimeStoreError` for structured store failures
- resume-token issue/hash/preview/verify helpers
- runtime URL/data redaction helpers

The in-memory stores clone records on read/write, reject duplicate and missing records, keep event order deterministic, increment checkpoint versions on update, reject terminal checkpoint mutation, redact runtime diagnostics/events before persistence, and strip unexpected top-level sensitive fields such as raw `resumeToken` before storing records. Waiting checkpoints can transition terminally; pending intervention/resume fields are cleared as part of that transition.

## Phase 2.3 Scope

Phase 2.3 adds `RuntimeCoordinator`, the checkpoint mutation gatekeeper for non-human core transitions:

- `createRun`
- `markRunning`
- `markFailed`
- `markCompleted`
- `markExpired`
- `cancelRun`

Coordinator transitions use `CheckpointStore` rather than direct mutation, require `expectedVersion` for existing-run transitions, and persist the accepted transition event through the store's checkpoint mutation call so the in-memory implementation commits checkpoint/event together. They reject unknown runs, stale versions, invalid transitions, and terminal-state mutations with `RuntimeCoordinatorError` plus a structured diagnostic. Rejected transitions do not append events or mutate checkpoints.

Human intervention request/completion/resume behavior remains out of scope until Phase 2.4. Phase 2.3 only allows waiting checkpoints from fixtures/stores to expire or cancel so the transition rules can be proven before human lifecycle code exists.

## Phase 2.4 Scope

Phase 2.4 adds the checkpoint-backed human pause/resume boundary:

- `RuntimeCoordinator.requestHumanIntervention`
- `RuntimeCoordinator.completeHumanIntervention`
- `RuntimeCoordinator.resumeRun`
- `humanIntervention.ts` for lifecycle input/output contracts and timeout helpers
- `resumePolicy.ts` for the required resume-entry policy

The coordinator now issues a raw resume token exactly once at request time, persists only the hash/preview through the intervention request and checkpoint, and verifies the raw token before accepting human completion. Completion outcomes are explicit:

- `completed` keeps the checkpoint in `waiting_for_human` and makes it resumable.
- `cancelled` cancels the run and clears pending resume fields through terminal checkpoint cleanup.
- `unsafe` cancels the run with an `unsafe-human-result` diagnostic.
- `expired` marks the request/run expired while preserving wait metadata for audit.

`resumeRun` only accepts a completed human intervention, requires the expected checkpoint version, moves the checkpoint to `running_after_resume`, increments `resumeAttempts`, and starts at `auth_state_recheck`. The pending intervention id, next step id, token hash, and expiry are intentionally preserved during this fragile resume-entry state for audit/debugging; a later successful post-auth checkpoint update can clear them.

No browser, UI subscription, queue, or real acquisition continuation is introduced in this slice. Phase 2.5 owns deterministic post-resume simulation.

## Phase 2.5 Scope

Phase 2.5 proves the full authenticated resume lifecycle with a deterministic, browser-free simulation:

- create a run and detect the auth boundary,
- request and complete human login intervention,
- resume into `running_after_resume` at `auth_state_recheck`,
- explicitly confirm the auth recheck before evidence work,
- normalize synthetic network evidence with the existing discovery normalizer,
- attach evidence refs and complete the run.

`runDeterministicAuthenticatedSimulation` is intentionally a small harness, not a workflow engine. It injects the coordinator, checkpoint store, and optional normalizer so tests can prove event ordering and negative paths without browser coupling.

New post-resume coordinator transitions are narrow:

- `confirmResumeAuthRecheck` accepts only `running_after_resume`, moves back to `running`, records `auth.rechecked`, and clears pending resume metadata.
- `recordNormalizedEvidence` accepts only `running`, records `evidence.normalized`, and attaches normalized evidence refs.
- `markFailed` can now fail a `running_after_resume` checkpoint so an auth recheck failure stops before evidence normalization.

The simulation proves cancelled human intervention, wrong resume tokens, and failed auth rechecks do not continue into evidence normalization.


## Phase 2.6 Scope

Phase 2.6 hardens the Phase 2 runtime foundation and aligns docs with implemented behavior before Phase 3 browser work begins.

Hardening decisions:

- Duplicate resume attempts are structured rejections. Once a checkpoint is `running_after_resume`, a second `resumeRun` call appends no extra `run.resumed` event and leaves state unchanged.
- Runtime redaction preserves opaque `browserSessionRef` values, but redacts path-like, query-like, cookie/header-bearing, or profile-looking values before persistence.
- Terminal checkpoint cleanup clears pending intervention id, next step id, resume-token hash, and wait expiry metadata.
- Parent docs now reflect actual implemented transitions: `auth.rechecked`, `evidence.normalized`, and failed auth recheck from `running_after_resume`.

Verification gate for the hardened foundation:

```bash
npm run typecheck
npm test
npm run check
```

Phase 3 browser integration should build on these contracts without adding daemon/browser behavior back into Phase 2.
