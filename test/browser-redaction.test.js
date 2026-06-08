'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertSafeBrowserObservation,
  containsUnsafeBrowserData,
  createBrowserSessionRef,
  isOpaqueBrowserRef,
  redactBrowserDiagnosticData,
} = require('../dist/browser');

test('browser redaction masks query values and credential-like fields recursively', () => {
  const rawCookie = 'sid=raw-cookie';
  const rawAuthorization = 'Bearer raw-auth';
  const rawProfilePath = '~/Library/Application Support/Google/Chrome/Profile 1';
  const rawAbsoluteProfilePath = '/Users/sean/Library/Application Support/Google/Chrome/Profile 1';
  const redacted = redactBrowserDiagnosticData({
    url: 'https://example.com/account?token=secret&code=123#frag',
    nested: {
      cookie: rawCookie,
      authorization: rawAuthorization,
      setCookie: 'session=raw-set-cookie',
      profilePath: rawProfilePath,
      absoluteProfilePath: rawAbsoluteProfilePath,
      headersPreview: {
        accept: 'application/json',
        cookie: rawCookie,
      },
      urls: ['https://example.com/api?secret=value', '/api/resource?signature=secret'],
    },
  });

  assert.equal(redacted.url, 'https://example.com/account');
  assert.equal(redacted.nested.cookie, '[redacted]');
  assert.equal(redacted.nested.authorization, '[redacted]');
  assert.equal(redacted.nested.setCookie, '[redacted]');
  assert.equal(redacted.nested.profilePath, '[redacted]');
  assert.equal(redacted.nested.absoluteProfilePath, '[redacted]');
  assert.equal(redacted.nested.headersPreview.cookie, '[redacted]');
  assert.deepEqual(redacted.nested.urls, ['https://example.com/api', '/api/resource']);
  assert.equal(
    containsUnsafeBrowserData(redacted, [rawCookie, rawAuthorization, rawProfilePath, rawAbsoluteProfilePath, 'secret', 'raw-set-cookie']),
    false,
  );
});

test('browser ref helpers reject profile-like refs and preserve opaque refs', () => {
  const sessionRef = createBrowserSessionRef({ daemonId: 'daemon_local_001', runId: 'run_browser_001' });

  assert.equal(sessionRef, 'daemon:daemon_local_001:session:run_browser_001');
  assert.equal(isOpaqueBrowserRef(sessionRef), true);
  assert.equal(isOpaqueBrowserRef('page_target_001'), true);
  assert.equal(isOpaqueBrowserRef('~/Library/Application Support/Google/Chrome/Profile 1'), false);
  assert.equal(isOpaqueBrowserRef('ws://127.0.0.1:9222/devtools/browser/raw'), false);
  assert.throws(
    () => createBrowserSessionRef({ daemonId: 'daemon_local_001', runId: 'run_001?cookie=secret' }),
    /opaque browser ref part/,
  );

  const redacted = redactBrowserDiagnosticData({
    browserSessionRef: sessionRef,
    pageTargetRef: 'page_target_001',
    unsafeBrowserSessionRef: '~/Library/Application Support/Google/Chrome/Profile 1',
  });
  assert.equal(redacted.browserSessionRef, sessionRef);
  assert.equal(redacted.pageTargetRef, 'page_target_001');
  assert.equal(redacted.unsafeBrowserSessionRef, '[redacted]');
});

