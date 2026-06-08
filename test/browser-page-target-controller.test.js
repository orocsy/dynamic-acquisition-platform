'use strict';

// Phase 3.3 — page target lifecycle. Per this codebase's process expectation,
// the abuse cases come FIRST (unsafe refs, illegal transitions, secret URLs in
// any surfaced field), then the happy path. The recurring defect here has been
// guard code that passes its own narrow tests while leaving a structural hole,
// so adversarial inputs lead.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FakePageTargetController,
  ChromePageTargetController,
  mintPageTargetRef,
  canTransition,
  assertTargetTransition,
  isPageTargetError,
  isOpaqueBrowserRef,
  isPageTargetRef,
  guardPageTargetRef,
  toPersistableSessionRecord,
} = require('../dist/browser');

const DAEMON_REF = {
  id: 'daemon_local_9222',
  kind: 'local-chrome-daemon',
  mode: 'dedicated-daemon',
  healthUrlPreview: 'http://127.0.0.1:9222/json/version',
};

const FIXED = '2026-06-02T00:00:00.000Z';

function fixedRefs(refs) {
  let i = 0;
  return () => refs[i++] ?? `page:overflow-${i}`;
}

function makeFake(options = {}) {
  return new FakePageTargetController({ clock: () => FIXED, ...options });
}

async function createOn(controller, extra = {}) {
  return controller.createTarget({ daemonRef: DAEMON_REF, runId: 'run_browser_001', ...extra });
}

// ---------------------------------------------------------------------------
// Abuse: unsafe page target refs
// ---------------------------------------------------------------------------

test('mintPageTargetRef rejects ws/devtools/profile factory outputs', () => {
  const unsafe = [
    'ws://127.0.0.1:9222/devtools/page/RAW',
    'wss://127.0.0.1:9222/devtools/browser/abc',
    '/Users/sean/Library/Application Support/Google/Chrome/Profile 1',
    'chrome://version',
    'devtools://devtools/page/ABC',
    '../../etc/passwd',
  ];
  for (const bad of unsafe) {
    assert.throws(
      () => mintPageTargetRef(() => bad),
      (err) => isPageTargetError(err) && err.code === 'unsafe-target-ref',
      `expected "${bad}" to be rejected as a non-opaque ref`,
    );
  }
});

test('mintPageTargetRef never echoes the unsafe value into the error', () => {
  try {
    mintPageTargetRef(() => 'ws://127.0.0.1:9222/devtools/page/SECRETRAW');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(isPageTargetError(err));
    assert.equal(err.message.includes('SECRETRAW'), false);
    assert.equal(String(err.pageTargetRef ?? '').includes('SECRETRAW'), false);
  }
});

test('createTarget with an unsafe ref factory throws and stores nothing', async () => {
  const controller = makeFake({ pageTargetRefFactory: () => 'ws://127.0.0.1:9222/devtools/page/RAW' });
  await assert.rejects(
    createOn(controller),
    (err) => isPageTargetError(err) && err.code === 'unsafe-target-ref',
  );
});

// Finding #3 at the controller boundary: a ref can be perfectly "opaque" yet not
// be a page target ref. Minting must require the page:<id> shape, so a session
// ref, the transparent linkable ref, or an arbitrary token cannot become one.
test('mintPageTargetRef rejects opaque-but-non-page factory outputs', () => {
  for (const bad of ['session:uuid-1', 'daemon:d:session:r', 'not-a-page-ref', 'page_target_001']) {
    assert.throws(
      () => mintPageTargetRef(() => bad),
      (err) => isPageTargetError(err) && err.code === 'unsafe-target-ref',
      `expected non-page ref "${bad}" rejected`,
    );
  }
});

// Finding #1 (critical): an unsafe incoming ref must never be echoed back in an
// error. Before the fix, navigate/markStale/closeTarget put String(ref) straight
// into the error detail, returning the raw debugger URL to the caller.
test('navigate/markStale/closeTarget reject an unsafe incoming ref without echoing it', async () => {
  const controller = makeFake();
  const SECRET = 'ws://127.0.0.1:9222/devtools/page/SECRETRAW';
  const ops = [
    () => controller.navigate({ pageTargetRef: SECRET, url: 'https://example.com' }),
    () => controller.markStale(SECRET, 'because'),
    () => controller.closeTarget(SECRET),
  ];
  for (const op of ops) {
    await assert.rejects(op, (err) => {
      assert.ok(isPageTargetError(err));
      assert.equal(err.code, 'unsafe-target-ref');
      const blob = JSON.stringify({ msg: err.message, ref: err.pageTargetRef ?? null, from: err.from ?? null, diag: err.diagnostics ?? null });
      assert.equal(blob.includes('SECRETRAW'), false);
      assert.equal(blob.includes('devtools'), false);
      assert.equal(blob.includes('ws://'), false);
      return true;
    });
  }
});

