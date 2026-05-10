# Phase 3 Low-Level Design — Browser Daemon Integration Slices

**Status:** Draft v0 — implementation-ready design
**Phase:** 3
**Companion docs:**
- `docs/phase3-browser-daemon-integration-design.md`
- `docs/phase3-implementation-breakdown.md`
- `docs/browser-daemon-runtime-boundary.md`
- `docs/phase3-testing-validation-plan.md`

---

## 1. Purpose

The Phase 3 high-level docs define **what** browser daemon integration should achieve. This document defines **how each Phase 3 slice should be implemented at module/API/test level**.

The core implementation rule remains:

> Browser integration is a backend capability. Runtime lifecycle state still belongs to `RuntimeCoordinator`.

Phase 3 implementation should preserve the Phase 2 pattern:

```text
contracts first -> fake/test implementation -> deterministic tests -> optional real daemon smoke
```

---

## 2. Current Code Constraints

Existing foundations to reuse:

- `src/runtime/types.ts` already defines branded runtime identifiers, `BrowserSessionRef`, checkpoint state, human intervention contracts, runtime diagnostics/events, and redaction constraints.
- `src/runtime/runtimeCoordinator.ts` owns run lifecycle transitions.
- `src/runtime/runtimeRedaction.ts` already sanitizes runtime data and unsafe `browserSessionRef` values.
- `src/discovery/network/types.ts` defines `RawNetworkEntry` and network normalizer input/output contracts.
- `src/discovery/network/normalizeNetworkEvidence.ts` already emits validated Evidence from raw network entries.

Do not duplicate these capabilities inside `src/browser/`.

---

## 3. Package Boundary

Phase 3 introduces a new package area:

```text
src/browser/
  README.md
  index.ts
  types.ts
  browserRef.ts
  browserRedaction.ts
  daemonClient.ts
  chromeDaemonClient.ts
  pageTargetController.ts
  navigationPolicy.ts
  browserObservation.ts
  mapBrowserObservationToNetworkEntry.ts
  networkCaptureSession.ts
  authBoundaryDetector.ts
  authRecheck.ts
  browserRuntimeAdapter.ts
```

Boundary rule:

```text
src/browser/* may import src/runtime public types/coordinator and src/discovery/network helpers.
src/runtime/* must not import src/browser/*.
```

This keeps runtime browser-neutral.

---

## 4. Phase 3.1 LLD — Browser Contracts and Opaque References

### 4.1 Goal

Define browser-domain contracts and safe reference helpers without launching a browser.

### 4.2 Files

```text
src/browser/types.ts
src/browser/browserRef.ts
src/browser/browserRedaction.ts
src/browser/browserObservation.ts
src/browser/index.ts
src/browser/README.md
test/browser-types.test.js
test/browser-redaction.test.js
```

### 4.3 Public Types

```ts
export type BrowserRefBrand<TValue, TBrand extends string> = TValue & { readonly __browserBrand: TBrand };

export type BrowserDaemonId = BrowserRefBrand<string, 'BrowserDaemonId'>;
export type PageTargetRef = BrowserRefBrand<string, 'PageTargetRef'>;
export type BrowserObservationId = BrowserRefBrand<string, 'BrowserObservationId'>;

export type BrowserDaemonMode = 'dedicated-daemon' | 'manual-user-bridge';

export type BrowserDaemonRef = {
  id: BrowserDaemonId | string;
  kind: 'local-chrome-daemon';
  mode: BrowserDaemonMode;
  healthUrlPreview: string;
};

export type BrowserSessionRefParts = {
  daemonId: string;
  runId: string;
};

export type BrowserTargetState = 'created' | 'navigating' | 'ready' | 'stale' | 'closed';
```

`BrowserSessionRef` already exists in `src/runtime/types.ts`; do not redefine it. Browser helpers should return strings that satisfy runtime's opaque-session-ref rules.

### 4.4 Browser Observation Contract

```ts
export type BrowserObservation = {
  id: BrowserObservationId | string;
  runId: string;
  source: 'cdp' | 'playwright' | 'daemon-fixture';
  capturedAt: string;
  pageTargetRef?: PageTargetRef | string;
  request?: {
    url: string;
    method: string;
    headersPreview?: Record<string, string>;
    resourceType?: string;
    bodyShape?: 'json-object' | 'json-array' | 'form-like' | 'text-preview' | 'unknown';
  };
  response?: {
    status?: number;
    mimeType?: string;
    headersPreview?: Record<string, string>;
    bodyShape?: 'json-list' | 'json-object' | 'json' | 'html-document' | 'downloadable-pdf' | 'text-preview' | 'unknown';
  };
  timing?: {
    startedAt?: string;
    durationMs?: number;
  };
};
```