test('browser observation validation rejects unredacted sensitive header previews', () => {
  assert.throws(
    () => assertSafeBrowserObservation({
      id: 'observation_bad_header',
      runId: 'run_browser_001',
      source: 'daemon-fixture',
      capturedAt: '2026-05-24T00:00:00.000Z',
      request: {
        url: 'https://example.com/account',
        method: 'GET',
        headersPreview: { authorization: 'Bearer raw-auth' },
      },
    }),
    /must be redacted/,
  );

  assert.doesNotThrow(() => assertSafeBrowserObservation({
    id: 'observation_safe_header',
    runId: 'run_browser_001',
    source: 'daemon-fixture',
    capturedAt: '2026-05-24T00:00:00.000Z',
    request: {
      url: 'https://example.com/account',
      method: 'GET',
      headersPreview: { authorization: '[redacted]' },
    },
  }));

  assert.throws(
    () => assertSafeBrowserObservation({
      id: 'observation_bad_timing',
      runId: 'run_browser_001',
      source: 'daemon-fixture',
      capturedAt: '2026-05-24T00:00:00.000Z',
      timing: { durationMs: Number.NaN },
    }),
    /non-finite number/,
  );
});

// Review finding: isOpaqueBrowserRef only rejected EDGE whitespace, so internal
// whitespace / control / zero-width chars smuggled a transparent ref past the
// surrogate/opaque guards built on this predicate.
test('isOpaqueBrowserRef rejects internal whitespace, control, and zero-width chars', () => {
  assert.equal(isOpaqueBrowserRef('session:abc-123'), true);
  assert.equal(isOpaqueBrowserRef('daemon:d1:session:run1'), true);
  for (const bad of [
    'daemon\t:d1:session:run1', // tab
    'daemon\n:d1:session:run1', // newline
    'session:x\ndaemon:d1:session:run1', // embedded transparent ref after newline
    'daemon\u00a0:d1:session:run1', // NBSP
    'to\u200bken', // zero-width space split
    'a\u0000b', // NUL control char
    'a\u202eb', // RTL override
  ]) {
    assert.equal(isOpaqueBrowserRef(bad), false, `expected ${JSON.stringify(bad)} rejected`);
  }
});

// Review finding: the diagnostic denylist missed several credential keywords and
// full-width / zero-width obfuscations.
test('redactBrowserDiagnosticData redacts extended credential keywords and obfuscated forms', () => {
  // Assemble `keyword=value` at runtime via kv() so the SOURCE carries no literal
  // secret-shaped assignment - reads as a bad example AND trips the repo's pre-commit
  // secret scanner. The redactor matches on the keyword, not the value.
  const kv = (k, v) => k + '=' + v;
  const cases = [
    ['received ' + kv('jwt', 'FAKEJWTVAL') + ' now', 'FAKEJWTVAL'],
    [kv('csrf', 'FAKECSRFVAL') + ' rejected', 'FAKECSRFVAL'],
    [kv('private_key', 'FAKEKEYVAL') + ' found', 'FAKEKEYVAL'],
    [kv('pat', 'FAKEPATVAL') + ' used', 'FAKEPATVAL'],
    [kv('auth_code', 'FAKEAUTHVAL') + ' from idp', 'FAKEAUTHVAL'],
    [kv('session_id', 'FAKESESSVAL') + ' active', 'FAKESESSVAL'],
    ['\uff22\uff45\uff41\uff52\uff45\uff52 FWSECVAL', 'FWSECVAL'], // full-width Bearer
    ['to\u200b' + kv('ken', 'ZWSECVAL'), 'ZWSECVAL'], // zero-width-split token=
  ];
  for (const [value, secret] of cases) {
    const out = redactBrowserDiagnosticData({ note: value });
    assert.equal(JSON.stringify(out).includes(secret), false, `leaked ${secret} from ${JSON.stringify(value)}`);
  }
  // benign mentions survive; bare `code=` is deliberately NOT denylisted (HTTP status collision).
  assert.equal(redactBrowserDiagnosticData({ note: 'token refresh scheduled' }).note, 'token refresh scheduled');
  assert.equal(redactBrowserDiagnosticData({ note: 'returned code=200 ok' }).note, 'returned code=200 ok');
});

