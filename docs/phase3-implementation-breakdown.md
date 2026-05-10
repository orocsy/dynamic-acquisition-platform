# Phase 3 Implementation Breakdown — Browser Daemon Integration

**Status:** Draft v0 — docs-first, pre-implementation
**Parent design:** `docs/phase3-browser-daemon-integration-design.md`
**Low-level design:** `docs/phase3-low-level-design.md`
**Goal:** connect the Phase 2 checkpoint runtime to a dedicated Chrome daemon without letting browser details own platform state.

---

## Guiding Rule

Phase 3 should not land as one big browser-runtime rewrite.

Each sub-phase must:

1. introduce one coherent browser/runtime capability,
2. include focused tests,
3. preserve Phase 2 coordinator ownership of lifecycle mutation,
4. keep `profile=user` out of default execution,
5. avoid persisting sensitive browser/auth material,
6. leave the repo shippable after completion.

Recommended sequence:

```text
3.1 browser contracts + daemon refs
  -> 3.2 daemon health/start boundary
  -> 3.3 page target lifecycle
  -> 3.4 network capture -> evidence bridge
  -> 3.5 auth boundary -> human intervention bridge
  -> 3.6 resume auth recheck against browser session
  -> 3.7 daemon default policy + docs/script audit
```

## Diagrams

Excalidraw diagrams are optional for this docs-first checkpoint and are intentionally not required for the committed Phase 3 markdown package. If diagrams are shared later, they should mirror:

- Phase 3.1–3.7 roadmap and quality gates
- runtime/coordinator/browser daemon boundary
- auth wait, explicit resume, browser recheck, evidence capture sequence

---

## Phase 3.1 — Browser Contracts and Opaque References

### Purpose

Create the TypeScript boundary for browser integration without launching Chrome yet.

This phase answers:

- What is a daemon ref?
- What is a browser session ref?
- What is a page target ref?
- What is a browser observation?
- Which fields may cross into runtime checkpoints?
- Which fields must be redacted or adapter-local only?

### Proposed files

```text
src/browser/types.ts
src/browser/browserObservation.ts
src/browser/browserRedaction.ts
src/browser/index.ts
src/browser/README.md
test/browser-types.test.js
test/browser-redaction.test.js
```

### Implementation details

Define minimal contracts for:

- `BrowserDaemonRef`
- `BrowserSessionRef`
- `PageTargetRef`
- `BrowserObservation`
- `BrowserNavigationResult`
- `BrowserAuthBoundarySignal`
- `BrowserRuntimeDiagnostic`

Recommended decisions:

- browser refs are opaque strings outside the browser package,
- raw websocket debugger URLs are adapter-local,
- profile directories never enter checkpoints/events,
- headers/cookies are redacted at the browser boundary,
- observations are JSON-safe before reaching discovery normalizers.

### Tests

- exported browser types/module can be imported,
- browser refs can be created without exposing filesystem paths,
- browser redaction masks query values, cookies, authorization, set-cookie, profile-looking strings,
- browser observation fixture contains no raw secret fields.

### Definition of done

- `npm run typecheck` passes.
- `npm test` passes.
- No real Chrome process is launched.
- Runtime package does not import browser internals.

---

## Phase 3.2 — Daemon Health and Startup Boundary

### Purpose

Add the daemon client interface and a first local Chrome daemon implementation boundary.

This phase answers:

- Is the daemon healthy?
- Can the platform start or verify it?
- What safe health details can be reported?
- What happens when the daemon is unavailable?

### Proposed files

```text
src/browser/daemonClient.ts
src/browser/chromeDaemonClient.ts
test/browser-daemon-client.test.js
```

### Interface sketch

```ts
interface BrowserDaemonClient {
  ensureHealthy(input: EnsureBrowserDaemonInput): Promise<BrowserDaemonHealth>;
  getVersion(ref: BrowserDaemonRef): Promise<BrowserDaemonVersion>;
}
```

### Implementation details

