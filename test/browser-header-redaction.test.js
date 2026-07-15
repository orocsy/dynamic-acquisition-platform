'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toSafeHeaderPreview, assertSafeBrowserObservation } = require('../dist/browser');

test('toSafeHeaderPreview keeps allowlisted values and redacts everything else by construction', () => {
  const preview = toSafeHeaderPreview({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer raw-secret-token',
    Cookie: 'sid=raw-cookie',
    'X-Custom-Tracking': 'some-value',
  });

  // allowlisted header values survive (lowercased names)
  assert.equal(preview.accept, 'application/json');
  assert.equal(preview['content-type'], 'application/json');

  // non-allowlisted values are redacted regardless of sensitivity
  assert.equal(preview.authorization, '[redacted]');
  assert.equal(preview.cookie, '[redacted]');
  assert.equal(preview['x-custom-tracking'], '[redacted]');

  // raw secrets never appear in the serialized preview
  assert.equal(JSON.stringify(preview).includes('raw-secret-token'), false);
  assert.equal(JSON.stringify(preview).includes('raw-cookie'), false);
});

test('a construction-time preview always passes the observation invariant check', () => {
  const observation = {
    id: 'observation_constructed',
    runId: 'run_browser_001',
    source: 'cdp',
    capturedAt: '2026-05-24T00:00:00.000Z',
    request: {
      url: 'https://example.com/account',
      method: 'GET',
      headersPreview: toSafeHeaderPreview({
        Accept: 'application/json',
        Authorization: 'Bearer raw-secret-token',
      }),
    },
  };
  assert.doesNotThrow(() => assertSafeBrowserObservation(observation));
});

test('invariant check rejects a non-allowlisted header carrying a raw value', () => {
  assert.throws(
    () =>
      assertSafeBrowserObservation({
        id: 'observation_unsafe',
        runId: 'run_browser_001',
        source: 'cdp',
        capturedAt: '2026-05-24T00:00:00.000Z',
        request: {
          url: 'https://example.com/account',
          method: 'GET',
          headersPreview: { 'x-tracking-id': 'raw-value' },
        },
      }),
    /must be redacted/,
  );
});

// Review finding #1: URL/filename-bearing allowlisted headers must not preserve
// raw values, or an OAuth code in a Location redirect would persist.
test('toSafeHeaderPreview strips query secrets from a Location redirect', () => {
  const preview = toSafeHeaderPreview({
    Location: 'https://example.com/callback?code=raw-oauth-code&state=raw-state#frag',
  });

  assert.equal(preview.location, 'https://example.com/callback');
  assert.equal(JSON.stringify(preview).includes('raw-oauth-code'), false);
  assert.equal(JSON.stringify(preview).includes('raw-state'), false);
});

test('toSafeHeaderPreview redacts content-disposition filename and etag tokens', () => {
  const preview = toSafeHeaderPreview({
    'Content-Disposition': 'attachment; filename="signed-token-abc123.pdf"',
    ETag: '"opaque-resource-version-xyz"',
  });

  assert.equal(preview['content-disposition'], '[redacted]');
  assert.equal(preview.etag, '[redacted]');
  assert.equal(JSON.stringify(preview).includes('signed-token-abc123'), false);
  assert.equal(JSON.stringify(preview).includes('opaque-resource-version-xyz'), false);
});

test('invariant check rejects a Location value that still carries a query string', () => {
  assert.throws(
    () =>
      assertSafeBrowserObservation({
        id: 'observation_unsanitized_location',
        runId: 'run_browser_001',
        source: 'cdp',
        capturedAt: '2026-05-24T00:00:00.000Z',
        response: {
          status: 302,
          headersPreview: { location: 'https://example.com/callback?code=raw-oauth-code' },
        },
      }),
    /must be redacted/,
  );
});

test('a sanitized Location preview passes the invariant check', () => {
  const observation = {
    id: 'observation_sanitized_location',
    runId: 'run_browser_001',
    source: 'cdp',
    capturedAt: '2026-05-24T00:00:00.000Z',
    response: {
      status: 302,
      headersPreview: toSafeHeaderPreview({ Location: 'https://example.com/callback?code=raw-oauth-code' }),
    },
  };
  assert.doesNotThrow(() => assertSafeBrowserObservation(observation));
});

