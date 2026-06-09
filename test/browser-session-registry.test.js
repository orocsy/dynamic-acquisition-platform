'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  InMemoryBrowserSessionRegistry,
  createBrowserSessionRef,
  isOpaqueBrowserRef,
} = require('../dist/browser');

function fixedSessionIds(ids) {
  let i = 0;
  return () => ids[i++] ?? `session:overflow-${i}`;
}

test('registry mints opaque surrogate session ids and hides the transparent ref', () => {
  const registry = new InMemoryBrowserSessionRegistry({
    sessionIdFactory: fixedSessionIds(['session:opaque-001']),
    clock: () => '2026-05-24T00:00:00.000Z',
  });

  const transparentRef = createBrowserSessionRef({ daemonId: 'daemon_local_001', runId: 'run_browser_001' });
  const record = registry.register({
    daemonId: 'daemon_local_001',
    runId: 'run_browser_001',
    transparentRef,
    mode: 'dedicated-daemon',
    targetUrlPreview: 'https://example.com/account',
  });

  // surrogate is opaque and does NOT contain the runId (unlike the transparent ref)
  assert.equal(record.sessionId, 'session:opaque-001');
  assert.equal(isOpaqueBrowserRef(record.sessionId), true);
  assert.equal(record.sessionId.includes('run_browser_001'), false);
  assert.equal(transparentRef.includes('run_browser_001'), true);

  // the transparent ref is retained registry-side only, keyed by the surrogate
  const looked = registry.get('session:opaque-001');
  assert.equal(looked.transparentRef, transparentRef);
  assert.equal(looked.runId, 'run_browser_001');
});

test('registry stores stale-target recreation context for resume (phase 3.6)', () => {
  const registry = new InMemoryBrowserSessionRegistry({
    sessionIdFactory: fixedSessionIds(['session:opaque-002']),
  });
  const transparentRef = createBrowserSessionRef({ daemonId: 'daemon_local_002', runId: 'run_browser_002' });
  registry.register({
    daemonId: 'daemon_local_002',
    runId: 'run_browser_002',
    transparentRef,
    mode: 'dedicated-daemon',
  });

  const updated = registry.update({
    sessionId: 'session:opaque-002',
    pageTargetRef: 'page:target-002',
    targetUrlPreview: 'https://example.com/dashboard',
  });

  assert.equal(updated.pageTargetRef, 'page:target-002');
  assert.equal(updated.targetUrlPreview, 'https://example.com/dashboard');
  assert.equal(registry.get('session:opaque-002').pageTargetRef, 'page:target-002');
});

test('registry rejects a non-opaque generated session id', () => {
  const registry = new InMemoryBrowserSessionRegistry({
    sessionIdFactory: () => 'ws://127.0.0.1:9222/devtools/browser/raw',
  });
  assert.throws(
    () =>
      registry.register({
        daemonId: 'daemon_local_003',
        runId: 'run_browser_003',
        transparentRef: 'daemon:daemon_local_003:session:run_browser_003',
        mode: 'dedicated-daemon',
      }),
    /opaque surrogate/,
  );
});

// Review finding #3: a factory returning the transparent daemon:...:session:...
// form must be rejected — that is exactly the linkable form checkpoints avoid.
test('registry rejects a transparent session ref as the surrogate id', () => {
  const registry = new InMemoryBrowserSessionRegistry({
    sessionIdFactory: () => 'daemon:daemon_local_005:session:run_browser_005',
  });
  assert.throws(
    () =>
      registry.register({
        daemonId: 'daemon_local_005',
        runId: 'run_browser_005',
        transparentRef: 'daemon:daemon_local_005:session:run_browser_005',
        mode: 'dedicated-daemon',
      }),
    /opaque surrogate/,
  );
});

test('forget removes a session record', () => {
  const registry = new InMemoryBrowserSessionRegistry({
    sessionIdFactory: fixedSessionIds(['session:opaque-004']),
  });
  registry.register({
    daemonId: 'daemon_local_004',
    runId: 'run_browser_004',
    transparentRef: 'daemon:daemon_local_004:session:run_browser_004',
    mode: 'dedicated-daemon',
  });
  assert.ok(registry.get('session:opaque-004'));
  registry.forget('session:opaque-004');
  assert.equal(registry.get('session:opaque-004'), undefined);
});

