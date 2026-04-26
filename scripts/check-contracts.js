'use strict';

const contracts = require('../src/contracts');

const samples = {
  intent: {
    version: '0.1',
    intentId: 'intent_01',
    kind: 'acquire',
    target: { kind: 'url', value: 'https://example.com/resource', scope: 'single-resource' },
    objective: { action: 'capture', outputs: ['html', 'metadata'] },
  },
  evidence: {
    version: '0.1',
    evidenceId: 'evidence_01',
    target: { kind: 'url', value: 'https://example.com/resource' },
    observations: [],
    provenance: [],
  },
  plan: {
    version: '0.1',
    planId: 'plan_01',
    intentId: 'intent_01',
    status: 'draft',
    strategy: { kind: 'request-replay-first' },
    steps: [],
  },
  artifact: {
    version: '0.1',
    artifactId: 'artifact_01',
    kind: 'bundle',
    status: 'ready',
    items: [],
  },
  failure: {
    version: '0.1',
    failureId: 'failure_01',
    kind: 'execution-failed',
    severity: 'recoverable',
    code: 'EXAMPLE',
    message: 'Example failure',
    retryable: true,
  },
};

const checks = [
  ['Intent', contracts.validateIntent(samples.intent)],
  ['Evidence', contracts.validateEvidence(samples.evidence)],
  ['Plan', contracts.validatePlan(samples.plan)],
  ['ArtifactContract', contracts.validateArtifactContract(samples.artifact)],
  ['StructuredFailure', contracts.validateStructuredFailure(samples.failure)],
];

let failed = false;
for (const [name, check] of checks) {
  if (!check.ok) {
    failed = true;
    console.error(`${name} failed:`);
    for (const error of check.errors) console.error(`  - ${error}`);
  }
}

if (failed) process.exit(1);
console.log('contract checks ok');
