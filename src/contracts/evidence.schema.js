'use strict';

const { isObject, validateRequired, validateArray, result } = require('./validate');

const EvidenceSchema = {
  name: 'Evidence',
  version: '0.1',
  required: [
    'version',
    'evidenceId',
    'target',
    'observations',
    'provenance',
  ],
};

function validateEvidence(evidence) {
  const errors = [];
  if (!isObject(evidence)) return result(['Evidence must be an object']);
  errors.push(...validateRequired(evidence, EvidenceSchema.required));
  errors.push(...validateArray(evidence, 'observations'));
  errors.push(...validateArray(evidence, 'provenance'));
  if (evidence.entities !== undefined) errors.push(...validateArray(evidence, 'entities'));
  if (evidence.requestFamilies !== undefined) errors.push(...validateArray(evidence, 'requestFamilies'));
  if (evidence.strategySignals !== undefined) errors.push(...validateArray(evidence, 'strategySignals'));
  if (evidence.gaps !== undefined) errors.push(...validateArray(evidence, 'gaps'));
  return result(errors);
}

module.exports = { EvidenceSchema, validateEvidence };