### 4.5 Helper Functions

```ts
export function createBrowserSessionRef(parts: BrowserSessionRefParts): string;
export function isOpaqueBrowserRef(value: string): boolean;
export function redactBrowserDiagnosticData<T extends Record<string, unknown>>(data: T): T;
export function assertSafeBrowserObservation(observation: BrowserObservation): void;
```

Expected session ref shape:

```text
daemon:<daemon-id>:session:<run-id>
```

No helper may produce a ref containing filesystem separators, query delimiters, credential words, or local profile details.

### 4.6 Invariants

- Raw websocket URLs are not `BrowserDaemonRef` fields.
- Chrome profile paths are never public browser refs.
- Browser observations are JSON-safe before mapping to network entries.
- Header previews contain names or redacted values only, never raw cookies or auth material.

### 4.7 Tests

`test/browser-types.test.js`:

- imports `src/browser` successfully,
- creates a daemon ref fixture,
- creates a browser session ref fixture,
- creates a browser observation fixture.

`test/browser-redaction.test.js`:

- redacts query values,
- redacts cookie-like/header-like keys,
- rejects profile-looking refs,
- preserves opaque daemon/session/page refs,
- proves known unsafe fixture strings are absent from persisted fixture JSON.

### 4.8 Exit Criteria

- `npm run typecheck` passes.
- `npm test` passes.
- No real daemon code exists yet.
- Runtime package remains browser-free.

---

## 5. Phase 3.2 LLD — Daemon Health and Startup Boundary

### 5.1 Goal

Define how browser integration verifies or starts a dedicated daemon without making daemon launch details part of runtime semantics.

### 5.2 Files

```text
src/browser/daemonClient.ts
src/browser/chromeDaemonClient.ts
src/browser/daemonErrors.ts
test/browser-daemon-client.test.js
```

### 5.3 Public Interface

```ts
export type EnsureBrowserDaemonInput = {
  mode?: 'dedicated-daemon';
  endpoint?: string;
  startIfMissing?: boolean;
  now?: string;
};

export type BrowserDaemonVersion = {
  browser: string;
  protocolVersion?: string;
};

export type BrowserDaemonHealth = {
  ok: true;
  daemonRef: BrowserDaemonRef;
  version: BrowserDaemonVersion;
  checkedAt: string;
};

export type BrowserDaemonFailure = {
  ok: false;
  code: 'daemon-unavailable' | 'daemon-unhealthy' | 'daemon-start-failed' | 'daemon-response-invalid';
  message: string;
  checkedAt: string;
  diagnostics?: Record<string, unknown>;
};

export interface BrowserDaemonClient {
  ensureHealthy(input?: EnsureBrowserDaemonInput): Promise<BrowserDaemonHealth | BrowserDaemonFailure>;
  getVersion(ref: BrowserDaemonRef): Promise<BrowserDaemonVersion>;
}
```

### 5.4 Implementations

#### FakeBrowserDaemonClient

Used by tests and fixture flows.

Responsibilities:

- deterministic healthy/unhealthy behavior,
- no network calls,
- safe daemon ref generation,
- failure injection.

#### ChromeDaemonClient

Real local adapter.

Responsibilities:

- call the configured health endpoint,
- parse version response,
- optionally call a startup command through a narrow adapter later,
- return sanitized health diagnostics,
- never expose raw debug websocket URLs in public results.

### 5.5 Error Policy

Daemon failures do **not** fallback to `profile=user`.

```text
daemon unavailable -> structured failure -> runtime fail/operator action
```

### 5.6 Tests

- fake healthy daemon returns `ok: true`,
- fake unavailable daemon returns `daemon-unavailable`,
- invalid version response returns `daemon-response-invalid`,
- public health result does not contain raw debug websocket URL,
- no fallback mode other than `dedicated-daemon` is accepted by default.

### 5.7 Exit Criteria

- Daemon boundary can be tested without Chrome.
- Real health adapter exists but is not required by default tests.
- No runtime checkpoint mutation happens in daemon client.

---

## 6. Phase 3.3 LLD — Page Target Lifecycle

### 6.1 Goal

Give each run deterministic control over page target creation, navigation, stale detection, and cleanup.

### 6.2 Files

```text
src/browser/pageTargetController.ts
src/browser/navigationPolicy.ts
src/browser/pageTargetErrors.ts
test/browser-page-target-controller.test.js
```

### 6.3 Public Interface

