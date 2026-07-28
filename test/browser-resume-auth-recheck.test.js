'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FakeBrowserAuthRechecker,
  DetectorBackedAuthRechecker,
  NotImplementedAuthStateProbe,
  authRecheckFailure,
  isBrowserAuthRecheckFailureCode,
  browserAuthRecheckMessage,
} = require('../dist/browser');

// ---- abuse cases first ----

test('rechecker rejects a transparent/unsafe browserSessionRef without echoing it', async () => {
  const rechecker = new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] });
  for (const ref of ['daemon:d1:session:run_XYZREF', 'ws://127.0.0.1:9222/devtools/browser/XYZREF', 'session:access_token_XYZREF']) {
    await assert.rejects(
      () => rechecker.recheck({ runId: 'r', browserSessionRef: ref, pageTargetRef: 'page:t-1' }),
      (err) => { assert.equal(String(err.message).includes('XYZREF'), false); return true; },
      ref,
    );
  }
});

test('rechecker rejects a non-page-shaped pageTargetRef', async () => {
  const rechecker = new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] });
  for (const bad of ['ws://127.0.0.1:9222/devtools/browser/RAW', 'daemon:d:session:r', 'not-a-page-ref'])
    await assert.rejects(() => rechecker.recheck({ runId: 'r', browserSessionRef: 'session:ok-1', pageTargetRef: bad }), /page target ref/, bad);
});

test('a fixed failure result carries only a per-code message, never source text', () => {
  const f = authRecheckFailure('still-unauthorized');
  assert.equal(f.ok, false);
  assert.equal(f.code, 'still-unauthorized');
  assert.equal(f.message, browserAuthRecheckMessage('still-unauthorized'));
  assert.equal(isBrowserAuthRecheckFailureCode('still-unauthorized'), true);
  assert.equal(isBrowserAuthRecheckFailureCode('__proto__'), false); // prototype key not a code
  assert.equal(isBrowserAuthRecheckFailureCode('sk-live-x'), false);
});

// ---- FakeBrowserAuthRechecker ----

test('fake rechecker returns the injected outcome (fixed or planner)', async () => {
  const okr = new FakeBrowserAuthRechecker({ ok: true, confidence: 0.5, diagnostics: [] });
  assert.deepEqual(await okr.recheck({ runId: 'r', browserSessionRef: 'session:a' }), { ok: true, confidence: 0.5, diagnostics: [] });
  const planned = new FakeBrowserAuthRechecker((input) => (input.targetUrl === 'https://blocked' ? authRecheckFailure('still-unauthorized') : { ok: true, confidence: 1, diagnostics: [] }));
  assert.equal((await planned.recheck({ runId: 'r', browserSessionRef: 'session:a', targetUrl: 'https://blocked' })).ok, false);
  assert.equal((await planned.recheck({ runId: 'r', browserSessionRef: 'session:a', targetUrl: 'https://ok' })).ok, true);
});

// ---- DetectorBackedAuthRechecker (reuses the 3.5 detector as the auth-signal oracle) ----

function probeOf(observed) {
  return { probe: async () => observed };
}

test('detector-backed recheck: a persisting auth boundary -> still-unauthorized (value-free)', async () => {
  const rechecker = new DetectorBackedAuthRechecker(
    probeOf({ navigation: { ok: false, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 401, finalUrlPreview: 'https://idp/login?code=SECRET' } }),
  );
  const result = await rechecker.recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'still-unauthorized');
  assert.equal(result.diagnostics[0].boundaryKind, 'login-required');
  assert.equal(JSON.stringify(result).includes('SECRET'), false); // no page/url fragment
});

test('detector-backed recheck: no auth boundary -> ok', async () => {
  const rechecker = new DetectorBackedAuthRechecker(
    probeOf({ navigation: { ok: true, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 200, finalUrlPreview: 'https://app.example.com/dashboard' }, pageTextPreview: 'Welcome back to your dashboard' }),
  );
  const result = await rechecker.recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(result.ok, true);
  assert.equal(result.pageTargetRef, 'page:t-1');
});

test('detector-backed recheck: a probe transport failure fails safe (session-stale), not ok', async () => {
  const rechecker = new DetectorBackedAuthRechecker({ probe: async () => { throw new Error('daemon gone'); } });
  const result = await rechecker.recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session-stale');
  assert.equal(result.diagnostics[0].code, 'auth-recheck-probe-failed');
});