test('getTarget returns undefined for an unsafe ref and echoes nothing', async () => {
  const controller = makeFake();
  assert.equal(await controller.getTarget('ws://127.0.0.1:9222/devtools/page/SECRETRAW'), undefined);
  assert.equal(await controller.getTarget('session:uuid-1'), undefined);
});

// Round-6 #2: validation trimmed the value but mint/persist/lookup used the
// untrimmed ref, so `" page:space "` validated yet created an unreachable target.
// The ref a caller validates must be byte-for-byte the one stored.
test('isPageTargetRef rejects surrounding whitespace', () => {
  assert.equal(isPageTargetRef('page:abc'), true);
  assert.equal(isPageTargetRef(' page:abc'), false);
  assert.equal(isPageTargetRef('page:abc '), false);
  assert.equal(isPageTargetRef('page:a b'), false);
});

test('whitespace-padded refs are rejected at mint, boundary, and lookup', async () => {
  assert.throws(
    () => mintPageTargetRef(() => ' page:space '),
    (e) => isPageTargetError(e) && e.code === 'unsafe-target-ref',
  );
  const padded = makeFake({ pageTargetRefFactory: () => ' page:space ' });
  await assert.rejects(createOn(padded), (e) => isPageTargetError(e) && e.code === 'unsafe-target-ref');
  const c = makeFake();
  await assert.rejects(c.navigate({ pageTargetRef: ' page:x ', url: 'https://x.com' }), (e) => e.code === 'unsafe-target-ref');
  await assert.rejects(c.markStale(' page:x ', 'r'), (e) => e.code === 'unsafe-target-ref');
  assert.equal(await c.getTarget(' page:x '), undefined);
});

test('default minted refs are opaque page:<uuid>', () => {
  const ref = mintPageTargetRef();
  assert.equal(isOpaqueBrowserRef(ref), true);
  assert.match(ref, /^page:[0-9a-f-]+$/i);
});

test('a minted page ref survives the exact guard the session registry uses', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:opaque-001']) });
  const snap = await createOn(controller);
  assert.equal(isOpaqueBrowserRef(snap.pageTargetRef), true);
  assert.equal(isPageTargetRef(snap.pageTargetRef), true);
  // round-trips through guardPageTargetRef — the guard the registry actually calls now...
  assert.equal(guardPageTargetRef('pageTargetRef', snap.pageTargetRef), snap.pageTargetRef);
  // ...and through the full persistable record builder the registry calls.
  const record = toPersistableSessionRecord({
    sessionId: 'session:uuid-1',
    daemonId: 'daemon_local_9222',
    runId: 'run_browser_001',
    transparentRef: 'daemon:daemon_local_9222:session:run_browser_001',
    pageTargetRef: snap.pageTargetRef,
    mode: 'dedicated-daemon',
  });
  assert.equal(record.pageTargetRef, snap.pageTargetRef);
});

// ---------------------------------------------------------------------------
// Abuse: illegal state transitions
// ---------------------------------------------------------------------------

test('assertTargetTransition rejects illegal transitions with precise codes', () => {
  assert.throws(() => assertTargetTransition('page:x', 'closed', 'navigating'), (e) => e.code === 'target-closed');
  assert.throws(() => assertTargetTransition('page:x', 'closed', 'ready'), (e) => e.code === 'target-closed');
  assert.throws(() => assertTargetTransition('page:x', 'stale', 'navigating'), (e) => e.code === 'target-stale');
  assert.throws(() => assertTargetTransition('page:x', 'stale', 'ready'), (e) => e.code === 'invalid-transition');
  assert.throws(() => assertTargetTransition('page:x', 'created', 'ready'), (e) => e.code === 'invalid-transition');
  assert.throws(() => assertTargetTransition('page:x', 'navigating', 'navigating'), (e) => e.code === 'invalid-transition');
});

