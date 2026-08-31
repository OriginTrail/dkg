/** Canonical reflection primitives for closed untrusted adapter data. */

export type ClosedDataReject = (message: string) => never;

export function isOrdinaryDataRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

/** Read one own enumerable data property without invoking an accessor. */
export function readOwnEnumerableDataProperty(
  input: unknown,
  key: string,
  label: string,
  reject: ClosedDataReject,
): unknown {
  if (input === null || typeof input !== 'object') {
    reject(`${label} must be an object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    reject(`${label}.${key} must use enumerable data properties`);
  }
  return descriptor.value;
}

/** Snapshot one dense, unadorned ordinary Array without re-reading its slots. */
export function snapshotDenseDataArray(
  input: unknown,
  label: string,
  reject: ClosedDataReject,
): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    reject(`${label} must be an ordinary array`);
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== input.length + 1
    || !keys.includes('length')
  ) {
    reject(`${label} must be dense and unadorned`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    snapshot.push(readOwnEnumerableDataProperty(input, String(index), label, reject));
  }
  return snapshot;
}

/** Snapshot an exact plain data record through the same closed-data boundary. */
export function snapshotExactOrdinaryDataRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
  reject: ClosedDataReject,
): Readonly<Record<string, unknown>> {
  if (!isOrdinaryDataRecord(input)) reject(`${label} must be a plain data object`);
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== expectedKeys.length
    || expectedKeys.some((key) => !keys.includes(key))
  ) {
    reject(`${label} has invalid fields`);
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of expectedKeys) {
    snapshot[key] = readOwnEnumerableDataProperty(input, key, label, reject);
  }
  return Object.freeze(snapshot);
}
