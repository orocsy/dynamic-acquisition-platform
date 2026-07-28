# Phase 3.6 — Browser-backed resume auth recheck (LLD §9)

Engineering record for the slice implemented on `phase3.6-resume-auth-recheck`
(**PR #5**). Written to be read cold, in a fresh session, by someone who did not
sit through the review loop.

Read `docs/phase3-low-level-design.md` §9 first for the *specified* behaviour;
this document records what was actually built, why it ended up stricter than the
spec, and what is still deferred.

---

## 1. Status

| | |
|---|---|
| Branch | `phase3.6-resume-auth-recheck` |
| PR | #5 — **OPEN, not merged** as of 2026-07-28 |
| Head | `45b41de` (19 commits ahead of `main`, 0 behind) |
| Tests | **368 pass / 0 fail** (`npm test`) |
| Gates | `npm run check` green; three independent adversarial probes green |
| Review | codex loop at **15 rounds, 76 findings, all fixed**; round 16 requested against `45b41de`, outstanding |

The merge is a **user action** — it has been permission-gated for every PR in
this project (PRs #3 and #4 were merged by the user), and the review loop has
not yet returned a clean round. See §9 for the post-merge checklist.

Diff against `main`: 10 files, ~2,600 insertions.

```
src/browser/authRecheck.ts            (new, 325)   src/browser/resumeBrowserRun.ts (new, 617)
src/browser/networkCaptureSession.ts  (+174)       src/browser/navigationPolicy.ts (+28)
src/browser/persistenceGuard.ts       (+17)        src/browser/index.ts            (+2)
test/browser-authenticated-capture-flow.test.js (new, 921)
test/browser-resume-auth-recheck.test.js        (new, 285)
test/browser-network-capture-session.test.js    (+259)
```

---

## 2. What this slice does

After a human completes an intervention (Phase 3.5 parked the run at
`waiting_for_human`), something has to decide whether the browser is *actually*
authenticated now, and only then let discovery evidence be captured. That
decision is this slice. It replaces Phase 2's simulated recheck with a
browser-backed one while keeping the identical runtime transitions.

Two modules:

**`src/browser/authRecheck.ts`** — the verdict.

- `BrowserAuthRechecker` contract (§9.3), plus `FakeBrowserAuthRechecker` for
  tests and `DetectorBackedAuthRechecker` for real use.
- The real rechecker *composes* the Phase 3.5 `ConservativeAuthBoundaryDetector`
  rather than re-implementing auth rules — one oracle, not two copies.
- Success requires **both** no auth-boundary signal **and** positive evidence
  the page is reachable (a navigation that succeeded with a non-error status).
  Absence of login markers alone is not enough: a 500 or an empty probe must
  never read as "authenticated".
- Failures carry a **fixed message per code** (`session-stale`, `target-stale`,
  `still-unauthorized`, `recheck-timeout`, `unsafe-target`). No source text, no
  URL, no ref ever reaches a failure result.

**`src/browser/resumeBrowserRun.ts`** — the flow (§9.4).

```
guard refs + ownership        (throws BEFORE any transition -> caller can retry)
  -> coordinator.resumeRun    (running_after_resume committed)
  -> URL authority + safety    (see §4)
  -> rechecker.recheck
       |- fail + target-stale  -> §9.5 policy-gated one-shot recreation -> retry
       |- fail                 -> markFailed BEFORE any evidence work
       `- pass                 -> confirmResumeAuthRecheck
  -> session.start             (FRESH capture window opens here, not earlier)
  -> pageTargets.navigate      (discovery navigation inside that window)
  -> runBrowserNetworkCaptureFlow (reuses the Phase 3.4 bridge unchanged)
  -> markCompleted             (only when the caller asked, and evidence exists)
```

Ordering is the point. The capture window opens **strictly after** the auth
verdict is committed, so human-login and recheck traffic can never be folded
into discovery evidence. A failed recheck reaches `markFailed` before any
capture call happens at all.

---

## 3. Invariants enforced in code

These labels appear in the source comments; grep for them when changing this
code. They came from review findings, so each one has a real failure behind it.

**Ownership and identity**
- **I1 / J1 / K1** — the session registry is *required* and is the only
  authority binding a session to its run and page target. The checkpoint carries
  only the session ref. Fail closed: the record must exist, own this run, and
  carry a page target exactly equal to the supplied one.
- **I3** — the resumed checkpoint must carry a `browserSessionRef` equal to the
  supplied one. Absence is not permission to adopt a caller-supplied session.
- **J5** — recreation may only run on the session's *own* daemon. Extended well
  past the original id check (see §4).
- **K8** — the guards return canonical strings and those are the only values
  used afterwards. Raw caller refs are never re-read.

**Target lifecycle**
- **J2** — capture drives only the already-authorized target. A
  rechecker-returned `pageTargetRef` never substitutes a different page.
- **J3 / K9** — a discovery navigation that fails, rejects, *or* reports success
  for a different target fails the run before capture.
- **K3** — successful recreation rebinds the registry to the replacement.
- **K4** — an opened capture window is always torn down on failure paths,
  including when the session lacks the optional `abort` (falls back to `stop`,
  result discarded).
- Recreation closes the dead original at creation time, and closes the
  *replacement* if the retry recheck fails, the flow throws, or the returned
  snapshot is unusable.

**Evidence integrity**
- **K5** — completion requires at least one evidence item. A `recorded` capture
  with zero evidence is a false success.
- **K6** — a failure *after* the auth verdict is committed is a `discovery`
  failure (`authRecheck: 'passed'` stays in the event), never another
  `recheck-failed`. The event stream must not contradict itself.
- Evidence intent attribution is bound to the resumed checkpoint's
  `intentSnapshot.intentId`; a mismatching caller-supplied `intentId` fails the
  run (`intent-mismatch`).

**Untrusted-input discipline**
- The entire input is snapshotted at entry (`input = { ...input }`, plus
  `daemonRef` one level down with `id` canonicalized to a primitive). Every
  caller field is read exactly once.
- A foreign rechecker's result is snapshotted once and requires a **literal**
  `ok === true`; its `message`/`diagnostics` are never forwarded — the flow
  re-derives a safe message from a validated code.
- The probe's output (`navigation` and its scalar fields, `observations`,
  `pageTextPreview`) is snapshotted once, so a mutating result cannot assemble a
  passing verdict from two different reads.

---

## 4. Two gates worth understanding before you touch them

### URL authority *and* URL safety are different checks

Both run before the first recheck, and both matter:

1. **Authority** — a supplied `targetUrl` must equal the run's own intent URL
   from the resumed checkpoint's `intentSnapshot`. Ownership of the run,
   session, and page refs does not authorize a *destination*. Fails with
   `url-not-intent`. An **omitted** `targetUrl` is *derived* from the intent
   rather than treated as authorization — otherwise the probe would visit
   whatever page the human left open and discovery navigation would be
   skipped, letting a polling source record evidence from the wrong page.
2. **Safety** — the URL must also pass `navigationPolicy.isSafeNavigationTarget`
   — an allowlist: absolute `http(s)` only, no userinfo, and a host that is
   not loopback, not unspecified (`0.0.0.0`/`::`), and not private / CGNAT /
   link-local (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16`
   including the cloud metadata address, `fe80::/10`, `fc00::/7`). Fails with
   `unsafe-target`. "Not loopback" is nowhere near "public" — the private
   ranges are the classic SSRF target.

The second exists because `intentSnapshot` is typed `unknown` and the Intent
contract constrains no schemes, so a run can legitimately carry
`javascript:…`, `file://…`, `data:…`, a credentials-embedded URL, or the
daemon's own CDP endpoint as its recorded intent. Matching the intent proves the
URL is the *authorized* one, not a *safe* one.

Both gates run **before** the rechecker, not after. `DetectorBackedAuthRechecker`
forwards `targetUrl` to `AuthStateProbe.probe`, and the probe **navigates** — a
post-recheck check would fire after the unsafe browser action already happened.

### Daemon binding covers every transport-relevant field

Recreation validates, against the registry record: the `kind` literal, `mode`,
and a `healthUrlPreview` that is a loopback-safe `http://` origin whose
`daemonIdFromEndpoint(origin)` equals the record's `daemonId`. It then rebuilds
a **canonical** ref via `buildDaemonRef` and passes that to `createTarget`, so
no caller-controlled property reaches the transport.

Checking only `id` was not enough: the id derives from host:port alone, so an
approved id could ride alongside a substituted endpoint, a different loopback
port, or a swapped scheme.

---

## 5. The review loop: 15 rounds, 76 findings

| Round | Findings | Commit |
|---|---|---|
| 1 | 9 | `c73b6f5` |
| 2 | 7 | `e2ed1fb` |
| 3 | 5 | `8f30095` |
| 4 | 8 | `ca4b274` |
| 5 | 4 | `0cb3719` |
| 6 | 4 | `bd734dd` |
| 7 | 3 | `76801d0` |
| 8 | 2 | `bf69380` |
| 9 | 3 | `80afef5` |
| 10 | 8 | `7d5aab2` |
| 11 | 6 | `50c9e72` |
| 12 | 4 | `018129f` |
| 13 | 3 | `f66e7a2` |
| 14 | 7 | `88754ec` |
| 15 | 3 | `45b41de` |

**The count did not converge monotonically, and that is informative.** Rounds
8–9 added new machinery (teardown debts, close-on-failure paths, URL gates), and
rounds 10–12 were largely the reviewer auditing *those fixes*. Round 10 found a
regression I had introduced in round 9; round 12 found a defect inside my own
round-11 fix. Expect the same pattern in future hardening slices: **new defensive
machinery is itself new attack surface, and it needs its own review pass.**

### Four recurring defect classes

Nearly every finding in rounds 4–12 was an instance of one of these. Check new
code against all four.

**1. Validate once, read twice (TOCTOU on untrusted objects).**
A JavaScript caller can pass an object whose getter or `toString()` returns a
valid value during validation and a different one at use. Fixed by snapshotting
at the boundary: whole-input spread, canonical strings returned *from* the
guards, scalar-field copies of probe output.

> **Trap:** `x === undefined ? {} : { x }` reads the getter **twice** and stores
> the **second** value. It looks idiomatic and it silently defeats the snapshot.
> Read each field into a local first. This defeated one of my own fixes until a
> regression test caught it.

**2. Authorized ≠ safe.** Ownership checks answer "may this caller act on this
run?", not "is this action safe?". Both need explicit gates (§4).

**3. Optional capabilities must fail closed across their whole lifecycle.**
`abort`, `beginCapture`, `abortCapture`, `closeTarget` are all optional in their
interfaces. An adaptive source can *lose* a capability between calls. The rule
that emerged: track what a window was opened with, keep the obligation until it
is actually discharged, and refuse to reopen when nothing can discharge it —
but never charge an obligation to a source that never buffered at all.

**4. Every created resource needs an owner on every terminal path.** Capture
windows and recreated page targets both leaked in early rounds. `navigate()`
only marks a target `stale`; only `closeTarget()` frees it.

---

## 6. What is NOT real yet (read before promising a browser demo)

This slice is fixture-driven end to end. Three ports have only
`NotImplemented*` implementations in the repo:

- `CdpTargetTransport` — so `ChromePageTargetController` is real code with
  nothing behind it; it cannot open, navigate, or close an actual page.
- `AuthStateProbe` — so `DetectorBackedAuthRechecker` cannot observe a real page.
- `NetworkObservationSource` — so nothing collects real network traffic.

The only component that touches a real browser is `ChromeDaemonClient`, which
does genuine HTTP against a local Chrome's `/json/version`. There is also no
runnable entrypoint: `examples/` is empty and `scripts/` holds only the contract
checker.

**Consequence:** the 354 passing tests prove the classification, ordering, and
safety logic. They prove nothing about the CDP wire protocol. A real
browser test requires implementing those three transports plus wiring — which is
essentially Phase 3.7.

---

## 7. Verification

```bash
npm run check   # typecheck + contract sample validation
npm test        # builds to dist/, then node --test
```

Both must be green before this slice is "done". The adversarial probes are
deliberately **outside** the suite (they assert properties, not units) and live
in the session scratchpad; re-create them from §3's invariant list if needed.
They cover: stateful-`toString` refs, substituted-URL recreation, an
always-failing teardown transport, and every input field getter-backed
(asserting each is read exactly once through a full successful resume).

---

## 8. Known boundaries and open risk

**The Intent contract is under-constrained — this is the real root cause.**
`intentSnapshot` is typed `unknown` and `src/contracts/intent.schema.js` places
no constraint on `target.value`. Two separate round-11/12 findings (evidence
intent attribution, and URL safety) trace back to it. The resume flow now
defends against both, but every *other* consumer of an intent snapshot has the
same exposure and no such defence.

Recommended: constrain the Intent contract at the source (scheme allowlist on
`target.value`, required `intentId`) as its own slice, **before** Phase 3.7.
Patching each consumer does not fix the class.

**A DNS name that resolves into a private range cannot be judged here.**
`isPrivateOrLinkLocalHost` sees only the literal host, so `internal.corp.example`
passes. Validating the *resolved* address — and re-validating at connect time,
against DNS rebinding — is part of the transport obligation below.

**Redirect safety is a transport obligation, not a flow guarantee.** The entry
gate validates the URL the run starts from. If that allowed public URL responds
with a redirect to `http://127.0.0.1:9222`, `http://0.0.0.0:9222`, or any other
local service, following it is the same unsafe request the gate exists to
prevent — and the flow cannot detect it after the fact, because
`BasePageTargetController` sanitizes only the *final* URL and
`sanitizeUrlPreview` deliberately drops loopback previews, so a followed
redirect is indistinguishable downstream from "no preview available".

Every real `CdpTargetTransport` / `AuthStateProbe` implementation **must**
re-apply `isSafeNavigationTarget` to each redirect destination *before*
following it, and abort the navigation when it fails. This is documented on the
predicate itself. It is unenforced today only because those transports do not
exist yet (§6) — **it is a Phase 3.7 acceptance criterion, not an optional
hardening.**

**In-memory session registry** ⇒ same-process resume only (inherited from 3.2,
documented in `browserSessionRegistry.ts`).

**Local FS hazard on this machine** — see `HANDOFF.md`. Build, test, and commit
from a fresh clone on local disk, not the Desktop working copy.

---

## 9. Post-merge checklist

When PR #5 merges to `main`:

1. `docs/todo.md` — flip Phase 3.6 from `[~]` to `[x]`, record the merge commit
   and the final round count.
2. `HANDOFF.md` — add a dated entry: 3.6 merged, next slice is 3.7.
3. Delete the merged branch; the Desktop working copy still sits on the stale
   `phase3.4-network-evidence` branch, so reset it to `origin/main` rather than
   trusting its git state.
4. Decide on the Intent-contract slice (§8) before starting 3.7.

## 10. Starting Phase 3.7

Phase 3.7 is "promote daemon runner to default browser entrypoint and audit
policy/docs". It is the slice where the deferred transports (§6) stop being
deferrable, so plan for it to be the first slice with real browser exposure:

- The three `NotImplemented*` ports become real CDP implementations.
- That is the first time any test can exercise the wire protocol, so budget for
  an integration harness that a fixture suite cannot replace.
- Everything in §5's four defect classes applies to the new transport code, and
  it will be handling genuinely untrusted remote input for the first time.
- **Acceptance criterion carried over from the 3.6 review:** the transport must
  re-check every redirect destination with `isSafeNavigationTarget` before
  following it, AND validate the resolved address at connect time (§8).
  Nothing downstream can compensate for skipping either.
