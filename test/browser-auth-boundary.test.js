'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ConservativeAuthBoundaryDetector, isKnownAuthBoundaryReason } = require('../dist/browser');

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
  assert.ok(isKnownAuthBoundaryReason(result.signal.reason), result.signal.reason);
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

// Codex re-review of PR #4 (C1): a login page that returns 200 on a non-login URL (no
// redirect, no 401) must still be caught via corroborating login-FORM markers -- a single
// generic word stays WEAK (diagnostic only), two or more distinct markers signal login.
test('multiple login-form markers on a 200 page create a login signal; one stays weak', () => {
  const form = detector.detect({ pageTextPreview: 'Sign in\nEmail address\nPassword\nRemember me' });
  assert.equal(form.signal.kind, 'login-required');
  assert.equal(form.signal.source, 'page-snapshot');
  assert.equal(form.signal.reason, 'login-form-markers');
  assert.ok(form.signal.evidence.markerCount >= 2);

  const lone = detector.detect({ pageTextPreview: 'Sign in to see more recommendations' });
  assert.equal(lone.signal, undefined);
  assert.ok(lone.diagnostics.some((d) => d.code === 'auth-boundary-weak-marker'));
});

// Codex re-review of PR #4 (C5): an explicit CAPTCHA page also matches the generic
// `verification code` MFA phrase; the specific classification must win.
test('explicit captcha wording is classified as captcha, not mfa', () => {
  const result = detector.detect({ pageTextPreview: 'Enter the CAPTCHA verification code to continue' });
  assert.equal(result.signal.kind, 'captcha-required');
  assert.equal(result.signal.reason, 'captcha-page-marker');
});

// C1 output-safety: the login-form signal still emits no page-text fragment.
test('login-form signal carries no page-text fragment', () => {
  const result = detector.detect({ pageTextPreview: 'Sign in\nEmail SECRET_HANDLE\nPassword SECRET_PW' });
  assert.equal(result.signal.kind, 'login-required');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

// Codex re-review of PR #4 round 2 (D2): a multi-megabyte URL must not be parsed/returned/
// scanned -- it is dropped before sanitize, in BOTH the nav and observation paths.
test('detector bounds oversized nav and observation URLs before sanitizing', () => {
  const hugePath = 'https://app.example.com/login/' + 'a'.repeat(5_000_000);
  const started = Date.now();
  const navResult = detector.detect({ navigation: nav({ status: 401, finalUrlPreview: hugePath }) });
  assert.ok(Date.now() - started < 1_000, 'URL handling must be bounded');
  assert.equal(navResult.signal.kind, 'login-required'); // status rule still fires
  assert.equal(navResult.signal.urlPreview, undefined); // oversized preview dropped
  assert.equal(JSON.stringify(navResult).length < 10_000, true);

  const obsResult = detector.detect({
    observations: [{ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url: hugePath, method: 'GET' }, response: { status: 403 } }],
  });
  assert.equal(obsResult.signal.urlPreview, undefined);
});

// Codex re-review of PR #4 round 2 (D3): a lone ambiguous verify-family marker (not a login
// form) must still surface a diagnostic (Phase 3.5 weak/ambiguous contract).
test('an ambiguous verify marker still produces a diagnostic (no signal)', () => {
  const result = detector.detect({ pageTextPreview: 'Verify your account to continue' });
  assert.equal(result.signal, undefined);
  assert.ok(result.diagnostics.some((d) => d.code === 'auth-boundary-weak-marker'));
  assert.equal(JSON.stringify(result).includes('account'), false); // still no text fragment
});

// Codex re-review of PR #4 round 2 (D4): a lone "Forgot your password?" must count as ONE
// marker, not two, so an unrelated help article is not falsely signalled as a login page.
test('overlapping password phrasing counts as a single marker', () => {
  assert.equal(detector.detect({ pageTextPreview: 'Forgot your password? Reset it from your profile.' }).signal, undefined);
  // a genuine form (sign-in + password) is still caught
  assert.equal(detector.detect({ pageTextPreview: 'Sign in. Forgot your password?' }).signal.kind, 'login-required');
});
