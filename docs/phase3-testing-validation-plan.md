# Phase 3 Testing and Validation Plan

**Status:** Draft v0
**Phase:** 3 support document
**Companion:** `docs/phase3-implementation-breakdown.md`

---

## Purpose

Phase 3 introduces real browser daemon integration. That raises risk:

- nondeterministic Chrome behavior,
- stale page targets,
- auth waits,
- accidental live-user-browser fallback,
- secret leakage through network/browser diagnostics.

This plan keeps Phase 3 testable and safe.

---

## Test Pyramid

```text
Pure unit tests
  -> fixture integration tests
  -> optional local daemon smoke tests
  -> manual authenticated flow checks
```

Do not invert this pyramid. Most Phase 3 correctness must be proven without launching Chrome.

---

## 1. Pure Unit Tests

Target:

- browser types,
- redaction helpers,
- daemon client interface behavior,
- page target state machine,
- auth-boundary classification,
- browser observation mapping.

Required examples:

```text
test/browser-types.test.js
test/browser-redaction.test.js
test/browser-daemon-client.test.js
test/browser-page-target-controller.test.js
test/browser-auth-boundary.test.js
```

Gate:

```bash
npm run typecheck
npm test
```

---

## 2. Fixture Integration Tests

Target:

- fake browser observation fixtures,
- mapping to existing network normalizer,
- runtime coordinator event order,
- auth wait/resume/recheck lifecycle.

Required examples:

```text
test/browser-observation-normalizer.test.js
test/browser-runtime-capture-flow.test.js
test/browser-human-intervention-bridge.test.js
test/browser-resume-auth-recheck.test.js
test/browser-authenticated-capture-flow.test.js
```

Assertions:

- evidence normalization reuses `src/discovery/network`,
- checkpoint mutations happen only through `RuntimeCoordinator`,
- auth recheck must pass before evidence normalization after resume,
- duplicate resume attempts remain rejected,
- cancelled/unsafe human intervention never continues capture,
- browser diagnostics are redacted before persistence.

---

## 3. Optional Local Daemon Smoke Tests

These tests may require a developer machine with a dedicated daemon running.

They should not be part of default CI until they are deterministic.

Potential command later:

```bash
npm run smoke:browser-daemon
```

Smoke coverage:

- daemon health endpoint reachable,
- create page target,
- navigate to a public test URL,
- capture at least one network observation,
- normalize observation into evidence,
- close target.

Rules:

- must use dedicated daemon profile,
- must not attach to `profile=user`,
- must print sanitized diagnostics only,
- must fail loudly if daemon is unavailable instead of falling back.

---

## 4. Manual Authenticated Flow Checks

Manual tests are acceptable for the first real login/captcha/MFA flows, but they must be documented as manual.

Manual checklist:

1. Start dedicated daemon.
2. Start run against known login-required target.
3. Confirm runtime enters `waiting_for_human`.
4. Complete login/MFA/captcha manually.
5. Submit explicit resume token/action.
6. Confirm runtime enters `running_after_resume/auth_state_recheck`.
7. Confirm browser auth recheck passes.
8. Confirm evidence capture runs only after recheck.
9. Confirm no raw cookies/headers/tokens/profile paths appear in events/checkpoints.
10. Confirm final artifact/evidence summary is deterministic enough for debugging.

---

## 5. Secret Leakage Regression Tests

Every Phase 3 slice must include leakage checks for:

- URL query values,
- cookies,
- `set-cookie`,
- `authorization`,
- bearer tokens,
- CSRF/token-like fields,
- OTP/MFA values,
- local Chrome profile paths,
- raw websocket debugger URLs,
- resume tokens.

Recommended assertion style:

```text
JSON.stringify(persistedCheckpointOrEvents) must not contain known secret fixture values.
```

---

## 6. Policy Regression Tests

The repo should reject accidental default user-browser attachment.

Policy checks can start as docs/scripts audit and later become automated:

- examples must say daemon first,
- `profile=user` must be described as explicit/manual,
- no default route silently falls back to user Chrome,
- daemon health failure produces structured failure.

---

## 7. Phase 3 Exit Gate

Before Phase 3 is considered complete:

```bash
npm run typecheck
npm test
npm run check
```

And additionally:

- browser fixture tests pass,
- redaction tests include browser-specific leakage cases,
- docs are aligned with implemented behavior,
- optional daemon smoke path is documented,
- `profile=user` remains explicit/manual only,
- manual authenticated flow checklist has been run at least once or explicitly deferred.

