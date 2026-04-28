'use strict';

const STATIC_EXTENSIONS = /\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|map)(?:\?|#|$)/i;
const MEDIA_EXTENSIONS = /\.(?:mp4|webm|mov|mp3|wav|m4a|aac)(?:\?|#|$)/i;

function headerValue(headers, name) {
  if (!headers) return undefined;
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? headers[match] : undefined;
}

function classifyNetworkEntry(entry) {
  const reasons = [];
  const url = entry.url || '';
  const method = (entry.method || 'GET').toUpperCase();
  const contentType = headerValue(entry.responseHeaders, 'content-type') || entry.mimeType || '';
  const requestContentType = headerValue(entry.requestHeaders, 'content-type') || '';
  const bodyPreview = entry.requestBodyPreview || '';
  const resourceType = (entry.resourceType || '').toLowerCase();

  if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font' || STATIC_EXTENSIONS.test(url)) {
    return { category: 'static-asset', confidence: 0.95, reasons: ['static resource type or extension'] };
  }

  if (resourceType === 'media' || MEDIA_EXTENSIONS.test(url)) {
    return { category: 'media', confidence: 0.95, reasons: ['media resource type or extension'] };
  }

  if (/\/graphql(?:\?|#|$)/i.test(url) || /graphql/i.test(contentType) || /\b(query|mutation)\b/.test(bodyPreview)) {
    reasons.push('graphql endpoint or body shape');
    return { category: 'graphql', confidence: 0.86, reasons };
  }

  if (/token|refresh|session|oauth|auth/i.test(url)) {
    reasons.push('auth/session endpoint hint');
    return { category: 'auth-token-refresh', confidence: 0.78, reasons };
  }

  if (/json/i.test(contentType) || /json/i.test(requestContentType) || /\/api\//i.test(url)) {
    reasons.push('json content type or api path');
    return { category: 'api-json', confidence: 0.82, reasons };
  }

  if (/html/i.test(contentType) || resourceType === 'document') {
    reasons.push('html content type or document resource');
    return { category: 'document-html', confidence: 0.75, reasons };
  }

  return { category: 'unknown', confidence: method === 'GET' ? 0.4 : 0.5, reasons: ['no strong classifier signal'] };
}

module.exports = { classifyNetworkEntry, headerValue };
