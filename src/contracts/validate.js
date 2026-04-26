'use strict';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getPath(value, path) {
  return path.split('.').reduce((current, key) => (current == null ? undefined : current[key]), value);
}

function validateRequired(value, requiredPaths) {
  const errors = [];
  for (const path of requiredPaths) {
    const field = getPath(value, path);
    if (field === undefined || field === null || field === '') {
      errors.push(`Missing required field: ${path}`);
    }
  }
  return errors;
}

function validateEnum(value, path, allowed) {
  const field = getPath(value, path);
  if (field === undefined || field === null) return [];
  return allowed.includes(field) ? [] : [`Invalid ${path}: expected one of ${allowed.join(', ')}`];
}

function validateArray(value, path) {
  const field = getPath(value, path);
  return Array.isArray(field) ? [] : [`Invalid ${path}: expected array`];
}

function result(errors) {
  return { ok: errors.length === 0, errors };
}

module.exports = {
  isObject,
  getPath,
  validateRequired,
  validateEnum,
  validateArray,
  result,
};
