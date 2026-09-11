// SPDX-License-Identifier: Apache-2.0

/** Execute the deliberately small JSON-Schema subset used by the canary contracts. */
export function matchesJsonSchemaV1(schema, value) {
  return matches(schema, value, schema);
}

function matches(rule, value, root) {
  if (rule.$ref !== undefined) return matches(resolveRef(root, rule.$ref), value, root);
  if (rule.oneOf !== undefined) {
    return rule.oneOf.filter((candidate) => matches(candidate, value, root)).length === 1;
  }
  if (rule.const !== undefined && !Object.is(value, rule.const)) return false;
  if (rule.enum !== undefined && !rule.enum.some((entry) => Object.is(entry, value))) return false;
  if (rule.type !== undefined && !matchesType(rule.type, value)) return false;

  if (typeof value === 'string') {
    if (rule.minLength !== undefined && value.length < rule.minLength) return false;
    if (rule.maxLength !== undefined && value.length > rule.maxLength) return false;
    if (rule.pattern !== undefined && !(new RegExp(rule.pattern, 'u')).test(value)) return false;
    if (rule.format === 'uri') {
      try { new URL(value); } catch { return false; }
    }
    if (rule.format === 'date-time') {
      const time = Date.parse(value);
      if (!Number.isFinite(time)) return false;
    }
  }
  if (typeof value === 'number') {
    if (rule.minimum !== undefined && value < rule.minimum) return false;
    if (rule.maximum !== undefined && value > rule.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) return false;
    if (rule.maxItems !== undefined && value.length > rule.maxItems) return false;
    if (rule.uniqueItems === true) {
      const keys = value.map((entry) => JSON.stringify(entry));
      if (new Set(keys).size !== keys.length) return false;
    }
    if (rule.items !== undefined && !value.every((entry) => matches(rule.items, entry, root))) {
      return false;
    }
  }
  if (isRecord(value)) {
    if (rule.required?.some((key) => !Object.hasOwn(value, key))) return false;
    if (rule.propertyNames !== undefined) {
      if (!Object.keys(value).every((key) => matches(rule.propertyNames, key, root))) return false;
    }
    const properties = rule.properties ?? {};
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!matches(properties[key], entry, root)) return false;
      } else if (rule.additionalProperties === false) return false;
      else if (isRecord(rule.additionalProperties)) {
        if (!matches(rule.additionalProperties, entry, root)) return false;
      }
    }
  }
  return true;
}

function matchesType(type, value) {
  if (type === 'null') return value === null;
  if (type === 'object') return isRecord(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  return typeof value === type;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveRef(root, reference) {
  if (!reference.startsWith('#/')) throw new Error('external-json-schema-ref-not-supported');
  return reference.slice(2).split('/').reduce((current, token) => (
    current[token.replaceAll('~1', '/').replaceAll('~0', '~')]
  ), root);
}
