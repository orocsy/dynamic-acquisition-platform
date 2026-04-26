'use strict';

const { isObject, validateRequired, validateEnum, validateArray, result } = require('./validate');

const PlanSchema = {
  name: 'Plan',
  version: '0.1',
  required: [
    'version',
    'planId',
    'intentId',
    'status',
    'strategy.kind',
    'steps',
  ],
  statuses: ['draft', 'ready', 'running', 'blocked', 'completed', 'failed'],
};

const PlanStepSchema = {
  name: 'PlanStep',
  version: '0.1',
  required: [
    'stepId',
    'capabilityId',
    'backendPolicy.preferred',
    'inputs',
    'outputs',
  ],
};

function validatePlanStep(step) {
  const errors = [];
  if (!isObject(step)) return result(['PlanStep must be an object']);
  errors.push(...validateRequired(step, PlanStepSchema.required));
  errors.push(...validateArray(step, 'outputs'));
  return result(errors);
}

function validatePlan(plan) {
  const errors = [];
  if (!isObject(plan)) return result(['Plan must be an object']);
  errors.push(...validateRequired(plan, PlanSchema.required));
  errors.push(...validateEnum(plan, 'status', PlanSchema.statuses));
  errors.push(...validateArray(plan, 'steps'));
  if (Array.isArray(plan.steps)) {
    plan.steps.forEach((step, index) => {
      const stepResult = validatePlanStep(step);
      for (const error of stepResult.errors) errors.push(`steps[${index}]: ${error}`);
    });
  }
  return result(errors);
}

module.exports = { PlanSchema, PlanStepSchema, validatePlan, validatePlanStep };
