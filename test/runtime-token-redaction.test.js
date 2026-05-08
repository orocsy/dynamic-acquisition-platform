'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  containsUnsafeRuntimeSecrets,
  hashResumeToken,
  issueResumeToken,
  previewResumeToken,
  redactRuntimeRecord,
  sanitizeRuntimeUrl,
  verifyResumeToken,
} = require('../dist/runtime');

test('resume token helpers issue high-entropy token metadata without hash/preview revealing the raw token', () => {
  const issued = issueResumeToken();

  assert.match(issued.resumeToken, /^rt_/);
  assert.match(issued.resumeTokenHash, /^sha256:/);
  assert.notEqual(issued.resumeTokenHash, issued.resumeToken);
  assert.notEqual(issued.resumeTokenPreview, issued.resumeToken);
  assert.equal(issued.resumeTokenPreview.includes(issued.resumeToken), false);
  assert.equal(verifyResumeToken(issued.resumeToken, issued.resumeTokenHash).ok, true);
  assert.deepEqual(verifyResumeToken('wrong-token', issued.resumeTokenHash), {
    ok: false,
    code: 'invalid-resume-token',
    message: 'Resume token did not match the persisted hash.',
  });
});

test('resume token hash and preview are deterministic for a supplied token', () => {
  const token = 'rt_known_token_for_test';
  assert.equal(hashResumeToken(token), hashResumeToken(token));
  assert.equal(previewResumeToken(token), 'rt_know…test');
});

test('runtime URL sanitizer removes query values and fragments', () => {
  assert.equal(sanitizeRuntimeUrl('https://example.com/login?token=secret&code=123#frag'), 'https://example.com/login');
  assert.equal(sanitizeRuntimeUrl('/api/resource?signature=secret&code=123'), '/api/resource');
  assert.equal(sanitizeRuntimeUrl('api/resource?signature=secret&code=123'), 'api/resource');
});

test('runtime redaction removes credential-like keys recursively while preserving safe token metadata', () => {
  const rawToken = 'rt_sensitive_raw_token';
  const redacted = redactRuntimeRecord({
    url: 'https://example.com/login?token=secret&code=123',
    nested: {
      password: 'secret-password',
      Authorization: 'Bearer abc',
      cookie: 'session=abc',
      resumeToken: rawToken,
      resumeTokenHash: 'sha256:hash-only',
      resumeTokenPreview: 'rt_sens…oken',
      browserSessionRef: 'browser_session_opaque_001',
      unsafeBrowserSessionRef: '~/Library/Application Support/Chrome/Profile?cookie=session',
      safeRelativeUrl: 'api/resource?signature=secret&code=123',
      safeList: ['https://example.com/api?secret=value', { secretKey: 'secret-key' }],
    },
  });

  assert.equal(redacted.url, 'https://example.com/login');
  assert.equal(redacted.nested.password, '[redacted]');
  assert.equal(redacted.nested.Authorization, '[redacted]');
  assert.equal(redacted.nested.cookie, '[redacted]');
  assert.equal(redacted.nested.resumeToken, '[redacted]');
  assert.equal(redacted.nested.resumeTokenHash, 'sha256:hash-only');
  assert.equal(redacted.nested.resumeTokenPreview, 'rt_sens…oken');
  assert.equal(redacted.nested.browserSessionRef, 'browser_session_opaque_001');
  assert.equal(redacted.nested.unsafeBrowserSessionRef, '[redacted]');
  assert.equal(redacted.nested.safeList[0], 'https://example.com/api');
  assert.equal(redacted.nested.safeRelativeUrl, 'api/resource');
  assert.equal(redacted.nested.safeList[1].secretKey, '[redacted]');
  assert.equal(containsUnsafeRuntimeSecrets(redacted, [rawToken, 'secret-password', 'Bearer abc', 'session=abc', 'secret-key']), false);
});
