/** Shared fail-closed primitives for every M1 JSON trust boundary. */

export type PlainDataRecord = Record<string, unknown>;

/**
 * Declare every string field of a model exactly once. Type-checking fails when
 * the model gains a field until the closed boundary descriptor is updated.
 */
export function defineRecordKeys<T>() {
  return <const Keys extends readonly Extract<keyof T, string>[]>(
    ...keys: Exclude<Extract<keyof T, string>, Keys[number]> extends never ? Keys : never
  ): Keys => keys;
}

const IDENTIFIER = /^[A-Za-z0-9._:/@-]+$/u;

/** Accept an ordinary object whose own fields are enumerable data properties. */
export function plainRecord(value: unknown): PlainDataRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return undefined;
  if ((ownKeys as string[]).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor?.enumerable || !('value' in descriptor);
  })) return undefined;
  return value as PlainDataRecord;
}

/** Accept a closed ordinary object with required and explicitly optional keys. */
export function closedRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): PlainDataRecord | undefined {
  const row = plainRecord(value);
  if (!row) return undefined;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(row);
  if (actual.some((key) => !allowed.has(key))
    || requiredKeys.some((key) => !Object.hasOwn(row, key))) return undefined;
  return row;
}

/** Accept a dense ordinary array with no custom or accessor properties. */
export function closedArray(
  value: unknown,
  minimum: number,
  maximum: number,
): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum) return false;
  const expected = new Set<PropertyKey>(['length']);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expected.size || ownKeys.some((key) => !expected.has(key))) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

export function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
  pattern?: RegExp,
): string | undefined {
  return typeof value === 'string'
    && value.length >= minimum
    && value.length <= maximum
    && (pattern === undefined || pattern.test(value))
    ? value
    : undefined;
}

export function identifier(value: unknown): string | undefined {
  return boundedString(value, 1, 256, IDENTIFIER);
}

export function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Translate an undefined-returning decoder into a labeled throwing boundary. */
export function requireDecoded<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new TypeError(`Invalid ${label}`);
  return value;
}