test('canTransition encodes the documented state machine', () => {
  // allowed
  for (const [from, to] of [
    ['created', 'navigating'], ['created', 'closed'],
    ['navigating', 'ready'], ['navigating', 'stale'],
    ['ready', 'navigating'], ['ready', 'stale'], ['ready', 'closed'],
    ['stale', 'closed'],
  ]) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to} should be allowed`);
  }
  // forbidden
  for (const [from, to] of [
    ['created', 'ready'], ['closed', 'navigating'], ['closed', 'ready'],
    ['stale', 'navigating'], ['stale', 'ready'], ['closed', 'closed'],
  ]) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to} should be forbidden`);
  }
});

test('navigate on a closed target rejects and leaves it closed', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:closed-1']) });
  await createOn(controller);
  await controller.closeTarget('page:closed-1');
  await assert.rejects(
    controller.navigate({ pageTargetRef: 'page:closed-1', url: 'https://example.com' }),
    (e) => isPageTargetError(e) && e.code === 'target-closed',
  );
  assert.equal((await controller.getTarget('page:closed-1')).state, 'closed');
});

test('navigate on a stale target rejects (must recreate first)', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:stale-1']) });
  await createOn(controller);
  await controller.navigate({ pageTargetRef: 'page:stale-1', url: 'https://example.com' });
  await controller.markStale('page:stale-1', 'session expired');
  await assert.rejects(
    controller.navigate({ pageTargetRef: 'page:stale-1', url: 'https://example.com/again' }),
    (e) => e.code === 'target-stale',
  );
  assert.equal((await controller.getTarget('page:stale-1')).state, 'stale');
});

test('markStale on a closed target is rejected', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:ms-1']) });
  await createOn(controller);
  await controller.closeTarget('page:ms-1');
  await assert.rejects(controller.markStale('page:ms-1', 'x'), (e) => e.code === 'target-closed');
});

test('operations on an unknown ref are structured, not crashes', async () => {
  const controller = makeFake();
  assert.equal(await controller.getTarget('page:nope'), undefined);
  await assert.rejects(controller.navigate({ pageTargetRef: 'page:nope', url: 'https://x.com' }), (e) => e.code === 'unknown-target');
  await assert.rejects(controller.markStale('page:nope', 'x'), (e) => e.code === 'unknown-target');
  await assert.rejects(controller.closeTarget('page:nope'), (e) => e.code === 'unknown-target');
});

// ---------------------------------------------------------------------------
// Abuse: secrets must never reach a surfaced/persisted field
// ---------------------------------------------------------------------------

test('navigate sanitizes the final URL preview (query/fragment/userinfo stripped)', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:nav-1']) });
  await createOn(controller);
  const result = await controller.navigate({
    pageTargetRef: 'page:nav-1',
    url: 'https://user:pass@example.com/dashboard?token=RAWSECRET#frag',
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'ready');
  assert.equal(result.finalUrlPreview, 'https://example.com/dashboard');
  assert.equal(JSON.stringify(result).includes('RAWSECRET'), false);
  assert.equal(JSON.stringify(result).includes('user:pass'), false);
  const snap = await controller.getTarget('page:nav-1');
  assert.equal(snap.urlPreview, 'https://example.com/dashboard');
  assert.equal(JSON.stringify(snap).includes('RAWSECRET'), false);
});

test('createTarget sanitizes the seed targetUrl preview', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:seed-1']) });
  const snap = await createOn(controller, { targetUrl: 'https://example.com/login?next=%2Fhome&token=SEEDSECRET' });
  assert.equal(snap.state, 'created');
  assert.equal(snap.urlPreview, 'https://example.com/login');
  assert.equal(JSON.stringify(snap).includes('SEEDSECRET'), false);
});

test('navigation diagnostics never expose query values', async () => {
  const controller = makeFake({
    pageTargetRefFactory: fixedRefs(['page:diag-1']),
    navigationPlanner: () => ({
      ok: false,
      status: 302,
      finalUrl: 'https://idp.example.com/login',
      diagnostics: [{ redirectedTo: 'https://idp.example.com/authorize?session=DIAGSECRET&state=x' }],
    }),
  });
  await createOn(controller);
  const result = await controller.navigate({ pageTargetRef: 'page:diag-1', url: 'https://example.com/private' });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'stale');
  assert.equal(JSON.stringify(result.diagnostics).includes('DIAGSECRET'), false);
});