// Sweep result: every URL sanitizer should be http(s)-only. ftp:// isn't covered by
// the profile/ws denylist, so it exercises sanitizeBrowserUrl's scheme gate directly.
test('redactBrowserDiagnosticData drops an embedded non-http(s) URL, not just its query', () => {
  const out = redactBrowserDiagnosticData({ note: 'fetched ftp://host.example/dir/file?x=1 then done' });
  assert.equal(out.note.includes('ftp://'), false, out.note);
  assert.equal(out.note.includes('host.example'), false, out.note);
  // http(s) URLs are still kept (query stripped)
  assert.equal(redactBrowserDiagnosticData({ note: 'go https://ok.example/p?q=1' }).note, 'go https://ok.example/p');
});

// Codex review (round 2): a whole-string scheme-relative `//host` can be a raw
// endpoint, so it is redacted (salvaging it kept the host:port).
test('redactBrowserDiagnosticData redacts a whole-string scheme-relative URL', () => {
  assert.equal(redactBrowserDiagnosticData({ note: '//x:y@host.example/path?q=1' }).note, '[redacted]');
  assert.equal(redactBrowserDiagnosticData({ note: '//127.0.0.1:9222/devtools/browser/RAW' }).note, '[redacted]');
});

// Codex review (round 2): BROWSER_REF_UNSAFE_PATTERN missed token/jwt-style words,
// so a `session:access_token_...` id passed isOpaqueSurrogateSessionId and got
// echoed by the registry. The root predicate now rejects them.
test('isOpaqueBrowserRef rejects credential-keyword-bearing refs', () => {
  for (const bad of ['session:a-token-b', 'page:x-jwt-y', 'd-credential-e', 'r-csrf-1', 'q-private-key-z']) {
    assert.equal(isOpaqueBrowserRef(bad), false, `expected ${bad} rejected`);
  }
  // clean uuid-style refs still pass
  assert.equal(isOpaqueBrowserRef('session:1a2b-3c4d'), true);
  assert.equal(isOpaqueBrowserRef('page:abc-123'), true);
});

// Codex review: the denylist normalization stripped only an enumerated handful of
// zero-width chars and missed U+061C (Arabic Letter Mark) and other bidi/format
// chars, so `to<ALM>ken=SECRET` survived. The view now strips the WHOLE Unicode
// format + default-ignorable set, so every invisible smuggle collapses to `token=`.
test('redactBrowserDiagnosticData redacts credential assignments smuggled with any invisible char', () => {
  const C = (n) => String.fromCodePoint(n); // build invisibles at runtime; no literal invisibles in source
  const kv = (k, v) => k + '=' + v;
  const invisibles = [
    0x061c, // ARABIC LETTER MARK (the codex-flagged miss)
    0x200b, // ZERO WIDTH SPACE
    0x200e, // LEFT-TO-RIGHT MARK
    0x202e, // RIGHT-TO-LEFT OVERRIDE
    0x2060, // WORD JOINER
    0x2066, // LEFT-TO-RIGHT ISOLATE
    0xfeff, // ZERO WIDTH NO-BREAK SPACE / BOM
    0x00ad, // SOFT HYPHEN
    0x034f, // COMBINING GRAPHEME JOINER
    0x180e, // MONGOLIAN VOWEL SEPARATOR
    0x0600, // ARABIC NUMBER SIGN
  ];
  for (const cp of invisibles) {
    const secret = 'INVVAL' + cp.toString(16).toUpperCase();
    const value = 'to' + C(cp) + kv('ken', secret); // visually `token=SECRET`, split by an invisible
    const out = redactBrowserDiagnosticData({ note: value });
    assert.equal(JSON.stringify(out).includes(secret), false, `leaked secret smuggled by U+${cp.toString(16)}`);
  }
});