// Review finding: a URL-bearing header with a non-http(s) scheme (a raw
// ws/devtools/chrome endpoint) was kept with only its query stripped, leaking the
// debugger URL. Now dropped at construction and rejected by the invariant — the
// same http(s)-only policy as sanitizeUrlPreview.
test('toSafeHeaderPreview drops a ws://devtools Location instead of keeping the endpoint', () => {
  const preview = toSafeHeaderPreview({
    Location: 'ws://127.0.0.1:9222/devtools/page/RAW?q=DROPME',
  });
  assert.equal(preview.location, '[redacted]');
  const blob = JSON.stringify(preview);
  assert.equal(blob.includes('ws://'), false);
  assert.equal(blob.includes('devtools'), false);
  assert.equal(blob.includes('DROPME'), false); // whole value dropped, query included
});

test('invariant rejects a Location with a non-http(s) scheme even after the query is stripped', () => {
  for (const loc of [
    'ws://127.0.0.1:9222/devtools/page/RAW',
    'wss://127.0.0.1:9222/devtools/browser/RAW',
    'chrome://version',
    'devtools://devtools/page/RAW',
  ]) {
    assert.throws(
      () =>
        assertSafeBrowserObservation({
          id: 'observation_nonhttp_location',
          runId: 'run_browser_001',
          source: 'cdp',
          capturedAt: '2026-05-24T00:00:00.000Z',
          response: { status: 302, headersPreview: { location: loc } },
        }),
      /must be redacted/,
      `expected ${loc} rejected`,
    );
  }
});

test('a relative or http(s) Location still passes the invariant', () => {
  for (const loc of ['/relative/path', 'https://example.com/ok']) {
    assert.doesNotThrow(() =>
      assertSafeBrowserObservation({
        id: 'observation_ok_location',
        runId: 'run_browser_001',
        source: 'cdp',
        capturedAt: '2026-05-24T00:00:00.000Z',
        response: { status: 302, headersPreview: { location: loc } },
      }),
    );
  }
});

// Codex review: the invariant's scheme check only matched `scheme://`, so opaque
// schemes (javascript:/data:/mailto:) and scheme-relative userinfo slipped past a
// prebuilt observation. Construction drops them; the invariant must too.
test('invariant rejects opaque/non-http, scheme-relative, and smuggled Locations', () => {
  const C = (n) => String.fromCharCode(n);
  const dt = '127.0.0.1:9222/devtools/browser/RAW';
  for (const loc of [
    'javascript:alert(1)',
    'data:text/html,raw',
    'mailto:a@b.com',
    '//x:y@host/path',
    '//' + dt, // scheme-relative devtools endpoint
    '/' + C(9) + '/' + dt, // tab-smuggled
    C(0) + '//' + dt, // NUL-smuggled
  ]) {
    assert.throws(
      () =>
        assertSafeBrowserObservation({
          id: 'observation_opaque_scheme',
          runId: 'run_browser_001',
          source: 'cdp',
          capturedAt: '2026-05-24T00:00:00.000Z',
          response: { status: 302, headersPreview: { location: loc } },
        }),
      /must be redacted/,
      `expected ${JSON.stringify(loc)} rejected`,
    );
  }
});

test('construction drops opaque-scheme, scheme-relative, and smuggled Locations', () => {
  const C = (n) => String.fromCharCode(n);
  const dt = '127.0.0.1:9222/devtools/browser/RAW';
  for (const loc of [
    'javascript:alert(1)',
    'data:text/html,raw',
    'mailto:a@b.com',
    '//x:y@host/path?q=1',
    '//' + dt,
    '/' + C(9) + '/' + dt, // tab-smuggled
    C(0x200b) + '//' + dt, // zero-width-smuggled
  ]) {
    assert.equal(toSafeHeaderPreview({ Location: loc }).location, '[redacted]', `expected redacted: ${JSON.stringify(loc)}`);
  }
});

// Adversarial review (LEAK 3): the relative-path allow-list permitted backslash, so
// `/\host` smuggled a host past construction AND the invariant (new URL treats
// `\`==`/`). Backslash is excluded from BOTH the relative and absolute allow-lists.
test('backslash-smuggled host Location is dropped at construction and rejected by the invariant', () => {
  const bs = String.fromCharCode(92);
  const loc = '/' + bs + 'evil.internal:9222/devtools/browser/RAW';
  assert.equal(toSafeHeaderPreview({ Location: loc }).location, '[redacted]');
  assert.equal(JSON.stringify(toSafeHeaderPreview({ Location: loc })).includes('evil.internal'), false);
  for (const bad of [loc, 'https://' + bs + 'evil.com/x', 'https://host' + bs + 'evil.com/x'])
    assert.throws(
      () => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', response: { status: 302, headersPreview: { location: bad } } }),
      /must be redacted/,
      `expected ${JSON.stringify(bad)} rejected`,
    );
});

