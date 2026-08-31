/** Internal closed-object helpers shared by dormant RFC-64 wire codecs. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Snapshot selected enumerable data fields without invoking property accessors. */
export function snapshotSelectedDataRecord<const Keys extends readonly string[]>(
  value: unknown,
  selected: Keys,
  label: string,
): Readonly<Record<Keys[number], unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a data object`);
  }

  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of selected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} ${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot) as Readonly<Record<Keys[number], unknown>>;
}

/** Snapshot one closed plain record without invoking accessors or re-reading fields. */
export function snapshotExactDataRecord<const Keys extends readonly string[]>(
  value: unknown,
  expected: Keys,
  label: string,
): Readonly<Record<Keys[number], unknown>> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a plain data object`);
  }

  const actual = Reflect.ownKeys(value);
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

  return snapshotSelectedDataRecord(value, expected, label);
}

/** Require one plain record to contain exactly enumerable string data fields. */
export function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  snapshotExactDataRecord(record, expected, label);
}
