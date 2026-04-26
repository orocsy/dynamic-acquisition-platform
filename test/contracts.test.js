'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateIntent,
  validateEvidence,
  validatePlan,
  validateArtifactContract,
  validateStructuredFailure,
} = require('../src/contracts');

test('validates minimal v0 contract samples', () => {
  assert.equal(validateIntent({
    version: '0.1',
    intentId: 'intent_01',
    kind: 'acquire',
    target: { kind: 'url', value: 'https://example.com', scope: 'single-resource' },
    objective: { action: 'capture', outputs: ['html'] },
  }).ok, true);

  assert.equal(validateEvidence({
    version: '0.1',
    evidenceId: 'evidence_01',
    target: { kind: 'url', value: 'https://example.com' },
    observations: [],
    provenance: [],
  }).ok, true);

  assert.equal(validatePlan({
    version: '0.1',
    planId: 'plan_01',
    intentId: 'intent_01',
    status: 'draft',
    strategy: { kind: 'simple' },
    steps: [],
  }).ok, true);

  assert.equal(validateArtifactContract({
    version: '0.1',
    artifactId: 'artifact_01',
    kind: 'bundle',
    status: 'ready',
    items: [],
  }).ok, true);

  assert.equal(validateStructuredFailure({
    version: '0.1',
    failureId: 'failure_01',
    kind: 'execution-failed',
    severity: 'recoverable',
    code: 'EXAMPLE',
    message: 'Example',
    retryable: true,
  }).ok, true);
});