// Adversarial review (LEAK 4 / deferred S2): assertSafeBrowserObservation validated
// only header previews, so a prebuilt observation's request.url or pageTargetRef
// carried raw query/userinfo/endpoints untouched. The invariant now validates both.
test('invariant rejects an unsanitized request.url', () => {
  const bs = String.fromCharCode(92);
  for (const url of [
    'http://host/cb?code=SECRETCODE', // query secret
    'https://user:PASS@host/x', // userinfo
    'ws://127.0.0.1:9222/devtools/page/RAW', // raw endpoint scheme
    '//evil.internal:9222/x', // scheme-relative host
    'javascript:alert(1)', // opaque scheme
    '/' + bs + 'evil.internal/x', // backslash host smuggle
  ])
    assert.throws(
      () => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url, method: 'GET' } }),
      /request\.url must be/,
      `expected request.url ${JSON.stringify(url)} rejected`,
    );
});

test('invariant rejects a non-page-shaped pageTargetRef', () => {
  for (const ref of ['ws://h:9222/devtools/RAW', '/Users/v/secret', 'session:uuid-1', 'not-a-page-ref', 'daemon:d:session:r'])
    assert.throws(
      () => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', pageTargetRef: ref }),
      /pageTargetRef must be/,
      `expected pageTargetRef ${JSON.stringify(ref)} rejected`,
    );
});

test('invariant accepts a sanitized request.url and a page:<id> pageTargetRef', () => {
  assert.doesNotThrow(() =>
    assertSafeBrowserObservation({
      id: 'o', runId: 'r', source: 'cdp', capturedAt: 't',
      pageTargetRef: 'page:target-1',
      request: { url: 'https://api.example.com/v1/users', method: 'GET' },
    }),
  );
  // a clean relative request.url is also accepted
  assert.doesNotThrow(() =>
    assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url: '/v1/users', method: 'GET' } }),
  );
});

// Fourth adversarial review: the relative-path allow-list admitted `?`/`#` (they sit
// inside the \x21-\x5b range), so a query/fragment-bearing relative URL — a keyword-
// free OAuth `code` / CAS `ticket` — passed the prebuilt-observation invariant while
// construction stripped it. The allow-list now rejects `?`/`#`, symmetric with the
// absolute one (a sanitized relative path carries neither).
test('invariant rejects a query/fragment-bearing relative request.url or header', () => {
  for (const url of ['/oauth2/callback?code=RAWCODE', '/cb#id_token=RAWTOK', '/p?a=b'])
    assert.throws(
      () => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url, method: 'GET' } }),
      /request\.url must be/,
      `expected request.url ${JSON.stringify(url)} rejected`,
    );
  // a keyword-free secret in a relative redirect header must be rejected too
  for (const loc of ['/redirect?code=RAWCODE', '/sso?ticket=RAWTICKET', '/cb#frag=RAWVAL'])
    assert.throws(
      () => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', response: { status: 302, headersPreview: { location: loc } } }),
      /must be redacted/,
      `expected Location ${JSON.stringify(loc)} rejected`,
    );
  // a clean relative path (no query/fragment) is still accepted
  assert.doesNotThrow(() =>
    assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url: '/oauth2/callback', method: 'GET' } }),
  );
});

// Fifth adversarial review: path parameters (;jsessionid=) bypassed URL sanitization
// (they live in pathname, not query). Construction now strips them; the invariant
// rejects a value still carrying one.
test('path params (;jsessionid=) are stripped on construction and rejected by the invariant', () => {
  const raw = 'jsessionid=9F8E7D6C5B4A39281706';
  assert.equal(toSafeHeaderPreview({ Location: '/dashboard;' + raw }).location, '/dashboard');
  assert.equal(toSafeHeaderPreview({ Location: 'https://app.example.com/dashboard;' + raw }).location, 'https://app.example.com/dashboard');
  assert.equal(JSON.stringify(toSafeHeaderPreview({ Location: '/dashboard;' + raw })).includes('9F8E7D6C5B4A39281706'), false);
  for (const v of ['/dashboard;' + raw, 'http://h/p;' + raw, '/p&code=RAWCODE'])
    assert.throws(
      () => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url: v, method: 'GET' } }),
      /request\.url must be/,
      `expected ${JSON.stringify(v)} rejected`,
    );
});

