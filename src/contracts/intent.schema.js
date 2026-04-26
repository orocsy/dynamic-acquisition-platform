'use strict';

const { isObject, validateRequired, validateEnum, validateArray, result } = require('./validate');

const IntentSchema = {
  name: 'Intent',
  version: '0.1',
  required: [
    'version',
    'intentId',
    'kind',
    'target.kind',
    'target.value',
    'objective.action',
    'objective.outputs',
  ],
  enums: {
    kind: ['acquire', 'inspect', 'validate'],
    'target.kind': ['url', 'site', 'query', 'document', 'workflow'],
    'target.scope': ['single-resource', 'collection', 'site', 'workflow-run', 'unknown'],
  },
};

function validateIntent(intent) {
  const errors = [];
  if (!isObject(intent)) return result(['Intent must be an object']);
  errors.push(...validateRequired(intent, IntentSchema.required));
  errors.push(...validateEnum(intent, 'kind', IntentSchema.enums.kind));
  errors.push(...validateEnum(intent, 'target.kind', IntentSchema.enums['target.kind']));
  errors.push(...validateEnum(intent, 'target.scope', IntentSchema.enums['target.scope']));
  if (intent.objective) errors.push(...validateArray(intent, 'objective.outputs'));
  return result(errors);
}

module.exports = { IntentSchema, validateIntent };
