import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IssuedResumeToken, ResumeTokenHash, ResumeTokenVerificationResult } from './types';

const TOKEN_PREFIX = 'rt';
const HASH_PREFIX = 'sha256:';

export function hashResumeToken(resumeToken: string): ResumeTokenHash | string {
  return `${HASH_PREFIX}${createHash('sha256').update(resumeToken).digest('hex')}`;
}

export function previewResumeToken(resumeToken: string): string {
  if (resumeToken.length <= 12) return `${resumeToken.slice(0, 4)}…`;
  return `${resumeToken.slice(0, 7)}…${resumeToken.slice(-4)}`;
}

export function issueResumeToken(byteLength = 32): IssuedResumeToken {
  const resumeToken = `${TOKEN_PREFIX}_${randomBytes(byteLength).toString('base64url')}`;
  return {
    resumeToken,
    resumeTokenHash: hashResumeToken(resumeToken),
    resumeTokenPreview: previewResumeToken(resumeToken),
  };
}

export function verifyResumeToken(candidateToken: string, expectedHash: string): ResumeTokenVerificationResult {
  const candidateHash = hashResumeToken(candidateToken);
  const candidate = Buffer.from(candidateHash);
  const expected = Buffer.from(expectedHash);

  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    return { ok: false, code: 'invalid-resume-token', message: 'Resume token did not match the persisted hash.' };
  }

  return { ok: true };
}
