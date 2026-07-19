/** Internal closed-object helpers shared by dormant RFC-64 wire codecs. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Require one plain record to contain exactly enumerable string data fields. */
export function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(record);
  if (actual.some((key) => typeof key !== 'string')) {
    throw new Error(`${label} must not contain symbol properties`);
  }
  const strings = actual as string[];
  const sortedExpected = [...expected].sort();
  if (
    strings.length !== sortedExpected.length
    || [...strings].sort().some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  for (const key of strings) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable data properties`);
    }
  }
}