// Codex review: BROWSER_REF_UNSAFE_PATTERN omitted `pat`, so a `session:pat_ABCD`
// surrogate passed isOpaqueSurrogateSessionId and got echoed on a registry miss.
// Fix the CLASS: add the missing secret markers (pat/passwd/pwd/signature). `pat`
// is gated by a negative lookbehind so it rejects PAT markers (`pat_`, `github_pat_`)
// WITHOUT eating ordinary words that merely contain the letters.
test('isOpaqueBrowserRef rejects pat/passwd/pwd/signature secrets but keeps lookalike words', () => {
  const id = (...p) => p.join(''); // assemble so source carries no literal PAT-shaped token
  for (const bad of [
    id('session:pat', '_ABCD'),
    id('session:github', '_pat_', 'XYZ'),
    id('x-pat', '_2'), // separator-preceded PAT marker
    'page:pwd-dump',
    'd-passwd-1',
    'session:signature_v4',
  ]) {
    assert.equal(isOpaqueBrowserRef(bad), false, `expected ${bad} rejected`);
  }
  // Words that merely CONTAIN the letters must stay opaque (no over-rejection): the
  // lookbehind excludes letter-preceded `pat`, and `signature` is a full word (not `sig`).
  for (const ok of [
    'page:path-1',
    'page:pattern-x',
    'page:compat-mode',
    'page:compat_mode',
    'session:dispatch-7',
    'page:patient-records',
    'session:update-9',
    'page:design-1', // contains "sig" — must NOT match (we did not add bare `sig`)
  ]) {
    assert.equal(isOpaqueBrowserRef(ok), true, `expected ${ok} accepted`);
  }
});

// Adversarial review (LEAK 1): the word-anchored secret group used `\b...\b`, but
// `_` is a \w char, so a keyword immediately followed by `_` had NO trailing
// boundary — `otp_SECRET`, `secret_x`, `cookie_y` were all classified opaque, then
// persisted and echoed. Alnum-boundary lookarounds treat `_`/`-`/`:` as separators.
test('isOpaqueBrowserRef rejects keyword_<value> forms the word boundary missed', () => {
  const sep = (k) => k + '_LEAK'; // keyword glued to `_value` (the boundary-defeating shape)
  for (const k of ['cookie', 'authorization', 'bearer', 'set-cookie', 'profile', 'user-data-dir', 'password', 'secret', 'mfa', 'otp', 'captcha', 'websocket', 'devtools', 'api_key'])
    assert.equal(isOpaqueBrowserRef(sep(k)), false, `expected ${sep(k)} rejected`);
  // `-`/`:`-delimited variants are caught too
  for (const bad of ['session:secret-1', 'page:otp-9', 'd-password-x', 'run:bearer-2'])
    assert.equal(isOpaqueBrowserRef(bad), false, `expected ${bad} rejected`);
  // a keyword glued INSIDE a longer alnum word stays opaque (no over-rejection)
  for (const ok of ['page:secretary-list', 'session:profiler-1', 'page:recaptcha-x'])
    assert.equal(isOpaqueBrowserRef(ok), true, `expected ${ok} accepted`);
});

// Adversarial review (LEAK 2): isOpaqueBrowserRef did NOT NFKC-normalize, so a
// full-width / compatibility-form keyword (ASCII only after folding) passed as
// opaque and was persisted/echoed. The predicate now folds an NFKC view first.
test('isOpaqueBrowserRef rejects full-width / compatibility-form secret keywords', () => {
  // build full-width forms at runtime; no literal full-width chars in source
  const fw = (s) => [...s].map((c) => { const x = c.codePointAt(0); return x >= 0x21 && x <= 0x7e ? String.fromCodePoint(x - 0x21 + 0xff01) : c; }).join('');
  for (const k of ['token', 'secret', 'cookie', 'password', 'bearer', 'jwt', 'devtools', 'signature'])
    assert.equal(isOpaqueBrowserRef('session:' + fw(k) + '_LEAK'), false, `expected full-width ${k} rejected`);
  assert.equal(isOpaqueBrowserRef('session:' + fw('pat_') + 'ABCD'), false, 'expected full-width pat_ rejected');
  // a normal ASCII opaque ref is unaffected by the NFKC view
  assert.equal(isOpaqueBrowserRef('session:opaque-001'), true);
});

