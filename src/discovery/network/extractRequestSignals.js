'use strict';

const { headerValue } = require('./classifyNetworkEntry');

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-client-credential',
  'x-auth-token',
  'proxy-authorization',
]);

function safeHeaderNames(headers = {}) {
  return Object.keys(headers).filter((name) => !SENSITIVE_HEADERS.has(name.toLowerCase())).sort();
}

function detectAuthSignals(headers = {}) {
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  const signals = [];
  if (names.includes('authorization')) signals.push('authorization-header-present');
  if (names.includes('cookie')) signals.push('cookie-present');
  if (names.includes('x-client-credential')) signals.push('client-credential-header-present');
  if (names.includes('x-auth-token')) signals.push('auth-token-header-present');
  return signals;
}

function parseUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      origin: parsed.origin,
      pathname: parsed.pathname,
      queryParamNames: [...parsed.searchParams.keys()].sort(),
    };
  } catch {
    return { origin: undefined, pathname: url, queryParamNames: [] };
  }
}

function bodyShapeHint(bodyPreview) {
  if (!bodyPreview) return undefined;
  const trimmed = bodyPreview.trim();
  if (trimmed.startsWith('{')) return 'json-object';
  if (trimmed.startsWith('[')) return 'json-array';
  if (trimmed.includes('=')) return 'form-like';
  return 'text-preview';
}

function extractRequestSignals(entry) {
  const parsed = parseUrl(entry.url || '');
  return {
    method: (entry.method || 'GET').toUpperCase(),
    url: entry.url,
    origin: parsed.origin,
    pathname: parsed.pathname,
    queryParamNames: parsed.queryParamNames,
    contentType: headerValue(entry.requestHeaders, 'content-type'),
    safeHeaderNames: safeHeaderNames(entry.requestHeaders),
    authSignals: detectAuthSignals(entry.requestHeaders),
    bodyShape: bodyShapeHint(entry.requestBodyPreview),
  };
}

module.exports = { extractRequestSignals, detectAuthSignals, safeHeaderNames };
