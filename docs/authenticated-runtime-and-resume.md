# Authenticated Runtime and Resume Design v0

**Status:** Draft v0  
**Purpose:** Define how the platform handles login-required web flows, human intervention, timeouts, and resumable runs.

---

## 1. Position

Authenticated web access is a runtime concern, not a discovery normalizer concern.

Discovery should observe and normalize signals. Runtime decides whether a browser/profile/session may be used, whether a human must intervene, and how long the process can wait.

---

## 2. Authentication Modes

```ts
type AuthMode =
  | 'public'
  | 'existing-session'
  | 'human-assisted'
  | 'unsupported';
```

Rules:

- `public`: proceed without login.
- `existing-session`: use an already authorized browser profile or session artifact.
- `human-assisted`: pause and request the human to complete login, MFA, consent, captcha, or account choice.
- `unsupported`: stop when access is not allowed, unsafe, or unavailable.

The platform must not guess passwords, bypass MFA, defeat captcha/bot checks, or store raw credentials.

---

## 3. Human Intervention Request

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
  createdAt: string;
};
```

Recommended timeout defaults:

- foreground interactive run: `10-15 min`
- background agent run: `30-60 min`
- long-running batch job: configurable, max `24h`

Timeout does not erase the run. It moves the run to `waiting` or `expired` with a resumable checkpoint.

---

## 4. Run Checkpoint

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

Checkpoint at stable boundaries:

1. intent accepted
2. target opened
3. auth state detected
4. human intervention requested
5. human intervention completed
6. network evidence captured
7. evidence normalized
8. plan generated
9. plan step completed
10. artifact emitted

---

## 5. Resume Policy

Resume from saved outputs whenever possible.

- pure deterministic steps resume from saved outputs
- browser/navigation steps resume only when the profile/session remains valid
- side-effecting steps must be idempotent or require confirmation
- expired auth waits resume from the last pre-auth checkpoint, not from scratch

Expected restart cases:

- crashed browser pages
- expired cookies
- one-time download URLs
- server-side state that cannot be safely replayed
- unsafe repeated submit/payment/mutation actions

Even when a browser step restarts, the run must retain its intent, diagnostics, completed evidence, artifacts, and next action.

---

## 6. Runtime State Machine

```text
created
  -> running
  -> waiting_for_human
  -> running_after_resume
  -> completed

running
  -> expired
  -> failed

expired
  -> waiting_for_human
  -> failed
```

The important distinction: `waiting_for_human` and `expired` are not the same as fatal failure.

---

## 7. First Implementation Boundary

Do not build the full browser runtime yet.

First implement:

- deterministic network evidence normalization
- synthetic authenticated-network fixtures
- redaction checks proving secrets are never stored

Then add runtime checkpoint persistence and human intervention handling before real browser login automation.