// Second adversarial review (LEAK A): a combining mark between keyword letters
// (`to´ken`, `sećret`) broke every denylist — the views stripped format/zero-width
// chars but not Marks, and NFKC recomposes accents instead of dropping them. The
// views now use NFKD + strip \p{M}, so the split collapses back to the keyword.
test('redactBrowserDiagnosticData redacts credential assignments split by a combining mark', () => {
  const C = (n) => String.fromCodePoint(n);
  const kv = (k, v) => k + '=' + v;
  const marks = [0x0301, 0x0300, 0x0651, 0x0489, 0x0903, 0x05b0, 0x20dd]; // Mn / Mc / Me
  for (const m of marks) {
    const secret = 'MARKVAL' + m.toString(16).toUpperCase();
    const value = 't' + C(m) + 'o' + kv('ken', secret); // `t<mark>oken=SECRET`
    const out = redactBrowserDiagnosticData({ note: value });
    assert.equal(JSON.stringify(out).includes(secret), false, `leaked via combining mark U+${m.toString(16)}`);
  }
});

test('isOpaqueBrowserRef rejects combining-mark-split and precomposed-accent keyword refs', () => {
  const C = (n) => String.fromCodePoint(n);
  // decomposed: base letter + standalone combining mark (caught by REF_FORBIDDEN \p{M})
  assert.equal(isOpaqueBrowserRef('se' + 'c' + C(0x301) + 'ret_LEAK'), false);
  assert.equal(isOpaqueBrowserRef('dev' + C(0x301) + 'tools_LEAK'), false);
  // precomposed accent (a single letter, no standalone mark): caught by the NFKD-folded view
  assert.equal(isOpaqueBrowserRef('se' + C(0x107) + 'ret_LEAK'), false); // sećret
  assert.equal(isOpaqueBrowserRef('t' + C(0xf3) + 'ken_LEAK'), false); // tóken
  // a clean ASCII ref is unaffected
  assert.equal(isOpaqueBrowserRef('session:opaque-001'), true);
});

// Second adversarial review (LEAK B): PROFILE_LIKE_VALUE_PATTERN was tested on the
// raw value only, so a full-width profile path / endpoint keyword survived verbatim.
// It now tests an NFKD-folded view too.
test('redactBrowserDiagnosticData redacts full-width profile/endpoint keywords', () => {
  const fw = (s) => [...s].map((c) => { const x = c.codePointAt(0); return x >= 0x21 && x <= 0x7e ? String.fromCodePoint(x - 0x21 + 0xff01) : c; }).join('');
  for (const value of [
    fw('user-data-dir') + '=/home/v/.config/google-chrome/PROFVAL_A',
    fw('chrome') + '://settings/passwords PROFVAL_B',
    'x' + fw('devtools') + 'y_PROFVAL_C',
  ])
    assert.equal(redactBrowserDiagnosticData({ note: value }).note, '[redacted]', `expected redacted: ${JSON.stringify(value)}`);
});

// Third adversarial review: shouldRedactKey tested the raw key only, so a sensitive
// KEY disguised by a full-width / accented / combining-mark form dodged redaction and
// a keyword-free secret VALUE (no keyword/=/scheme/path to trip a value-side guard)
// leaked verbatim. The key name is now folded too.
test('redactBrowserDiagnosticData redacts a secret under a fold-disguised sensitive key', () => {
  const C = (n) => String.fromCodePoint(n);
  const fw = (s) => [...s].map((c) => { const x = c.codePointAt(0); return x >= 0x21 && x <= 0x7e ? String.fromCodePoint(x - 0x21 + 0xff01) : c; }).join('');
  const secret = 'abc123def456ghi789'; // bare opaque token: no keyword, =, scheme, or path
  for (const obj of [
    { [fw('cookie')]: secret }, // full-width key
    { [fw('authorization')]: secret },
    { ['authoriza' + C(0x301) + 'tion']: secret }, // combining-mark-split key
    { ['t' + C(0xf3) + 'ken']: secret }, // precomposed-accent key (token)
  ])
    assert.equal(JSON.stringify(redactBrowserDiagnosticData(obj)).includes(secret), false, `leaked under key ${JSON.stringify(Object.keys(obj)[0])}`);
  // an ASCII sensitive key still redacts; a non-sensitive key keeps a safe value
  assert.equal(redactBrowserDiagnosticData({ cookie: secret }).cookie, '[redacted]');
  assert.equal(redactBrowserDiagnosticData({ note: 'plain text' }).note, 'plain text');
});