test('the default detector-backed probe is not implemented (real transport deferred)', async () => {
  const rechecker = new DetectorBackedAuthRechecker(new NotImplementedAuthStateProbe());
  // the NotImplemented probe throws -> mapped to a safe session-stale failure
  const result = await rechecker.recheck({ runId: 'r', browserSessionRef: 'session:a' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session-stale');
});

// Codex re-review of PR #5 round 1 (H1): success requires positive usability evidence, not
// merely the absence of login markers -- a 500/failed/empty probe must NOT pass.
test('detector-backed recheck requires a usable page for success', async () => {
  const nav = (o) => ({ ok: false, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], ...o });
  // a server-error page (no login marker) is NOT authenticated
  let r = await new DetectorBackedAuthRechecker(probeOf({ navigation: nav({ ok: false, status: 500 }) })).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'still-unauthorized');
  assert.equal(r.diagnostics[0].code, 'auth-recheck-target-not-usable');
  // an empty probe (no navigation at all) is NOT authenticated
  r = await new DetectorBackedAuthRechecker(probeOf({})).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(r.ok, false);
  // a navigation that loaded a good page IS authenticated
  r = await new DetectorBackedAuthRechecker(probeOf({ navigation: { ok: true, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 200, finalUrlPreview: 'https://app.example.com/home' } })).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(r.ok, true);
});

// Codex re-review of PR #5 round 1 (H7): a probe error that reports the page controller's
// `target-stale` code must stay `target-stale` so the flow's recreation path stays reachable.
test('detector-backed recheck preserves a target-stale probe error', async () => {
  const staleErr = Object.assign(new Error('target is stale'), { code: 'target-stale' });
  const r = await new DetectorBackedAuthRechecker({ probe: async () => { throw staleErr; } }).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'target-stale'); // NOT collapsed to session-stale
  // a generic error still fails safe as session-stale
  const generic = await new DetectorBackedAuthRechecker({ probe: async () => { throw new Error('boom'); } }).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(generic.code, 'session-stale');
});

// Codex re-review of PR #5 round 1 (H8): a probe that never settles must not hang -- an
// enforced deadline yields the structured recheck-timeout result.
test('detector-backed recheck enforces a probe deadline', async () => {
  const neverSettles = { probe: () => new Promise(() => {}) };
  const rechecker = new DetectorBackedAuthRechecker(neverSettles, undefined, 20); // 20ms deadline
  const r = await rechecker.recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'recheck-timeout');
  assert.equal(r.diagnostics[0].code, 'auth-recheck-probe-timeout');
});

// Codex re-review of PR #5 round 2 (I4): a foreign detector's unknown/secret boundary kind must
// NOT reach the public recheck diagnostic; only a known kind is copied, else the field is omitted.
test('detector-backed recheck allowlists the boundary kind in diagnostics', async () => {
  const foreignDetector = { detect: () => ({ signal: { kind: 'sk-live-SECRETKIND', confidence: 1, source: 'navigation', reason: 'x' }, diagnostics: [] }) };
  const rechecker = new DetectorBackedAuthRechecker(probeOf({ navigation: { ok: true, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 200 } }), foreignDetector);
  const r = await rechecker.recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'still-unauthorized');
  assert.equal('boundaryKind' in r.diagnostics[0], false);
  assert.equal(JSON.stringify(r).includes('SECRETKIND'), false);
  const known = { detect: () => ({ signal: { kind: 'mfa-required', confidence: 1, source: 'page-snapshot', reason: 'x' }, diagnostics: [] }) };
  const r2 = await new DetectorBackedAuthRechecker(probeOf({ navigation: { ok: true, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 200 } }), known).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(r2.diagnostics[0].boundaryKind, 'mfa-required');
});

// Codex re-review of PR #5 round 4 (K2): a probe that returns an ok navigation for a DIFFERENT
// page must not authenticate the requested one (concurrent-page result mixing).
test('recheck requires the observed navigation to be the requested target', async () => {
  const otherPageNav = { ok: true, pageTargetRef: 'page:OTHER', state: 'ready', diagnostics: [], status: 200 };
  const r = await new DetectorBackedAuthRechecker(probeOf({ navigation: otherPageNav })).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'still-unauthorized');
  assert.equal(r.diagnostics[0].code, 'auth-recheck-target-not-observed');
  // the matching target still passes
  const sameNav = { ok: true, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 200 };
  const ok = await new DetectorBackedAuthRechecker(probeOf({ navigation: sameNav })).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(ok.ok, true);
});

