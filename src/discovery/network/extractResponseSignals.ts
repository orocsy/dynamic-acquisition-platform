import { headerValue } from './classifyNetworkEntry';
import type { RawNetworkEntry, ResponseSignals } from './types';

export function responseShapeHint(entry: RawNetworkEntry): ResponseSignals['bodyShape'] {
  const body = (entry.responseBodyPreview || '').trim();
  const contentType = headerValue(entry.responseHeaders, 'content-type') || entry.mimeType || '';
  if (/json/i.test(contentType)) {
    if (body.startsWith('[')) return 'json-list';
    if (body.startsWith('{')) return 'json-object';
    return 'json';
  }
  if (/html/i.test(contentType)) return 'html-document';
  if (/pdf/i.test(contentType)) return 'downloadable-pdf';
  return body ? 'text-preview' : undefined;
}

export function paginationHints(entry: RawNetworkEntry): string[] {
  const hints: string[] = [];
  const body = entry.responseBodyPreview || '';
  const link = headerValue(entry.responseHeaders, 'link');
  if (link && /rel=["']?next/i.test(link)) hints.push('link-header-next');
  if (/"next"\s*:/i.test(body)) hints.push('json-next-field');
  if (/"page"\s*:/i.test(body) || /"cursor"\s*:/i.test(body)) hints.push('json-page-or-cursor-field');
  return hints;
}

export function extractResponseSignals(entry: RawNetworkEntry): ResponseSignals {
  return {
    status: entry.status,
    contentType: headerValue(entry.responseHeaders, 'content-type') || entry.mimeType,
    bodyShape: responseShapeHint(entry),
    paginationHints: paginationHints(entry),
    durationMs: entry.durationMs,
  };
}
