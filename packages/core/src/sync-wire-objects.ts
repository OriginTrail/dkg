/** Internal closed-object helpers shared by dormant RFC-64 wire codecs. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export interface SnapshotDataRecordOptions {
  /** Closed protocol objects represent absent optionals by omission, never JSON null. */
  readonly rejectNullValues?: boolean;
}

export interface SnapshotDataArrayOptions {
  readonly minLength?: number;
  readonly maxLength: number;
}

/**
 * Snapshot one bounded, dense array without invoking accessors or caller-owned methods.
 *
 * Protocol arrays are closed containers: only their native length and enumerable own
 * data elements are accepted. The returned copy always uses the local Array prototype,
 * so later iteration cannot be redirected by a caller-owned prototype or method.
 */
export function snapshotDataArray(
  value: unknown,
  label: string,
  options: SnapshotDataArrayOptions,
): readonly unknown[] {
  const minLength = options.minLength ?? 0;
  const maxLength = options.maxLength;
  if (!Number.isSafeInteger(minLength) || minLength < 0
    || !Number.isSafeInteger(maxLength) || maxLength < minLength) {
    throw new Error(`${label} has invalid snapshot bounds`);
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || lengthDescriptor.enumerable === true
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < minLength
    || lengthDescriptor.value > maxLength) {
    throw new Error(`${label} length is outside its bound`);
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) throw new Error(`${label} must be a dense closed array`);

  const snapshot = new Array<unknown>(length);
  let elements = 0;
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string') throw new Error(`${label} must not contain symbol properties`);
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
      throw new Error(`${label} must not contain non-index properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must contain only enumerable data elements`);
    }
    snapshot[index] = descriptor.value;
    elements += 1;
  }
  if (elements !== length) throw new Error(`${label} must be dense`);
  return Object.freeze(snapshot);
}

/**
 * Snapshot every enumerable string data property without invoking accessors.
 *
 * Codecs use this once to discover which optional fields are present, then pass
 * the resulting snapshot through {@link snapshotExactDataRecord}. Keeping that
 * two-step boundary here prevents each codec from drifting on prototype,
 * symbol, accessor, enumerability, and null handling.
 */
export function snapshotDataRecord(
  value: unknown,
  label: string,
  options: SnapshotDataRecordOptions = {},
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a plain data object`);
  }

  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error(`${label} must not contain symbol properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable data properties`);
    }
    if (options.rejectNullValues === true && descriptor.value === null) {
      throw new Error(`${label} must omit optional fields, not use null`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

/** Accessor-safe presence test for an enumerable own data property. */
export function hasOwnDataProperty(value: unknown, key: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

/** Snapshot one closed plain record without invoking accessors or re-reading fields. */
export function snapshotExactDataRecord<const Keys extends readonly string[]>(
  value: unknown,
  expected: Keys,
  label: string,
): Readonly<Record<Keys[number], unknown>> {
  const snapshot = snapshotDataRecord(value, label);
  const strings = Object.keys(snapshot);
  const sortedExpected = [...expected].sort();
  if (
    strings.length !== sortedExpected.length
    || [...strings].sort().some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }

  return snapshot as Readonly<Record<Keys[number], unknown>>;
}

/** Require one plain record to contain exactly enumerable string data fields. */
export function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  snapshotExactDataRecord(record, expected, label);
}