// Second-review finding #1: a colon-bearing ref part must not be able to mint a
// structurally-transparent surrogate that slips past the opacity check.
test('createBrowserSessionRef rejects a colon in a ref part', () => {
  assert.throws(
    () => createBrowserSessionRef({ daemonId: 'a:b', runId: 'run_browser_001' }),
    /opaque browser ref part/,
  );
});

test('registry rejects a colon-smuggled transparent surrogate id', () => {
  const registry = new InMemoryBrowserSessionRegistry({
    // would assemble to daemon:a:b:session:run if it leaked through
    sessionIdFactory: () => 'daemon:a:b:session:run_browser_006',
  });
  assert.throws(
    () =>
      registry.register({
        daemonId: 'daemon_local_006',
        runId: 'run_browser_006',
        transparentRef: 'daemon:daemon_local_006:session:run_browser_006',
        mode: 'dedicated-daemon',
      }),
    /opaque surrogate/,
  );
});

// Fourth-review finding: pageTargetRef must pass the opaque-ref guard, so raw
// websocket/devtools URLs and profile paths cannot be stored or read back.
test('registry rejects a websocket pageTargetRef on register', () => {
  const registry = new InMemoryBrowserSessionRegistry({
    sessionIdFactory: fixedSessionIds(['session:opaque-ws']),
  });
  assert.throws(
    () =>
      registry.register({
        daemonId: 'daemon_local_008',
        runId: 'run_browser_008',
        transparentRef: 'daemon:daemon_local_008:session:run_browser_008',
        mode: 'dedicated-daemon',
        pageTargetRef: 'ws://127.0.0.1:9222/devtools/page/RAW',
      }),
    /page target ref/,
  );
});

test('registry rejects a profile-path pageTargetRef on update', () => {
  const registry = new InMemoryBrowserSessionRegistry({
    sessionIdFactory: fixedSessionIds(['session:opaque-pp']),
  });
  registry.register({
    daemonId: 'daemon_local_009',
    runId: 'run_browser_009',
    transparentRef: 'daemon:daemon_local_009:session:run_browser_009',
    mode: 'dedicated-daemon',
  });
  assert.throws(
    () =>
      registry.update({
        sessionId: 'session:opaque-pp',
        pageTargetRef: '/Users/sean/Library/Application Support/Google/Chrome/Profile 1',
      }),
    /page target ref/,
  );
  // the bad update must not have mutated the record
  assert.equal(registry.get('session:opaque-pp').pageTargetRef, undefined);
});

test('registry accepts an opaque pageTargetRef', () => {
  const registry = new InMemoryBrowserSessionRegistry({
    sessionIdFactory: fixedSessionIds(['session:opaque-ok']),
  });
  registry.register({
    daemonId: 'daemon_local_010',
    runId: 'run_browser_010',
    transparentRef: 'daemon:daemon_local_010:session:run_browser_010',
    mode: 'dedicated-daemon',
    pageTargetRef: 'page:target-010',
  });
  assert.equal(registry.get('session:opaque-ok').pageTargetRef, 'page:target-010');
});

// Second-review finding #3: targetUrlPreview must be sanitized on write.
test('registry strips query secrets from targetUrlPreview on register and update', () => {
  const registry = new InMemoryBrowserSessionRegistry({
    sessionIdFactory: fixedSessionIds(['session:opaque-007']),
  });
  const registered = registry.register({
    daemonId: 'daemon_local_007',
    runId: 'run_browser_007',
    transparentRef: 'daemon:daemon_local_007:session:run_browser_007',
    mode: 'dedicated-daemon',
    targetUrlPreview: 'https://user:pass@example.com/account?token=RAWSECRET#frag',
  });

  assert.equal(registered.targetUrlPreview, 'https://example.com/account');
  assert.equal(registered.targetUrlPreview.includes('RAWSECRET'), false);
  assert.equal(registered.targetUrlPreview.includes('user:pass'), false);

  const updated = registry.update({
    sessionId: 'session:opaque-007',
    targetUrlPreview: 'https://example.com/next?code=ANOTHERSECRET',
  });
  assert.equal(updated.targetUrlPreview, 'https://example.com/next');
  assert.equal(JSON.stringify(registry.get('session:opaque-007')).includes('ANOTHERSECRET'), false);
});