// Codex re-review of PR #5 round 4 (K7): the deadline ABORTS the probe so a real transport can
// tear down its in-flight work instead of leaking it.
test('an expired recheck deadline aborts the probe signal', async () => {
  let aborted = false;
  const hanging = {
    probe: (input) => new Promise(() => { input.signal?.addEventListener('abort', () => { aborted = true; }); }),
  };
  const r = await new DetectorBackedAuthRechecker(hanging, undefined, 15).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(r.code, 'recheck-timeout');
  assert.equal(aborted, true, 'the probe signal must be aborted when the deadline wins');
});

// Codex re-review of PR #5 round 5: the probe (and the verdict binding) must use the EXACT
// canonical string the guard validated. A caller object with a stateful toString() used to be
// converted twice -- validated as one ref, probed as another -- so the recheck could succeed
// against a substituted, never-validated page.
test('rechecker probes the exact ref the guard validated (stateful toString cannot swap pages)', async () => {
  const seen = [];
  const probe = {
    probe: async (i) => {
      seen.push(i.pageTargetRef);
      return { navigation: { ok: true, pageTargetRef: i.pageTargetRef, state: 'ready', diagnostics: [], status: 200 } };
    },
  };
  let conversions = 0;
  const shifty = { toString() { conversions += 1; return conversions === 1 ? 'page:t-1' : 'page:t-2'; } };
  const result = await new DetectorBackedAuthRechecker(probe).recheck({
    runId: 'r', browserSessionRef: 'session:a', pageTargetRef: shifty, targetUrl: 'https://app.example.com/home',
  });
  assert.deepEqual(seen, ['page:t-1']); // the validated ref, not a later toString() product
  assert.equal(result.ok, true);
  assert.equal(result.pageTargetRef, 'page:t-1');
});

// Same round-5 discipline for the SESSION ref: the surrogate guard's predicate regexes coerce
// an object per test, so validation and use could see different toString() products. The guard
// now snapshots once and the probe receives that exact string.
test('rechecker probes the exact session ref the guard validated (stateful toString)', async () => {
  const seen = [];
  const probe = {
    probe: async (i) => {
      seen.push(i.browserSessionRef);
      return { navigation: { ok: true, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 200 } };
    },
  };
  let conversions = 0;
  const shifty = { toString() { conversions += 1; return conversions === 1 ? 'session:legit-1' : 'session:evil-1'; } };
  const result = await new DetectorBackedAuthRechecker(probe).recheck({
    runId: 'r', browserSessionRef: shifty, pageTargetRef: 'page:t-1',
  });
  assert.deepEqual(seen, ['session:legit-1']); // the validated ref, never a later product
  assert.equal(result.ok, true);
});

// Codex re-review of PR #5 round 10 (P2): an out-of-range/non-finite timeout must fall back
// to the default. setTimeout silently clamps Infinity (and anything > 2^31-1) to ~1ms, which
// would turn "effectively no deadline" into an instant recheck-timeout on every healthy run.
test('an overflowing or non-finite recheck timeout falls back to the default', async () => {
  const nav = { ok: true, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 200 };
  const slowProbe = { probe: async () => { await new Promise((r) => setTimeout(r, 30)); return { navigation: nav }; } };
  for (const bad of [Infinity, Number.MAX_SAFE_INTEGER, 2_147_483_648, NaN, -1, 0]) {
    const r = await new DetectorBackedAuthRechecker(slowProbe, undefined, bad).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
    assert.equal(r.ok, true, `timeout ${String(bad)} must fall back to the 30s default, not fire instantly`);
  }
});

// Codex re-review of PR #5 round 10 (P2): the probe output is snapshotted once. A getter that
// returns nothing to the detector and then a healthy navigation to the usability check must
// not be able to assemble a passing verdict from two different probe results.
test('a mutating probe result cannot assemble a passing verdict from two reads', async () => {
  let reads = 0;
  const healthy = { ok: true, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 200 };
  const shifty = {
    probe: async () => ({
      get navigation() { reads += 1; return reads === 1 ? undefined : healthy; },
      observations: [],
      pageTextPreview: '',
    }),
  };
  const r = await new DetectorBackedAuthRechecker(shifty).recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(reads, 1); // read exactly once
  assert.equal(r.ok, false); // the single snapshot had no usable navigation
  assert.equal(r.diagnostics[0].code, 'auth-recheck-target-not-usable');
});
