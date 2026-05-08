import type { RuntimeSafeData } from './types';

const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN = /(?:password|passwd|pwd|secret|authorization|cookie|set-cookie|api[-_]?key|token|mfa|otp|captcha|session)/i;
const SAFE_PERSISTED_METADATA_KEYS = new Set(['resumeTokenHash', 'resumeTokenPreview']);
const BROWSER_SESSION_REF_UNSAFE_VALUE_PATTERN = /(?:^\/|^~\/|^[a-z]:[\\/]|[?&=]|\b(?:cookie|authorization|bearer|set-cookie|profile|user-data-dir)\b)/i;

export function sanitizeRuntimeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] || value;
  }
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^\//.test(value) || /^[^\s?#]+(?:\/[^\s?#]*)?\?[^\s#]*=/.test(value);
}

function shouldRedactKey(key: string): boolean {
  if (SAFE_PERSISTED_METADATA_KEYS.has(key)) return false;
  if (key === 'browserSessionRef') return false;
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function isOpaqueBrowserSessionRef(value: string): boolean {
  return value.trim().length > 0 && !BROWSER_SESSION_REF_UNSAFE_VALUE_PATTERN.test(value);
}

export function redactBrowserSessionRef(value: string): string {
  return isOpaqueBrowserSessionRef(value) ? value : REDACTED;
}

export function redactRuntimeData<T extends RuntimeSafeData>(data: T): T {
  if (data === null || typeof data === 'number' || typeof data === 'boolean') return data;
  if (typeof data === 'string') return (looksLikeUrl(data) ? sanitizeRuntimeUrl(data) : data) as T;
  if (Array.isArray(data)) return data.map((item) => redactRuntimeData(item)) as T;

  const redacted: Record<string, RuntimeSafeData> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'browserSessionRef') {
      redacted[key] = typeof value === 'string' ? redactBrowserSessionRef(value) : REDACTED;
      continue;
    }
    if (shouldRedactKey(key)) {
      redacted[key] = REDACTED;
      continue;
    }
    redacted[key] = redactRuntimeData(value);
  }
  return redacted as T;
}

export function redactRuntimeRecord<T extends Record<string, RuntimeSafeData>>(record: T): T {
  return redactRuntimeData(record) as T;
}

export function stripRuntimeSecretFields<T extends Record<string, unknown>>(record: T): T {
  const stripped = { ...record };
  for (const key of Object.keys(stripped)) {
    if (shouldRedactKey(key)) {
      delete stripped[key];
    }
  }
  return stripped;
}

export function containsUnsafeRuntimeSecrets(data: RuntimeSafeData, unsafeValues: readonly string[]): boolean {
  const serialized = JSON.stringify(data);
  return unsafeValues.some((value) => value.length > 0 && serialized.includes(value));
}