// Fifth adversarial review: assertHeaderPreviewSafe ran the sensitive-substring check
// before the URL-bearing check, so a legitimately sanitized Location whose PATH merely
// contains `session`/`secret`/`token` (e.g. /api/v2/sessions) was falsely rejected by
// its own gate. URL-bearing headers are now validated by isSanitizedUrlField first.
test('a sanitized URL-bearing header with a session/secret path segment passes the invariant', () => {
  for (const loc of ['/api/v2/sessions', '/files/secret-report.pdf', 'https://h.example.com/oauth/token']) {
    const preview = toSafeHeaderPreview({ Location: loc });
    assert.equal(preview.location, loc, `construction changed ${loc}`);
    assert.doesNotThrow(
      () => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', response: { status: 302, headersPreview: preview } }),
      `invariant falsely rejected sanitized ${loc}`,
    );
  }
});

// Codex re-review: CLEAN_ABSOLUTE_URL forbade `@` ANYWHERE, but `@` is legal in a path
// segment (an npm scoped-package CDN, `/@scope/pkg`). Construction emits it; the invariant
// now accepts it (only authority userinfo `@` — before the first `/` — is rejected).
test('invariant accepts @ in a URL path but still rejects userinfo @', () => {
  for (const url of ['https://cdn.example/@scope/pkg', 'https://h.example.com/users/@handle'])
    assert.doesNotThrow(
      () => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url, method: 'GET' } }),
      `expected ${url} accepted`,
    );
  // construction preserves the @ path segment
  assert.equal(toSafeHeaderPreview({ Location: 'https://cdn.example/@scope/pkg' }).location, 'https://cdn.example/@scope/pkg');
  // userinfo @ (in the authority) is still rejected
  assert.throws(
    () => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url: 'https://user:pass@host/x', method: 'GET' } }),
    /request\.url must be/,
  );
});

// Codex re-review #5/#6: an HTTP CDP debugger endpoint passed the http(s) header gate
// and the invariant, and a percent-encoded matrix delimiter (`%3B`=`;`) survived. Both
// are now dropped/rejected; a legit public /json/* API URL is still accepted.
test('header sanitizer + invariant drop http(s) CDP endpoints and percent-encoded params', () => {
  assert.equal(toSafeHeaderPreview({ Location: 'http://127.0.0.1:9222/devtools/page/RAWID' }).location, '[redacted]');
  assert.equal(toSafeHeaderPreview({ Location: 'https://app.example.com/d%3Bjsessionid=RAWSID' }).location.includes('RAWSID'), false);
  for (const url of ['http://127.0.0.1:9222/devtools/browser/RAWID', 'http://127.0.0.1:9222/json/version', 'https://app.example.com/d%3Bjsessionid=RAWSID'])
    assert.throws(
      () => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url, method: 'GET' } }),
      /request\.url must be/,
      `expected ${url} rejected`,
    );
  // a legit public /json/users API observation is accepted (not a CDP endpoint)
  assert.doesNotThrow(() =>
    assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url: 'https://api.example.com/json/users', method: 'GET' } }),
  );
});

// Codex re-review (round 6) #1/#4/#5: the invariant scopes the CDP rejection to a LOOPBACK
// host (a public /json/version is accepted), decodes the path (%64evtools rejected), and
// rejects encoded query/fragment delimiters (%3F/%23).
test('invariant scopes CDP rejection to loopback, decodes, and rejects encoded delimiters', () => {
  const acc = (url) => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url, method: 'GET' } });
  // public CDP-looking URLs are accepted
  for (const url of ['https://api.example.com/json/version', 'https://cdn.example.com/devtools/guide'])
    assert.doesNotThrow(() => acc(url), `expected ${url} accepted`);
  // loopback CDP (incl. percent-encoded) and encoded query delimiters are rejected
  for (const url of [
    'http://127.0.0.1:9222/json/version',
    'http://127.0.0.1:9222/%64evtools/browser/RAW',
    'https://app.example.com/callback%3Fcode=RAWCODE',
    'https://app.example.com/cb%23access_token=RAWT',
  ])
    assert.throws(() => acc(url), /request\.url must be/, `expected ${url} rejected`);
});

