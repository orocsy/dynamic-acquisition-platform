function parsePossiblyRelativeUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    try {
      return new URL(url, 'https://placeholder.invalid');
    } catch {
      return undefined;
    }
  }
}

export function sanitizeUrlForEvidence(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0] || url;
  }
}

export function queryParamNames(url: string): string[] {
  const parsed = parsePossiblyRelativeUrl(url);
  if (!parsed) return [];
  return [...parsed.searchParams.keys()].sort();
}

export function pathnameSegments(url: string): string[] {
  const parsed = parsePossiblyRelativeUrl(url);
  const pathname = parsed ? parsed.pathname : url.split(/[?#]/, 1)[0];
  return pathname.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
}
