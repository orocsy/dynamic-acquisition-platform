'use strict';

const { isObject, validateRequired, validateEnum, validateArray, result } = require('./validate');

const StructuredFailureSchema = {
  name: 'StructuredFailure',
  version: '0.1',
  required: [
    'version',
    'failureId',
    'kind',
    'severity',
    'code',
    'message',
    'retryable',
  ],
  severities: ['recoverable', 'blocked', 'fatal'],
};

function validateStructuredFailure(failure) {
  const errors = [];
  if (!isObject(failure)) return result(['StructuredFailure must be an object']);
  errors.push(...validateRequired(failure, StructuredFailureSchema.required));
  errors.push(...validateEnum(failure, 'severity', StructuredFailureSchema.severities));
  if (typeof failure.retryable !== 'boolean') errors.push('Invalid retryable: expected boolean');
  if (failure.fallbackCandidates !== undefined) errors.push(...validateArray(failure, 'fallbackCandidates'));
  return result(errors);
}

module.exports = { StructuredFailureSchema, validateStructuredFailure };
