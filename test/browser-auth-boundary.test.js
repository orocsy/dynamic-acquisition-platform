'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ConservativeAuthBoundaryDetector, KNOWN_AUTH_BOUNDARY_REASONS } = require('../dist/browser');

const detector = new ConservativeAuthBoundaryDetector();

function nav(over = {}) {
  return { ok: false, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], ...over };
}

// ---- abuse cases first (the recurring failure class is output that echoes input) ----

test('detector output never echoes page text, raw URLs, or header-like secrets', () => {
  const result = detector.detect({
    navigation: nav({ status: 401, finalUrlPreview: 'https://idp.example.com/login?code=URLSECRET&state=x#frag' }),
    pageTextPreview: 'Enter the verification code. Bearer sk-live-TEXTSECRET cookie=RAWCOOKIE',
  });
  assert.ok(result.signal);
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('URLSECRET'), false);
  assert.equal(blob.includes('TEXTSECRET'), false);
  assert.equal(blob.includes('RAWCOOKIE'), false);
  // the sanitized preview keeps host+path only
  assert.equal(result.signal.urlPreview, 'https://idp.example.com/login');
  // the reason is from the fixed vocabulary, never source text
  assert.ok(KNOWN_AUTH_BOUNDARY_REASONS.has(result.signal.reason), result.signal.reason);
});

test('detector drops an unsafe (loopback/ws) navigation preview instead of emitting it', () => {
  const result = detector.detect({ navigation: nav({ status: 403, finalUrlPreview: 'ws://127.0.0.1:9222/devtools/browser/RAWTARGET' }) });
  assert.ok(result.signal);
  assert.equal(result.signal.urlPreview, undefined);
  assert.equal(JSON.stringify(result).includes('RAWTARGET'), false);
});

test('detector bounds its scans on huge untrusted inputs', () => {
  const hugeText = 'x'.repeat(5_000_000) + ' verification code ';
  const started = Date.now();
  const result = detector.detect({ pageTextPreview: hugeText });
  assert.ok(Date.now() - started < 1_000, 'scan must be bounded');
  // the marker sits past the scan limit -> no signal, but a truncation diagnostic
  assert.equal(result.signal, undefined);
  assert.ok(result.diagnostics.some((d) => d.code === 'auth-boundary-page-text-truncated'));
  const manyObservations = Array.from({ length: 5_000 }, () => ({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't' }));
  const obsResult = detector.detect({ observations: manyObservations });
  assert.ok(obsResult.diagnostics.some((d) => d.code === 'auth-boundary-observations-truncated'));
});

test('detector tolerates malformed input without crashing', () => {
  assert.deepEqual(detector.detect({}), { diagnostics: [] });
  assert.equal(detector.detect({ navigation: nav({ status: 'unauthorized' }) }).signal, undefined);
  assert.equal(detector.detect({ observations: 'not-an-array' }).signal, undefined);
  assert.equal(detector.detect({ pageTextPreview: 42 }).signal, undefined);
});

// ---- the LLD §8.7 happy-path signals ----

test('a 401/403 navigation creates a login signal', () => {
  const result = detector.detect({ navigation: nav({ status: 401, finalUrlPreview: 'https://app.example.com/account' }) });
  assert.equal(result.signal.kind, 'login-required');
  assert.equal(result.signal.source, 'navigation');
  assert.equal(result.signal.reason, 'navigation-unauthorized-status');
  assert.ok(result.signal.confidence >= 0.8);
  assert.equal(result.signal.evidence.statusCode, 401);
});

test('an unauthorized network observation creates a login signal', () => {
  const result = detector.detect({
    observations: [
      { id: 'o1', runId: 'r', source: 'cdp', capturedAt: 't', request: { url: 'https://api.example.com/me', method: 'GET' }, response: { status: 403 } },
    ],
  });
  assert.equal(result.signal.kind, 'login-required');
  assert.equal(result.signal.source, 'network');
  assert.equal(result.signal.reason, 'network-unauthorized-status');
  assert.equal(result.signal.urlPreview, 'https://api.example.com/me');
});

test('a login-looking redirect URL creates a moderate login signal', () => {
  const result = detector.detect({ navigation: nav({ finalUrlPreview: 'https://sso.example.com/oauth2/authorize' }) });
  assert.equal(result.signal.kind, 'login-required');
  assert.equal(result.signal.reason, 'login-redirect-url');
  assert.ok(result.signal.confidence < 0.8);
});

test('MFA and captcha and consent page text create their signals', () => {
  assert.equal(detector.detect({ pageTextPreview: 'Enter the one-time code from your authenticator app' }).signal.kind, 'mfa-required');
  assert.equal(detector.detect({ pageTextPreview: 'Please verify you are human to continue' }).signal.kind, 'captcha-required');
  assert.equal(detector.detect({ pageTextPreview: 'You must accept the terms to continue' }).signal.kind, 'consent-required');
});

test('weak or ambiguous markers produce diagnostics only', () => {
  const result = detector.detect({ pageTextPreview: 'Sign in to see more recommendations' });
  assert.equal(result.signal, undefined);
  assert.ok(result.diagnostics.some((d) => d.code === 'auth-boundary-weak-marker'));
  // and the diagnostic never carries the text itself
  assert.equal(JSON.stringify(result).includes('recommendations'), false);
});