// Codex re-review (round 7): the invariant parses the value (not a raw regex), so octal/
// decimal/IPv6 loopback host spellings (canonicalized by new URL) are rejected; a relative
// URL with an encoded delimiter is rejected; a clean public URL is accepted.
test('invariant rejects every loopback host spelling and encoded-delimiter relative URL', () => {
  const acc = (url) => assertSafeBrowserObservation({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { url, method: 'GET' } });
  for (const url of ['http://0177.0.0.1:9222/devtools/browser/RAW', 'http://2130706433:9222/json/version', 'http://[::1]:9222/x', '/oauth2/callback%3Fcode=RAWCODE'])
    assert.throws(() => acc(url), /request\.url must be/, `expected ${url} rejected`);
  for (const url of ['https://api.example.com/json/version', 'https://api.example.com/v1/users', '/v1/users'])
    assert.doesNotThrow(() => acc(url), `expected ${url} accepted`);
});

// Phase 3.4 (MIU 1): request.queryParamNames carries the query param NAMES that the
// sanitized request.url strips, so the network->evidence bridge can preserve NAMES (not
// values, per design 7.6). The invariant validates each name is a clean value-less token
// (no '='/value, no '&'/'?'/'#'/'/'/'\\'/'%'/whitespace/control) so a name can't smuggle a
// value or a URL delimiter into a persisted observation.
test('invariant validates request.queryParamNames as clean value-less name tokens', () => {
  const base = { id: 'o', runId: 'r', source: 'cdp', capturedAt: 't' };
  const withNames = (queryParamNames) => ({ ...base, request: { url: 'https://api.example.com/v1/users', method: 'GET', queryParamNames } });
  // clean names (incl. array/dotted names and a sensitively-NAMED but value-less param) and [] are accepted
  for (const ok of [['page', 'page_size', 'sort-by'], ['ids[]', 'filter.name'], ['access_token'], []])
    assert.doesNotThrow(() => assertSafeBrowserObservation(withNames(ok)), JSON.stringify(ok));
  // a name carrying a value or a URL/structural delimiter is rejected
  for (const bad of [['a=b'], ['access_token=SECRET'], ['foo&bar'], ['x?y'], ['a#b'], ['a/b'], ['a\\b'], ['has space'], ['a%3Db'], ['']])
    assert.throws(() => assertSafeBrowserObservation(withNames(bad)), /queryParamNames/, JSON.stringify(bad));
});

// Codex re-review of PR #3 (#2, #3): a non-array queryParamNames (a bare string from daemon
// JSON) would iterate per-character and pass, then crash the mapper; and the observation id
// (copied into evidence source.ref + diagnostics) was never checked for opacity.
test('invariant rejects a non-array queryParamNames and a non-opaque observation id', () => {
  const base = { id: 'obs-1', runId: 'r', source: 'cdp', capturedAt: 't', request: { url: 'https://api.example.com/v1/users', method: 'GET' } };
  for (const qpn of ['page', 42, { 0: 'page' }])
    assert.throws(() => assertSafeBrowserObservation({ ...base, request: { ...base.request, queryParamNames: qpn } }), /queryParamNames must be an array/, JSON.stringify(qpn));
  for (const id of ['https://evil.example/x', 'Bearer abc.def', 'a/b', 'obs id', 'a:b'])
    assert.throws(() => assertSafeBrowserObservation({ ...base, id }), /id must be an opaque/, id);
  // a non-string id (malformed daemon JSON) is rejected, not String()-coerced
  for (const id of [['sk_live_SECRET'], 42, null, true])
    assert.throws(() => assertSafeBrowserObservation({ ...base, id }), /id must be an opaque, credential-free string token/, JSON.stringify(id));
  // Codex re-review of PR #3 (round 5): unlike a daemonId/runId ref PART (structural-only,
  // round 10 -- it only ever lands inside the redacted transparent ref), an observation id is
  // persisted STANDALONE as evidence source.ref + diagnostics entryId, so it follows the
  // surrogate-session-id rule: a separator-delimited credential MARKER is rejected too.
  for (const id of ['obs-123_token_req', 'access_token_abc123'])
    assert.throws(() => assertSafeBrowserObservation({ ...base, id }), /id must be an opaque, credential-free string token/, id);
  // a descriptive keyword-free opaque id is accepted (marker word only as a PREFIX of a longer
  // word stays accepted, per the merged-keyword rule: `tokenizer` is not `token`)
  assert.doesNotThrow(() => assertSafeBrowserObservation({ ...base, id: 'obs-123-req-7' }));
  assert.doesNotThrow(() => assertSafeBrowserObservation({ ...base, id: 'obs-tokenizer-eval' }));
});