// Sixth adversarial review: sanitizeBrowserUrl (the diagnostics URL sanitizer — the
// THIRD sanitizer) was missed by the path-param fix; it stripped query/fragment/userinfo
// but kept `;jsessionid=` path params, so a redirect session id surfaced verbatim in a
// navigation diagnostic. It now strips path params like its two siblings.
test('redactBrowserDiagnosticData strips matrix/path params (;jsessionid=) from diagnostic URLs', () => {
  const raw = 'jsessionid=9F8E7D6C5B4A39281706';
  // absolute URL embedded mid-string: path param dropped, base URL kept
  const a = redactBrowserDiagnosticData({ note: 'redirected to https://app.test/dashboard;' + raw + ' then back' });
  assert.equal(a.note.includes('9F8E7D6C5B4A39281706'), false, a.note);
  assert.equal(a.note.includes('https://app.test/dashboard'), true, a.note);
  // whole-string relative ref: truncated at the path-param delimiter
  assert.equal(redactBrowserDiagnosticData({ note: '/account/dashboard;' + raw }).note, '/account/dashboard');
  // stray &-param too
  assert.equal(redactBrowserDiagnosticData({ note: 'go https://app.test/cb&code=AUTHCODE' }).note.includes('AUTHCODE'), false);
  // a clean URL with no params is unchanged
  assert.equal(redactBrowserDiagnosticData({ note: 'at https://app.test/dashboard' }).note, 'at https://app.test/dashboard');
});

// Seventh review (trivial in-intent gap): PROFILE_LIKE_VALUE_PATTERN redacted
// chrome://, ws://, and devtools endpoints but omitted file:// — the same
// local/internal-scheme class — so a `file:///Users/.../.aws/credentials` path
// surfaced in a navigation diagnostic. file:// is now redacted too.
test('redactBrowserDiagnosticData redacts a file:// local path', () => {
  assert.equal(redactBrowserDiagnosticData({ note: 'file:///Users/me/.aws/credentials' }).note, '[redacted]');
  assert.equal(redactBrowserDiagnosticData({ note: 'tried file:///etc/passwd then gave up' }).note, '[redacted]');
  // a normal http(s) URL is unaffected by the file:// rule
  assert.equal(redactBrowserDiagnosticData({ note: 'at https://app.test/home' }).note, 'at https://app.test/home');
});

// Codex re-review (P2): the substring keyword group rejected legit ids that merely
// contain a keyword as the PREFIX of a longer word (run_tokenizer_eval, run_jwtable,
// run_csrfDefense), which failed browser session registration for safe runs. Keywords
// are now alnum-bounded, so a prefix-glued keyword is accepted while a separator-
// delimited secret marker is still rejected.
test('isOpaqueBrowserRef accepts legit ids whose keyword is a prefix of a longer word', () => {
  for (const ok of [
    'run_tokenizer_eval',
    'run_jwtable',
    'run_csrfDefense',
    'daemon_secretary_1',
    'run_signatures_index',
    'run_credentialing_v2',
  ])
    assert.equal(isOpaqueBrowserRef(ok), true, `expected ${ok} accepted`);
  // a separator-delimited secret marker is still rejected (security preserved)
  for (const bad of ['run_token_DEADBEEF', 'session:access_token_ABCD', 'd-jwt-RAWVAL', 'x_csrf_RAWVAL'])
    assert.equal(isOpaqueBrowserRef(bad), false, `expected ${bad} rejected`);
});