// update() on a lookup miss must not echo a caller-supplied UNSAFE sessionId (a
// raw ws:// debugger URL + token) back in the error — same no-echo rule as the
// page target controller's incoming refs.
test('update() does not echo an unsafe sessionId on a lookup miss', () => {
  const registry = new InMemoryBrowserSessionRegistry();
  const unsafe = 'ws://127.0.0.1:9222/devtools/browser/RAW?token=SECRET';
  assert.throws(
    () => registry.update({ sessionId: unsafe, pageTargetRef: 'page:x' }),
    (err) => {
      assert.equal(err.message.includes('SECRET'), false);
      assert.equal(err.message.includes('ws://'), false);
      assert.equal(err.message.includes('devtools'), false);
      assert.match(err.message, /not found/);
      return true;
    },
  );
});

// ...but a safe-but-unknown surrogate is still named, so real misses stay debuggable.
test('update() still names a safe-but-unknown surrogate on a miss', () => {
  const registry = new InMemoryBrowserSessionRegistry();
  assert.throws(
    () => registry.update({ sessionId: 'session:does-not-exist', pageTargetRef: 'page:x' }),
    /session:does-not-exist not found/,
  );
});

// Codex review: a keyword-bearing id (e.g. session:access_token_...) passed
// isOpaqueSurrogateSessionId and got echoed. Now treated as unsafe -> redacted.
test('update() redacts a keyword-bearing sessionId on a miss', () => {
  const registry = new InMemoryBrowserSessionRegistry();
  const id = 'session:' + 'access' + '_token_ABCD'; // assembled so source has no literal token
  assert.throws(
    () => registry.update({ sessionId: id, pageTargetRef: 'page:x' }),
    (err) => {
      assert.equal(err.message.includes('access_token'), false);
      assert.match(err.message, /redacted-session-id/);
      return true;
    },
  );
});

// Codex review (follow-up): isOpaqueSurrogateSessionId still omitted `pat`, so a
// `session:pat_...` (personal access token) miss was echoed. Now redacted too.
test('update() redacts a pat-bearing sessionId on a miss', () => {
  const registry = new InMemoryBrowserSessionRegistry();
  const id = 'session:' + 'pat' + '_ABCD'; // assembled so source carries no literal PAT token
  assert.throws(
    () => registry.update({ sessionId: id, pageTargetRef: 'page:x' }),
    (err) => {
      assert.equal(err.message.includes('pat_ABCD'), false);
      assert.match(err.message, /redacted-session-id/);
      return true;
    },
  );
});

// Adversarial review (LEAK 1): a `keyword_<value>` surrogate defeated the `\b`
// trailing boundary (`_` is a word char) and was echoed verbatim on a miss. The
// alnum-boundary fix now classifies it unsafe -> redacted.
test('update() redacts a keyword_<value> sessionId (boundary-defeating) on a miss', () => {
  const registry = new InMemoryBrowserSessionRegistry();
  const id = 'otp' + '_LEAKEDSECRET'; // otp_ : keyword with no trailing word boundary
  assert.throws(
    () => registry.update({ sessionId: id, pageTargetRef: 'page:x' }),
    (err) => {
      assert.equal(err.message.includes('LEAKEDSECRET'), false);
      assert.match(err.message, /redacted-session-id/);
      return true;
    },
  );
});

// Second adversarial review (LEAK A): a combining-mark-split keyword surrogate
// (`sećret_...`) defeated the denylist and was echoed on a miss. Now redacted.
test('update() redacts a combining-mark-split sessionId on a miss', () => {
  const C = (n) => String.fromCodePoint(n);
  const registry = new InMemoryBrowserSessionRegistry();
  const id = 'se' + 'c' + C(0x301) + 'ret' + '_LEAKEDVAL'; // sećret_... (decomposed)
  assert.throws(
    () => registry.update({ sessionId: id, pageTargetRef: 'page:x' }),
    (err) => {
      assert.equal(err.message.includes('LEAKEDVAL'), false);
      assert.match(err.message, /redacted-session-id/);
      return true;
    },
  );
});