```ts
export type CreatePageTargetInput = {
  daemonRef: BrowserDaemonRef;
  runId: string;
  targetUrl?: string;
  now?: string;
};

export type NavigatePageTargetInput = {
  pageTargetRef: PageTargetRef | string;
  url: string;
  timeoutMs?: number;
  waitUntil?: 'domcontentloaded' | 'load' | 'network-idle-ish';
  now?: string;
};

export type PageTargetSnapshot = {
  pageTargetRef: PageTargetRef | string;
  state: BrowserTargetState;
  urlPreview?: string;
  titlePreview?: string;
  updatedAt: string;
};

export type BrowserNavigationResult = {
  ok: boolean;
  pageTargetRef: PageTargetRef | string;
  finalUrlPreview?: string;
  status?: number;
  state: BrowserTargetState;
  durationMs?: number;
  diagnostics: Record<string, unknown>[];
};

export interface PageTargetController {
  createTarget(input: CreatePageTargetInput): Promise<PageTargetSnapshot>;
  getTarget(ref: PageTargetRef | string): Promise<PageTargetSnapshot | undefined>;
  navigate(input: NavigatePageTargetInput): Promise<BrowserNavigationResult>;
  markStale(ref: PageTargetRef | string, reason: string): Promise<PageTargetSnapshot>;
  closeTarget(ref: PageTargetRef | string): Promise<PageTargetSnapshot>;
}
```

### 6.4 State Machine

```text
created -> navigating -> ready -> stale -> closed
created -> closed
ready -> navigating
ready -> closed
stale -> closed
```

Invalid transitions should return structured errors or rejected promises with browser-specific error objects. They must not mutate runtime checkpoints.

### 6.5 Navigation Policy

`navigationPolicy.ts` should centralize:

- default timeout,
- allowed wait modes,
- retry count defaults,
- safe restart conditions,
- URL preview sanitization.

### 6.6 Tests

- create target returns `created`,
- navigate target returns `ready` with sanitized final URL,
- stale target cannot navigate unless recreated,
- closed target rejects navigation,
- diagnostics do not expose query values,
- target refs remain opaque.

### 6.7 Exit Criteria

- Fake target controller can drive later runtime adapter tests.
- Real target controller can be added behind the same interface.
- No default live-user browser attach path exists.

---

## 7. Phase 3.4 LLD — Network Capture to Evidence Bridge

### 7.1 Goal

Map browser observations into existing network discovery types, then attach evidence refs through the runtime coordinator.

### 7.2 Files

```text
src/browser/networkCaptureSession.ts
src/browser/mapBrowserObservationToNetworkEntry.ts
src/browser/browserCaptureFlow.ts
test/browser-observation-normalizer.test.js
test/browser-runtime-capture-flow.test.js
```

### 7.3 Public Interface

```ts
export type StartNetworkCaptureInput = {
  runId: string;
  pageTargetRef: PageTargetRef | string;
  now?: string;
};

export type StopNetworkCaptureInput = {
  runId: string;
  pageTargetRef: PageTargetRef | string;
  now?: string;
};

export type NetworkCaptureResult = {
  observations: BrowserObservation[];
  diagnostics: Record<string, unknown>[];
};

export interface NetworkCaptureSession {
  start(input: StartNetworkCaptureInput): Promise<void>;
  stop(input: StopNetworkCaptureInput): Promise<NetworkCaptureResult>;
  listObservations(runId: string): Promise<BrowserObservation[]>;
}
```

### 7.4 Mapping Function

```ts
export function mapBrowserObservationToNetworkEntry(observation: BrowserObservation): RawNetworkEntry | undefined;
```

Mapping rules:

- Missing request URL returns `undefined` and a skipped diagnostic in caller.
- `source` maps to existing `NetworkEntrySource`: `cdp`, `playwright`, or `fixture`.
- Request/response header previews map only safe header names/values.
- `startedAt` maps from observation timing or `capturedAt`.
- `durationMs` maps from observation timing.

### 7.5 Runtime Capture Flow

A small helper may orchestrate:

```text
capture observations
  -> map to RawNetworkEntry[]
  -> normalizeNetworkEvidence(...)
  -> coordinator.recordNormalizedEvidence(...)
```

It should not call `checkpointStore.update` directly.

### 7.6 Tests

- fixture observation maps to expected `RawNetworkEntry`,
- static/media observations are skipped by existing normalizer,
- auth-like observations produce sanitized evidence,
- mapped entries preserve method/path/query names but not query values,
- runtime capture flow records evidence through coordinator,
- failed validation does not mark run completed.

### 7.7 Exit Criteria