// Finding #2 (critical): a secret can hide inside a URL embedded mid-sentence, or
// in userinfo. The old redactor only sanitized strings that were a whole URL and
// never stripped user:pass, so both leaked through navigation diagnostics.
test('navigation diagnostics scrub secrets in embedded URLs and userinfo', async () => {
  const controller = makeFake({
    pageTargetRefFactory: fixedRefs(['page:diag-2']),
    navigationPlanner: () => ({
      ok: false,
      status: 302,
      diagnostics: [
        { note: 'redirected to https://idp.example.com/authorize?token=EMBEDSECRET then home' },
        { detail: 'fetched https://carol:PWLEAK@example.com/a?sig=Z mid-flow' },
      ],
    }),
  });
  await createOn(controller);
  const result = await controller.navigate({ pageTargetRef: 'page:diag-2', url: 'https://example.com/private' });
  const blob = JSON.stringify(result.diagnostics);
  assert.equal(blob.includes('EMBEDSECRET'), false);
  assert.equal(blob.includes('PWLEAK'), false);
  assert.equal(blob.includes('carol:PWLEAK'), false);
  // the non-secret part of the diagnostic survives — it is still a useful signal
  assert.equal(blob.includes('idp.example.com/authorize'), true);
});

// Round-6 #1: a secret can sit in free-form prose with no URL and no sensitive
// key — `reason: "received bearer RAWSECRET token=…"`. URL- and key-based
// redaction both miss it; a surviving credential assignment/scheme now redacts
// the whole diagnostic string, while a bare marker mention is kept.
test('navigation diagnostics redact bare credential tokens, keep benign mentions', async () => {
  const controller = makeFake({
    pageTargetRefFactory: fixedRefs(['page:cred-1']),
    navigationPlanner: () => ({
      ok: false,
      diagnostics: [
        { reason: 'received bearer RAWSECRET token=SECRET2 while loading' },
        { hint: 'password=hunter2 and api_key=AKIANOTREAL rejected' },
        { detail: 'cookie: sid=ABCSESSION; csrf=DEFTOKEN' },
        { status: 'token refresh scheduled' }, // benign mention, no value — keep
      ],
    }),
  });
  await createOn(controller);
  const r = await controller.navigate({ pageTargetRef: 'page:cred-1', url: 'https://example.com' });
  const blob = JSON.stringify(r.diagnostics);
  for (const secret of ['RAWSECRET', 'SECRET2', 'hunter2', 'AKIANOTREAL', 'ABCSESSION', 'DEFTOKEN']) {
    assert.equal(blob.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(blob.includes('token refresh scheduled'), true);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('createTarget returns a created snapshot', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:happy-1']) });
  const snap = await createOn(controller, { now: FIXED });
  assert.deepEqual(snap, {
    pageTargetRef: 'page:happy-1',
    state: 'created',
    urlPreview: undefined,
    titlePreview: undefined,
    updatedAt: FIXED,
  });
});

test('full lifecycle: created -> ready -> navigate again -> close', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:life-1']) });
  await createOn(controller);
  const nav1 = await controller.navigate({ pageTargetRef: 'page:life-1', url: 'https://example.com/a' });
  assert.equal(nav1.state, 'ready');
  assert.equal(nav1.status, 200);
  assert.equal(nav1.finalUrlPreview, 'https://example.com/a');
  const nav2 = await controller.navigate({ pageTargetRef: 'page:life-1', url: 'https://example.com/b' });
  assert.equal(nav2.state, 'ready');
  assert.equal(nav2.finalUrlPreview, 'https://example.com/b');
  const closed = await controller.closeTarget('page:life-1');
  assert.equal(closed.state, 'closed');
});

test('created -> close (skipping navigation) is allowed', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:cc-1']) });
  await createOn(controller);
  assert.equal((await controller.closeTarget('page:cc-1')).state, 'closed');
});

test('markStale and closeTarget are idempotent', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:idem-1']) });
  await createOn(controller);
  assert.equal((await controller.markStale('page:idem-1', 'reason-a')).state, 'stale');
  assert.equal((await controller.markStale('page:idem-1', 'reason-b')).state, 'stale');
  assert.equal((await controller.closeTarget('page:idem-1')).state, 'closed');
  assert.equal((await controller.closeTarget('page:idem-1')).state, 'closed');
});

