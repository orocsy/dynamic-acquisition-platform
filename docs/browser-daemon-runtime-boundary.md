# Browser Daemon Runtime Boundary

**Status:** Draft v0
**Phase:** 3 support document
**Companion:** `docs/phase3-browser-daemon-integration-design.md`

---

## Purpose

This document defines the boundary between:

- the platform runtime coordinator,
- browser daemon infrastructure,
- page/network capture logic,
- and downstream discovery/evidence normalization.

The purpose is to prevent the browser layer from becoming an unstructured automation blob.

---

## Boundary Summary

```text
RuntimeCoordinator
  owns: run lifecycle, checkpoint mutation, intervention lifecycle, event order

BrowserRuntimeAdapter
  owns: translating runtime intent into browser capability calls

BrowserDaemonClient
  owns: daemon health/start/version checks

PageTargetController
  owns: page target creation, navigation, stale target detection, close/cleanup

NetworkCaptureSession
  owns: browser observation capture

Discovery normalizer
  owns: normalized Evidence creation from safe raw entries
```

No module below the runtime coordinator may write checkpoint state directly.

---

## What Crosses the Boundary

Allowed from browser layer into runtime/event diagnostics:

- opaque `browserSessionRef`,
- opaque `pageTargetRef` only when needed and redacted,
- sanitized URL previews,
- navigation status/timing summaries,
- auth-boundary classification labels,
- evidence refs produced by discovery normalizer,
- structured failure codes.

Not allowed:

- raw cookies,
- raw authorization headers,
- raw `set-cookie`,
- passwords,
- OTP/MFA values,
- captcha payloads,
- Chrome profile paths,
- raw websocket debugger URLs,
- raw request bodies that may contain secrets,
- local filesystem paths from profile/user data dirs.

---

## Daemon Selection Policy

Default routine execution:

```text
dedicated Chrome daemon
```

Explicit/manual bridge mode only:

```text
profile=user / live user Chrome attach
```

Fallback rule:

> If daemon mode fails, fail with a structured diagnostic. Do not silently fallback to `profile=user`.

This is the key rule that prevents recurring automation from disturbing Sean's daily browser session.

---

## Runtime State Policy

`RunCheckpoint.browserSessionRef` may be populated only with an opaque stable handle.

Good:

```text
daemon:local:9333/session/run_abc123
```

Bad:

```text
<chrome-profile-dir>/Profile 1
ws://127.0.0.1:9333/devtools/browser/...
Cookie: session=...
Authorization: <redacted>
```

---

## Page Target Lifecycle

A page target is not the run. It is a resumable execution aid.

States:

```text
created -> navigating -> ready -> stale -> closed
```

Runtime implications:

- `created/navigating/ready` can continue capture.
- `stale` requires recheck/recreate policy.
- `closed` can only resume from checkpoint if restart is safe.

---

## Auth Boundary Handling

The browser layer can detect auth boundary signals, but the runtime owns the pause.

```text
Browser detects auth signal
  -> BrowserRuntimeAdapter asks RuntimeCoordinator.requestHumanIntervention
  -> RuntimeCoordinator persists checkpoint/request/token hash
  -> Browser layer stops active work
```

The browser layer must not wait in a long-held promise for human login.

---

## Resume Handling

Human completion is not enough.

```text
Human completes login/MFA/captcha/consent
  -> completeHumanIntervention
  -> resumeRun
  -> browser auth recheck
  -> confirmResumeAuthRecheck
  -> capture/normalize evidence
```

If browser auth recheck fails, the runtime should fail or request another intervention. It must not continue as if authenticated.

---

## Observability

Browser diagnostics should answer:

- which phase failed,
- whether daemon was healthy,
- whether target was created/navigated,
- whether auth boundary was detected,
- whether auth recheck passed,
- how many observations were captured,
- how many evidence items were normalized,
- what was skipped and why.

They should not reveal raw credentials, cookies, local profile details, or sensitive target parameters.

---

## First Implementation Bias

Prefer a fake/test client first, then a real local daemon adapter.

Reason:

- Phase 2 succeeded because runtime behavior was deterministic and tested before real browser complexity.
- Phase 3 should keep that discipline.
- Real Chrome smoke tests are useful, but they should not be the only way to prove runtime correctness.