- Existing network normalizer remains the only evidence creator.
- Browser package does not create Evidence directly except through discovery function calls.
- Captured secrets are absent from persisted events/checkpoints.

---

## 8. Phase 3.5 LLD — Auth Boundary to Human Intervention Bridge

### 8.1 Goal

Turn conservative browser auth signals into Phase 2 human intervention requests.

### 8.2 Files

```text
src/browser/authBoundaryDetector.ts
src/browser/browserRuntimeAdapter.ts
test/browser-auth-boundary.test.js
test/browser-human-intervention-bridge.test.js
```

### 8.3 Auth Signal Contract

```ts
export type BrowserAuthBoundaryKind =
  | 'login-required'
  | 'mfa-required'
  | 'consent-required'
  | 'captcha-required'
  | 'decision-required';

export type BrowserAuthBoundarySignal = {
  kind: BrowserAuthBoundaryKind;
  confidence: number;
  source: 'network' | 'page-snapshot' | 'navigation' | 'manual-policy';
  reason: string;
  urlPreview?: string;
  evidence?: Record<string, unknown>;
};
```

### 8.4 Detector Interface

```ts
export type DetectAuthBoundaryInput = {
  navigation?: BrowserNavigationResult;
  observations?: BrowserObservation[];
  pageTextPreview?: string;
};

export type AuthBoundaryDetectionResult = {
  signal?: BrowserAuthBoundarySignal;
  diagnostics: Record<string, unknown>[];
};

export interface AuthBoundaryDetector {
  detect(input: DetectAuthBoundaryInput): AuthBoundaryDetectionResult;
}
```

### 8.5 Browser Runtime Adapter Method

```ts
export type RequestHumanInterventionFromBrowserInput = {
  runId: string;
  expectedVersion: number;
  signal: BrowserAuthBoundarySignal;
  browserSessionRef: string;
  nextStepId: string;
  now?: string;
};
```

Adapter behavior:

1. Validate browser session ref is opaque.
2. Convert signal kind to runtime `HumanInterventionKind`.
3. Build human instructions.
4. Call `RuntimeCoordinator.requestHumanIntervention`.
5. Return request output and stop active browser work.

### 8.6 Human Instructions

Instruction template should be specific and safe:

```text
1. Complete the login/MFA/consent/captcha in the dedicated browser daemon window.
2. Do not share credentials with the agent.
3. Return only when the page shows the expected authenticated content.
4. Cancel if the target looks unsafe or unexpected.
```

### 8.7 Tests

- `401/403` or login redirect creates login signal,
- MFA text creates MFA signal,
- captcha text creates captcha signal,
- weak/ambiguous signals produce diagnostics only,
- bridge calls coordinator and creates `waiting_for_human`,
- raw token returned only once by coordinator result,
- browser adapter never stores raw token.

### 8.8 Exit Criteria

- Auth boundary handling is coordinator-backed.
- Browser layer does not hold long promises while waiting for human action.
- Cancelling/unsafe outcomes follow existing Phase 2 behavior.

---

## 9. Phase 3.6 LLD — Resume Auth Recheck Against Browser Session

### 9.1 Goal

Replace Phase 2's deterministic auth recheck simulation with a browser-backed check while keeping the same runtime transition semantics.

### 9.2 Files

```text
src/browser/authRecheck.ts
src/browser/resumeBrowserRun.ts
test/browser-resume-auth-recheck.test.js
test/browser-authenticated-capture-flow.test.js
```

### 9.3 Auth Recheck Interface

```ts
export type BrowserAuthRecheckInput = {
  runId: string;
  browserSessionRef: string;
  pageTargetRef?: PageTargetRef | string;
  targetUrl?: string;
  now?: string;
};

export type BrowserAuthRecheckResult =
  | {
      ok: true;
      confidence: number;
      pageTargetRef?: PageTargetRef | string;
      diagnostics: Record<string, unknown>[];
    }
  | {
      ok: false;
      code: 'session-stale' | 'target-stale' | 'still-unauthorized' | 'recheck-timeout' | 'unsafe-target';
      message: string;
      diagnostics: Record<string, unknown>[];
    };

export interface BrowserAuthRechecker {
  recheck(input: BrowserAuthRecheckInput): Promise<BrowserAuthRecheckResult>;
}
```

### 9.4 Resume Browser Flow

```text
completeHumanIntervention
  -> resumeRun
  -> BrowserAuthRechecker.recheck
  -> if ok: confirmResumeAuthRecheck
  -> capture observations
  -> normalize evidence
  -> recordNormalizedEvidence
  -> markCompleted or continue next plan step
```

If recheck fails:

```text
markFailed from running_after_resume
```

Do not capture or normalize evidence after a failed recheck.

### 9.5 Safe Target Recreation

If target is stale, recreation is allowed only when:

- original intent URL is safe to revisit,
- no side-effecting submit/payment/mutation was already in progress,
- checkpoint has enough target context,
- policy allows restart.

Otherwise fail safely or request another human decision.

### 9.6 Tests

- completed intervention + successful browser recheck continues,
- failed recheck calls `markFailed` before evidence work,
- stale target with safe recreation continues after new target ref,
- stale target without safe policy fails,
- duplicate resume attempt remains rejected by coordinator,
- captured evidence after recheck has deterministic event order.

### 9.7 Exit Criteria

- Browser recheck is explicit and required.
- `confirmResumeAuthRecheck` remains the transition into normal running.
- Evidence capture cannot happen before successful recheck.

---

## 10. Phase 3.7 LLD — Daemon Default Policy and Docs/Script Audit

### 10.1 Goal

Make daemon-first execution enforceable, not only documented.

### 10.2 Files

```text
src/browser/browserPolicy.ts
scripts/check-browser-policy.js
scripts/smoke-browser-daemon.js
test/browser-policy.test.js
```

Docs to update:

```text
docs/stable-chrome-daemon.md
docs/overview.md
docs/todo.md
src/browser/README.md
```

### 10.3 Browser Policy Contract

```ts
export type BrowserExecutionMode = 'dedicated-daemon' | 'manual-user-bridge';

export type BrowserExecutionPolicy = {
  defaultMode: 'dedicated-daemon';
  allowManualUserBridge: boolean;
  allowSilentUserFallback: false;
};

export function defaultBrowserExecutionPolicy(): BrowserExecutionPolicy;
export function assertBrowserModeAllowed(mode: BrowserExecutionMode, policy: BrowserExecutionPolicy): void;
```

### 10.4 Policy Script

`scripts/check-browser-policy.js` should fail if committed examples/docs imply:

- `profile=user` is the default,
- daemon failure silently falls back to user browser,
- automation attaches to live browser without explicit/manual language.

It should not fail on historical analysis docs if they clearly label `profile=user` as old/problematic/manual.

### 10.5 Smoke Script

`scripts/smoke-browser-daemon.js` should be optional and explicit.

Responsibilities:

- check daemon health,
- create target,
- navigate to a public deterministic URL,
- capture minimal network observations,
- normalize evidence,
- close target,
- print sanitized summary.

It should not run in `npm test` by default.

### 10.6 Tests

- default policy is daemon-only,
- manual user bridge requires explicit mode,
- silent user fallback is rejected,
- policy script accepts current docs,
- smoke script can be skipped gracefully when daemon unavailable.

### 10.7 Exit Criteria

- Daemon-first is enforceable by tests/scripts.
- `profile=user` remains opt-in/manual only.
- Phase 3 docs reflect implemented reality.
- Final Phase 3 verification gate passes:

```bash
npm run typecheck
npm test
npm run check
```

---

## 11. Cross-Slice Integration Order

Implementation should follow this dependency chain:

```text
3.1 types/ref/redaction
  -> 3.2 daemon client
  -> 3.3 page target controller
  -> 3.4 observation mapping/capture flow
  -> 3.5 auth boundary bridge
  -> 3.6 browser resume recheck
  -> 3.7 policy enforcement/smoke
```

Do not implement 3.5/3.6 before 3.1–3.4 are stable; otherwise auth flow will be coupled to unstable browser primitives.

---

## 12. Review Checklist Before Coding Each Slice

For every Phase 3 implementation PR/commit:

- Does runtime state mutation still go through `RuntimeCoordinator`?
- Are browser refs opaque?
- Are all diagnostics redacted before persistence?
- Are raw cookies/headers/secrets absent from checkpoints/events?
- Does default path use dedicated daemon only?
- Is `profile=user` impossible without explicit/manual mode?
- Can the behavior be tested without real Chrome?
- Is any real daemon smoke test optional and clearly marked?
- Does `npm run typecheck && npm test && npm run check` pass?

---

## 13. First Coding Slice Recommendation

Start with **Phase 3.1 only**.

First commit should include:

```text
src/browser/types.ts
src/browser/browserRef.ts
src/browser/browserRedaction.ts
src/browser/browserObservation.ts
src/browser/index.ts
src/browser/README.md
test/browser-types.test.js
test/browser-redaction.test.js
```

Do not include daemon health, page targets, or capture sessions in the first coding commit. The smallest useful implementation is the safety boundary: opaque refs and browser-specific redaction.