test('a planned navigation failure marks the target stale (ok:false)', async () => {
  const controller = makeFake({
    pageTargetRefFactory: fixedRefs(['page:fail-1']),
    navigationPlanner: () => ({ ok: false, status: 503 }),
  });
  await createOn(controller);
  const result = await controller.navigate({ pageTargetRef: 'page:fail-1', url: 'https://example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'stale');
  assert.ok(result.diagnostics.length >= 1);
});

test('navigate validates wait mode and timeout BEFORE changing state', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:val-1']) });
  await createOn(controller);
  await assert.rejects(
    controller.navigate({ pageTargetRef: 'page:val-1', url: 'https://x.com', waitUntil: 'bogus' }),
    /wait mode/,
  );
  await assert.rejects(
    controller.navigate({ pageTargetRef: 'page:val-1', url: 'https://x.com', timeoutMs: -5 }),
    /timeoutMs/,
  );
  // still 'created' — the bad inputs never moved it into 'navigating'
  assert.equal((await controller.getTarget('page:val-1')).state, 'created');
});

test('returned snapshots are copies and cannot mutate controller state', async () => {
  const controller = makeFake({ pageTargetRefFactory: fixedRefs(['page:copy-1']) });
  const snap = await createOn(controller);
  snap.state = 'closed';
  snap.pageTargetRef = 'page:tampered';
  const fresh = await controller.getTarget('page:copy-1');
  assert.equal(fresh.state, 'created');
  assert.equal(fresh.pageTargetRef, 'page:copy-1');
});

// ---------------------------------------------------------------------------
// Real controller: interface parity, deferred transport, opaque mapping
// ---------------------------------------------------------------------------

function stubTransport(overrides = {}) {
  return {
    createTarget: overrides.createTarget ?? (async () => ({ rawTargetId: 'CDP-TARGET-RAW-123' })),
    navigate: overrides.navigate ?? (async ({ url }) => ({ ok: true, status: 200, finalUrl: url })),
    close: overrides.close ?? (async () => {}),
  };
}

test('ChromePageTargetController with the default transport fails structurally', async () => {
  const controller = new ChromePageTargetController({ clock: () => FIXED });
  await assert.rejects(
    createOn(controller),
    (e) => isPageTargetError(e) && e.code === 'transport-unavailable',
  );
});

test('ChromePageTargetController drives the same state machine via an injected transport', async () => {
  const controller = new ChromePageTargetController({
    transport: stubTransport(),
    pageTargetRefFactory: fixedRefs(['page:real-1']),
    clock: () => FIXED,
  });
  const created = await createOn(controller);
  assert.equal(created.state, 'created');
  assert.equal(created.pageTargetRef, 'page:real-1');

  const result = await controller.navigate({ pageTargetRef: 'page:real-1', url: 'https://example.com/x?token=REALSECRET' });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'ready');
  assert.equal(result.finalUrlPreview, 'https://example.com/x');

  // The raw CDP target id and the URL secret must never surface.
  const snap = await controller.getTarget('page:real-1');
  const serialized = JSON.stringify({ snap, result });
  assert.equal(serialized.includes('CDP-TARGET-RAW-123'), false);
  assert.equal(serialized.includes('REALSECRET'), false);

  // ...and the same lifecycle guards apply to the real controller.
  await controller.closeTarget('page:real-1');
  await assert.rejects(
    controller.navigate({ pageTargetRef: 'page:real-1', url: 'https://example.com' }),
    (e) => e.code === 'target-closed',
  );
});