// Codex re-review of PR #3 (#3, round 6): a non-string request.method would crash the
// normalizer's .toUpperCase(), and a free-form method STRING would be copied verbatim into
// stored/returned observations by pickSafeObservation -- so the gate requires a real HTTP
// method token, not merely a non-empty string.
test('invariant rejects a non-token request.method', () => {
  const base = { id: 'obs-1', runId: 'r', source: 'cdp', capturedAt: 't' };
  for (const method of [42, null, '', true, ['GET'], 'Bearer sk-live-METHODSECRET', 'GET/../'])
    assert.throws(() => assertSafeBrowserObservation({ ...base, request: { url: 'https://api.example.com/x', method } }), /method must be a valid HTTP method token/, JSON.stringify(method));
  assert.doesNotThrow(() => assertSafeBrowserObservation({ ...base, request: { url: 'https://api.example.com/x', method: 'POST' } }));
});

// Codex re-review of PR #3 (round 6): a colon in a relative path lets a whole absolute URL
// hide inside it (`/http://127.0.0.1:9222/...`), bypassing the loopback/scheme rejection by
// prefixing `/` -- the relative allow-list must exclude `:`.
test('invariant rejects a relative request.url smuggling an absolute/loopback endpoint', () => {
  const base = { id: 'obs-1', runId: 'r', source: 'cdp', capturedAt: 't' };
  for (const url of ['/http://127.0.0.1:9222/devtools/browser/RAWSECRET', '/ws://127.0.0.1:9222/x', '/a:b'])
    assert.throws(() => assertSafeBrowserObservation({ ...base, request: { url, method: 'GET' } }), /request.url/, url);
  assert.doesNotThrow(() => assertSafeBrowserObservation({ ...base, request: { url: '/api/v2/users', method: 'GET' } }));
});

// Codex re-review of PR #3 (round 6): camelCase credential markers (`accessToken_abc123`)
// defeated the alnum-bounded keyword test (the preceding lowercase letter satisfied the
// lookbehind), so the denylist also tests a camel-boundary-split view.
test('invariant rejects camelCase credential-marker observation ids', () => {
  const base = { id: 'obs-1', runId: 'r', source: 'cdp', capturedAt: 't', request: { url: 'https://api.example.com/x', method: 'GET' } };
  for (const id of ['accessToken_abc123', 'refreshToken_abc123', 'clientSecret', 'sessionApiKey'])
    assert.throws(() => assertSafeBrowserObservation({ ...base, id }), /id must be an opaque, credential-free string token/, id);
  // keyword-as-prefix stays accepted after the camel split too (`tokenizer` is not `token`)
  assert.doesNotThrow(() => assertSafeBrowserObservation({ ...base, id: 'myTokenizerRun' }));
});

// Codex re-review of PR #3 (round 7): three refinements of the round-6 fixes.
test('invariant rejects a percent-encoded colon smuggle in a relative request.url', () => {
  const base = { id: 'obs-1', runId: 'r', source: 'cdp', capturedAt: 't' };
  for (const url of ['/http%3a//127.0.0.1%3a9222/devtools/browser/RAW', '/cb%3Acode', '/x%3A80/y'])
    assert.throws(() => assertSafeBrowserObservation({ ...base, request: { url, method: 'GET' } }), /request.url/, url);
});

test('invariant accepts only allow-listed HTTP methods (an all-letter token is not enough)', () => {
  const base = { id: 'obs-1', runId: 'r', source: 'cdp', capturedAt: 't' };
  for (const method of ['SecretToken', 'BEARER', 'FETCH'])
    assert.throws(() => assertSafeBrowserObservation({ ...base, request: { url: 'https://api.example.com/x', method } }), /method must be a valid HTTP method token/, method);
  for (const method of ['delete', 'OPTIONS', 'Patch'])
    assert.doesNotThrow(() => assertSafeBrowserObservation({ ...base, request: { url: 'https://api.example.com/x', method } }), method);
});

test('invariant rejects acronym-camel credential-marker observation ids', () => {
  const base = { id: 'obs-1', runId: 'r', source: 'cdp', capturedAt: 't', request: { url: 'https://api.example.com/x', method: 'GET' } };
  for (const id of ['clientSECRETValue', 'sessionAPIKEYValue', 'run_CSRFDefense'])
    assert.throws(() => assertSafeBrowserObservation({ ...base, id }), /id must be an opaque, credential-free string token/, id);
});
