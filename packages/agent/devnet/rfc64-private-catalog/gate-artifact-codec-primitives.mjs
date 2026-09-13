// SPDX-License-Identifier: Apache-2.0

const MAX_PRIVATE_CATALOG_EVIDENCE_ROWS_V1 = 1_024;

export function canonicalIsoInstantV1(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`RFC-64 private gate PASS ${field} must be an ISO instant`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`RFC-64 private gate PASS ${field} must be a canonical ISO instant`);
  }
  return timestamp;
}

export function isDigestV1(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/u.test(value);
}

export function isAddressV1(value) {
  return typeof value === 'string'
    && /^0x[0-9a-f]{40}$/u.test(value)
    && value !== `0x${'00'.repeat(20)}`;
}

export function parseCanonicalDecimalV1(value, allowZero, bits = 64) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed >= (1n << BigInt(bits))) return null;
  return parsed;
}

export function boundedArrayV1(value, label) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_PRIVATE_CATALOG_EVIDENCE_ROWS_V1
  ) {
    throw new TypeError(`${label} is outside the bounded row count`);
  }
  return value;
}

export function plainRecordV1(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key !== 'string'
      || descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value');
  })) throw new TypeError(`${label} must contain only enumerable data fields`);
  return value;
}

export function assertExactKeysV1(value, expected, label) {
  const actual = Reflect.ownKeys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length
    || actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

export function stableJsonV1(value) {
  return JSON.stringify(sortKeysV1(value), null, 2);
}

function sortKeysV1(value) {
  if (Array.isArray(value)) return value.map(sortKeysV1);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortKeysV1(value[key])]),
    );
  }
  return value;
}
