import { headerValue } from './classifyNetworkEntry';
import type { HeaderMap, RawNetworkEntry, RequestSignals } from './types';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-client-credential',
  'x-auth-token',
  'proxy-authorization',
]);

export function safeHeaderNames(headers: HeaderMap = {}): string[] {
  return Object.keys(headers).filter((name) => !SENSITIVE_HEADERS.has(name.toLowerCase())).sort();
}

export function detectAuthSignals(headers: HeaderMap = {}): string[] {
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  const signals: string[] = [];
  if (names.includes('authorization')) signals.push('authorization-header-present');
  if (names.includes('cookie')) signals.push('cookie-present');
  if (names.includes('x-client-credential')) signals.push('client-credential-header-present');
  if (names.includes('x-auth-token')) signals.push('auth-token-header-present');
  return signals;
}

function parseUrl(url: string): { origin?: string; pathname: string; queryParamNames: string[] } {
  try {
    const parsed = new URL(url);
    return {
      origin: parsed.origin,
      pathname: parsed.pathname,
      queryParamNames: [...parsed.searchParams.keys()].sort(),
    };
  } catch {
    return { pathname: url, queryParamNames: [] };
  }
}

function bodyShapeHint(bodyPreview?: string): RequestSignals['bodyShape'] {
  if (!bodyPreview) return undefined;
  const trimmed = bodyPreview.trim();
  if (trimmed.startsWith('{')) return 'json-object';
  if (trimmed.startsWith('[')) return 'json-array';
  if (trimmed.includes('=')) return 'form-like';
  return 'text-preview';
}

export function extractRequestSignals(entry: RawNetworkEntry): RequestSignals {
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