// Codex re-review #5: the ref denylist omitted auth_code / session_id (which the value
// side treats as credentials), so session:auth_code_ABCD passed isOpaqueSurrogateSessionId
// and was echoed on a registry miss. Now rejected.
test('isOpaqueBrowserRef rejects auth_code / session_id surrogate markers', () => {
  for (const bad of ['session:auth_code_ABCD', 'session:session_id_ABCD', 'd-auth-code-1'])
    assert.equal(isOpaqueBrowserRef(bad), false, `expected ${bad} rejected`);
  // a normal session surrogate (no _id marker right after `session`) is still accepted
  assert.equal(isOpaqueBrowserRef('session:uuid-1'), true);
  assert.equal(isOpaqueBrowserRef('session:opaque-001'), true);
});

// Codex re-review #2: SENSITIVE_KEY_PATTERN drifted behind the credential names, so a
// bare opaque secret under a jwt/pat/csrf/private_key/auth_code KEY leaked (no `=value`
// for the value-side regex to catch). The key pattern is now in sync.
test('redactBrowserDiagnosticData redacts a bare secret under an extended credential key', () => {
  for (const k of ['jwt', 'pat', 'csrf', 'xsrf', 'private_key', 'auth_code', 'bearer', 'clientSecret', 'signature']) {
    const out = redactBrowserDiagnosticData({ [k]: 'bareOpaqueSecretValue' });
    assert.equal(out[k], '[redacted]', `expected key ${k} redacted`);
  }
  // collision-prone benign keys keep their value (pat is alnum-bounded)
  for (const k of ['requestPath', 'updatePath', 'pattern', 'durationMs'])
    assert.equal(redactBrowserDiagnosticData({ [k]: '/api/v2/users' })[k], '/api/v2/users', `expected key ${k} kept`);
});

// Codex re-review #3: sanitizeBrowserUrl's http(s)-only gate only saw scheme:// forms;
// opaque schemes (data:/javascript:/chrome-extension:/blob:, no //) bypassed it in prose.
// They are now matched and dropped.
test('redactBrowserDiagnosticData drops opaque non-http URL schemes in prose', () => {
  for (const [note, secret] of [
    ['open data:text/html,RAWPAYLOAD now', 'RAWPAYLOAD'],
    ['ran javascript:alert(RAWXSS) ok', 'RAWXSS'],
    ['ext chrome-extension://abcdef/p.html done', 'abcdef'],
    ['blob blob:https://o/RAWUUID end', 'RAWUUID'],
  ])
    assert.equal(redactBrowserDiagnosticData({ note }).note.includes(secret), false, `leaked ${secret} from ${JSON.stringify(note)}`);
  // a benign `data:`/`metadata:` mention (no URL form — space or word-boundary) is kept
  assert.equal(redactBrowserDiagnosticData({ note: 'the data: field shows metadata: x' }).note, 'the data: field shows metadata: x');
});

// Codex re-review #4: path-param stripping only ran for whole-string relative values; a
// relative URL embedded in prose (with spaces) kept its ;jsessionid=. Now stripped globally.
test('redactBrowserDiagnosticData strips path params from a relative URL embedded in prose', () => {
  assert.equal(
    redactBrowserDiagnosticData({ note: 'redirected to /account;jsessionid=SECRETSID then back' }).note,
    'redirected to /account then back',
  );
  assert.equal(redactBrowserDiagnosticData({ note: 'hit /cb&code=RAWCODE next' }).note.includes('RAWCODE'), false);
  // a clean relative path in prose is unchanged
  assert.equal(redactBrowserDiagnosticData({ note: 'went to /account/dashboard ok' }).note, 'went to /account/dashboard ok');
});