- Start with a fake/test daemon client and a local HTTP health-check client.
- Health endpoint can inspect `/json/version` style metadata.
- Only persist safe preview fields.
- Do not fallback to `profile=user` if daemon health fails.
- If a shell startup script is used temporarily, isolate it behind this client.

### Tests

- fake healthy daemon returns stable `BrowserDaemonRef`,
- unhealthy daemon returns structured failure,
- raw websocket URL is not persisted in public result,
- no user-profile fallback is invoked.

### Definition of done

- `npm run typecheck` passes.
- `npm test` passes.
- One optional manual command can health-check a real daemon, documented but not required by default tests.

---

## Phase 3.3 — Page Target Lifecycle

### Purpose

Create deterministic page target management against the daemon boundary.

This phase answers:

- How does a run get a page target?
- How is navigation represented?
- How are stale targets detected?
- How are target refs kept opaque?

### Proposed files

```text
src/browser/pageTargetController.ts
src/browser/navigationPolicy.ts
test/browser-page-target-controller.test.js
```

### Interface sketch

```ts
interface PageTargetController {
  createTarget(input: CreatePageTargetInput): Promise<PageTargetRef>;
  getTarget(ref: PageTargetRef): Promise<PageTargetState | undefined>;
  navigate(input: NavigatePageTargetInput): Promise<BrowserNavigationResult>;
  closeTarget(ref: PageTargetRef): Promise<void>;
}
```

### Implementation details

- Fake controller first; real CDP controller after tests define the contract.
- Navigation result should include sanitized final URL, status-like hints, and timing.
- Target ref may map to CDP target id internally, but should not expose raw internals in runtime state.
- Target lifecycle should be per-run by default.

### Tests

- create/navigate/close target through fake controller,
- stale target returns controlled error,
- navigation diagnostics are redacted,
- target ref is opaque in checkpoint-like fixture.

### Definition of done

- Browser target lifecycle can be simulated without Chrome.
- A manual daemon smoke test can create/navigate a target without using `profile=user`.

---

## Phase 3.4 — Network Capture to Evidence Bridge

### Purpose

Bridge real/fake browser observations into the existing `normalizeNetworkEvidence` discovery path.

This phase answers:

- How do CDP/network events become platform-neutral raw entries?
- Which request/response fields are safe enough for normalized evidence?
- How does capture attach evidence refs to the runtime checkpoint?

### Proposed files

```text
src/browser/networkCaptureSession.ts
src/browser/mapBrowserObservationToNetworkEntry.ts
test/browser-observation-normalizer.test.js
test/browser-runtime-capture-flow.test.js
```

### Implementation details

- Capture session emits `BrowserObservation[]`.
- Mapper converts observations into existing `RawNetworkEntry` shape.
- Existing discovery normalizer emits `Evidence[]` and diagnostics.
- Runtime adapter calls `RuntimeCoordinator.recordNormalizedEvidence` rather than mutating checkpoint directly.

### Tests

- fixture observations normalize into expected evidence IDs/categories,
- auth-like observations still redact sensitive headers/query values,
- static assets can be skipped consistently,
- evidence refs are recorded only through the coordinator.

### Definition of done

- Existing network normalizer is reused, not duplicated.
- Fixture capture flow completes through Phase 2 runtime transitions.
- No raw auth material appears in checkpoint/event fixtures.

---

## Phase 3.5 — Auth Boundary to Human Intervention Bridge

### Purpose

Wire conservative browser auth-boundary signals to Phase 2 human intervention lifecycle.

This phase answers:

- When does browser integration request human help?
- What instructions does Sean receive?
- What browser refs survive the wait?
- How does unsafe/cancelled human result terminate safely?

### Proposed files

```text
src/browser/authBoundaryDetector.ts
src/browser/browserRuntimeAdapter.ts
test/browser-auth-boundary.test.js
test/browser-human-intervention-bridge.test.js
```

### Implementation details

Auth-boundary detector can start conservative:

- login-form signal,
- MFA/OTP/captcha/consent text signal,
- `401/403` response signal,
- redirect-to-login signal,
- repeated unauthorized API response signal.

The runtime adapter should call:

```text
RuntimeCoordinator.requestHumanIntervention(...)
```

and then stop. It should not wait inside a long browser promise.

### Tests

- auth signal triggers `waiting_for_human`,
- raw resume token is issued once and not persisted,
- unsafe/cancelled result cancels run,
- detector uncertainty records diagnostic without leaking page secrets,
- `profile=user` is not selected automatically.

### Definition of done

- Auth wait uses Phase 2 coordinator unchanged.
- Browser target/session ref is preserved as opaque metadata only.
- No real login automation is required for unit tests.

---

## Phase 3.6 — Resume Auth Recheck Against Browser Session

### Purpose

Replace Phase 2 deterministic auth recheck simulation with a browser-backed auth recheck boundary.

This phase answers:

- After human completion, is the browser session actually usable?
- What if the page target is stale?
- What if login failed or expired?
- What evidence can be captured after recheck?

### Proposed files

```text
src/browser/authRecheck.ts
src/browser/resumeBrowserRun.ts
test/browser-resume-auth-recheck.test.js
test/browser-authenticated-capture-flow.test.js
```

### Implementation details

Resume flow:

1. `completeHumanIntervention`
2. `resumeRun`
3. browser auth recheck
4. on success, `confirmResumeAuthRecheck`
5. capture observations
6. normalize evidence
7. `recordNormalizedEvidence`
8. complete or continue plan

If auth recheck fails, call `markFailed` from `running_after_resume` with a sanitized diagnostic.

### Tests

- completed intervention + valid recheck continues,
- completed intervention + failed recheck fails before evidence normalization,
- stale target can be recreated only if policy marks restart safe,
- duplicate resume attempt remains rejected,
- resumed capture produces deterministic event order.

### Definition of done

- Auth recheck is explicit and test-covered.
- No evidence normalization happens before successful `confirmResumeAuthRecheck`.
- Browser errors are translated into structured runtime diagnostics.

---

## Phase 3.7 — Daemon Default Policy and Docs/Script Audit

### Purpose

Make daemon mode the documented and tested default route for routine platform execution.

This phase answers:

- Are docs aligned with daemon-first policy?
- Are old `profile=user` assumptions removed or marked manual?
- Are tests and examples clear about daemon vs live browser?
- Are recurring/automation flows protected from consent popup regressions?

### Proposed files / updates

```text
docs/stable-chrome-daemon.md
docs/overview.md
docs/todo.md
docs/dynamic-acquisition-platform-diagrams.md
src/browser/README.md
```

Potential scripts later:

```text
scripts/check-browser-policy.js
scripts/smoke-browser-daemon.js
```

### Tests / checks

- grep/docs audit for accidental `profile=user` default language,
- optional policy script that fails when examples silently fallback to user profile,
- manual smoke test documented separately from CI.

### Definition of done

- Daemon-first is the repo's default language and examples.
- `profile=user` is consistently described as explicit/manual bridge mode.
- Phase 3 docs are updated with final implementation choices.
- Verification gate passes:

```bash
npm run typecheck
npm test
npm run check
```

---

## Low-Level Design Reference

Detailed module, API, helper, test, and exit-criteria guidance for each Phase 3 slice lives in `docs/phase3-low-level-design.md`.

Use that document before writing Phase 3 code. This file remains the roadmap and quality-gate index; the LLD file is the implementation blueprint.

## Phase 3 Quality Gate

Before moving to Phase 4 strategy/backend composition:

- All Phase 3 tests pass.
- Browser daemon integration is fixture-testable without Chrome.
- One optional manual daemon smoke path is documented.
- Runtime events remain coordinator-owned.
- Browser refs remain opaque.
- No raw auth material is persisted.
- Daemon mode is default.
- `profile=user` is explicit/manual only.

