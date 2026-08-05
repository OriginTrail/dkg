/**
 * Snapshot enumerable data properties without invoking caller-controlled
 * accessors. The returned null-prototype copy is frozen before validation or
 * persistence code can observe it.
 *
 * @internal
 */
export function snapshotPlainDataRecordV1(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== 'object'
    || value === null
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new Error(`${label} must not contain symbol fields`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

/** @internal */
export function snapshotExactPlainDataRecordV1(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  const snapshot = snapshotPlainDataRecordV1(value, label);
  assertExactFieldSetV1(snapshot, expectedKeys, label);
  return snapshot;
}

/** @internal */
export function assertExactFieldSetV1(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => !expectedKeys.includes(key))
  ) {
    throw new Error(`${label} has an invalid field set`);
  }
}
