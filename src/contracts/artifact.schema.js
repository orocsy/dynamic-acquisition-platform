'use strict';

const { isObject, validateRequired, validateEnum, validateArray, result } = require('./validate');

const ArtifactContractSchema = {
  name: 'ArtifactContract',
  version: '0.1',
  required: [
    'version',
    'artifactId',
    'kind',
    'status',
    'items',
  ],
  statuses: ['expected', 'writing', 'ready', 'validated', 'failed'],
};

function validateArtifactContract(artifact) {
  const errors = [];
  if (!isObject(artifact)) return result(['ArtifactContract must be an object']);
  errors.push(...validateRequired(artifact, ArtifactContractSchema.required));
  errors.push(...validateEnum(artifact, 'status', ArtifactContractSchema.statuses));
  errors.push(...validateArray(artifact, 'items'));
  return result(errors);
}

module.exports = { ArtifactContractSchema, validateArtifactContract };
