'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSafeNavigationTarget, isPrivateOrLinkLocalHost, isUnspecifiedHost } = require('../dist/browser');

// Codex re-review of PR #5 round 15 (P1): "not loopback" is nowhere near "public". An allowed
// public endpoint redirecting to a private/link-local destination would otherwise reach
// intranet services or the cloud instance-metadata endpoint from an authenticated browser.
test('isSafeNavigationTarget rejects private, CGNAT, and link-local destinations', () => {
  const unsafe = [
    'http://10.0.0.1/x', 'http://10.255.255.255/x',
    'http://172.16.0.1/x', 'http://172.31.255.1/x',
    'http://192.168.0.1/x', 'http://192.168.255.1/x',
    'http://169.254.169.254/latest/meta-data/', 'http://169.254.0.1/x',
    'http://100.64.0.1/x', 'http://100.127.0.1/x',
    'http://[fe80::1]/x', 'http://[febf::1]/x',
    'http://[fc00::1]/x', 'http://[fd12:3456::1]/x',
    'http://[::ffff:10.0.0.1]/x', 'http://[::ffff:192.168.1.1]/x',
    // alternate spellings new URL canonicalizes
    'http://2130706433/x', 'http://0177.0.0.1/x', 'http://0x0a000001/x',
  ];
  for (const url of unsafe) {
    assert.equal(isSafeNavigationTarget(url), false, url);
  }
});

test('isSafeNavigationTarget still allows genuinely public destinations', () => {
  const safe = [
    'https://example.com/account',
    'http://example.com/account',
    'https://8.8.8.8/x',
    'https://172.32.0.1/x',   // just outside 172.16/12
    'https://100.128.0.1/x',  // just outside 100.64/10
    'https://11.0.0.1/x',     // just outside 10/8
    'https://[2606:4700::1111]/x',
  ];
  for (const url of safe) {
    assert.equal(isSafeNavigationTarget(url), true, url);
  }
});

test('the host predicates classify boundary cases exactly', () => {
  // private / link-local
  assert.equal(isPrivateOrLinkLocalHost('172.15.0.1'), false); // below the /12
  assert.equal(isPrivateOrLinkLocalHost('172.16.0.1'), true);
  assert.equal(isPrivateOrLinkLocalHost('172.31.0.1'), true);
  assert.equal(isPrivateOrLinkLocalHost('172.32.0.1'), false); // above the /12
  assert.equal(isPrivateOrLinkLocalHost('100.63.0.1'), false);
  assert.equal(isPrivateOrLinkLocalHost('100.64.0.1'), true);
  assert.equal(isPrivateOrLinkLocalHost('100.127.0.1'), true);
  assert.equal(isPrivateOrLinkLocalHost('100.128.0.1'), false);
  // a DNS NAME cannot be judged here -- resolution is the transport's obligation
  assert.equal(isPrivateOrLinkLocalHost('internal.corp.example'), false);
  // unspecified
  assert.equal(isUnspecifiedHost('0.0.0.0'), true);
  assert.equal(isUnspecifiedHost('::'), true);
  assert.equal(isUnspecifiedHost('example.com'), false);
});