test('ChromePageTargetController maps a transport throw to a stale ok:false navigation', async () => {
  const controller = new ChromePageTargetController({
    transport: stubTransport({ navigate: async () => { throw new Error('cdp socket closed: ws://127.0.0.1:9222/devtools/RAW'); } }),
    pageTargetRefFactory: fixedRefs(['page:real-2']),
    clock: () => FIXED,
  });
  await createOn(controller);
  const result = await controller.navigate({ pageTargetRef: 'page:real-2', url: 'https://example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'stale');
  // the raw transport error string (with a ws url) must not leak into diagnostics
  assert.equal(JSON.stringify(result).includes('ws://'), false);
});

// Finding #4 (important): the old createTarget opened the CDP target BEFORE
// minting/reserving the ref, then wrote #rawByRef before insertCreated could
// reject a duplicate. A colliding ref factory thus created a second raw target,
// rebound the mapping to it, and orphaned the first — so the original target then
// navigated the wrong raw id. Reserve-before-create closes this.
test('ChromePageTargetController rejects a duplicate ref without creating or rebinding a raw target', async () => {
  const created = [];
  const transport = stubTransport({
    createTarget: async () => {
      const id = `raw-${created.length}`;
      created.push(id);
      return { rawTargetId: id };
    },
    navigate: async ({ rawTargetId, url }) => ({ ok: true, status: 200, finalUrl: `${url}#${rawTargetId}` }),
  });
  const controller = new ChromePageTargetController({
    transport,
    pageTargetRefFactory: () => 'page:dup', // always the same ref
    clock: () => FIXED,
  });
  const first = await createOn(controller); // reserves page:dup, then creates raw-0
  assert.equal(first.pageTargetRef, 'page:dup');
  // the duplicate create is rejected BEFORE it can open a second raw target
  await assert.rejects(createOn(controller), (e) => isPageTargetError(e));
  assert.deepEqual(created, ['raw-0']); // raw-1 was never created
  // the original mapping is intact: navigate still works (it would throw if the
  // mapping had been rebound/cleared), and the raw id never surfaces.
  const nav = await controller.navigate({ pageTargetRef: 'page:dup', url: 'https://example.com/z' });
  assert.equal(nav.ok, true);
  assert.equal(nav.finalUrlPreview, 'https://example.com/z');
});

test('ChromePageTargetController rolls back the reservation when the CDP create fails', async () => {
  let calls = 0;
  const transport = stubTransport({
    createTarget: async () => {
      calls += 1;
      if (calls === 1) throw new Error('cdp create failed: ws://127.0.0.1:9222/devtools/RAW');
      return { rawTargetId: 'raw-ok' };
    },
  });
  const controller = new ChromePageTargetController({
    transport,
    pageTargetRefFactory: fixedRefs(['page:rb-1', 'page:rb-2']),
    clock: () => FIXED,
  });
  // the failed create rejects without leaking the transport's ws:// url...
  await assert.rejects(createOn(controller), (e) => isPageTargetError(e) && !JSON.stringify({ m: e.message, d: e.diagnostics ?? null }).includes('ws://'));
  // ...and leaves no ghost 'created' target behind.
  assert.equal(await controller.getTarget('page:rb-1'), undefined);
  // the controller is still usable: a fresh create (transport now succeeds) works.
  const ok = await createOn(controller);
  assert.equal(ok.pageTargetRef, 'page:rb-2');
  assert.equal(ok.state, 'created');
});

// Review (C1): a concurrent closeTarget during the in-flight transport.createTarget
// must not orphan the freshly-opened raw target or return a lying 'created' snapshot.
test('ChromePageTargetController: close during createTarget closes the raw target, not orphans it', async () => {
  let resolveCreate;
  const closed = [];
  const transport = {
    createTarget: () => new Promise((res) => { resolveCreate = () => res({ rawTargetId: 'raw-racy' }); }),
    navigate: async ({ url }) => ({ ok: true, status: 200, finalUrl: url }),
    close: async ({ rawTargetId }) => { closed.push(rawTargetId); },
  };
  const controller = new ChromePageTargetController({ transport, pageTargetRefFactory: () => 'page:racy', clock: () => FIXED });
  const createP = createOn(controller); // reserves page:racy, then awaits the pending transport create
  await controller.closeTarget('page:racy'); // concurrent close while the create is in flight
  resolveCreate(); // transport create resolves AFTER the close
  const snap = await createP;
  // the raw target opened during the race is closed — not orphaned
  assert.deepEqual(closed, ['raw-racy']);
  // and the returned snapshot reflects the real (closed) state, not a 'created' lie
  assert.equal(snap.state, 'closed');
  // navigate on the now-closed ref is rejected (no live raw mapping left behind)
  await assert.rejects(
    controller.navigate({ pageTargetRef: 'page:racy', url: 'https://x.com' }),
    (e) => e.code === 'target-closed',
  );
});
