export type ClosedDataPrototypePolicy = 'ordinary-only' | 'ordinary-or-null';
export type ClosedDataReject = (message: string) => never;

export interface ClosedDataSnapshotOptions {
  readonly prototypePolicy?: ClosedDataPrototypePolicy;
  readonly reject?: ClosedDataReject;
}

/** Canonical prototype check for closed untrusted data records. */
export function isClosedDataRecord(
  value: unknown,
  prototypePolicy: ClosedDataPrototypePolicy = 'ordinary-or-null',
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype
    || (prototypePolicy === 'ordinary-or-null' && prototype === null);
}

/** Internal closed-object helper retained for RFC-64 wire codecs. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isClosedDataRecord(value, 'ordinary-or-null');
}

/** Read one own enumerable data property without invoking an accessor. */
export function readOwnEnumerableDataProperty(
  value: unknown,
  key: string,
  label: string,
  reject: ClosedDataReject = defaultReject,
): unknown {
  if (value === null || typeof value !== 'object') {
    reject(`${label} must be an object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    reject(
      `${label}.${key} must be an enumerable data property; fields must use enumerable data properties`,
    );
  }
  return descriptor.value;
}

/** Snapshot one dense, unadorned ordinary Array without re-reading its slots. */
export function snapshotDenseDataArray(
  value: unknown,
  label: string,
  reject: ClosedDataReject = defaultReject,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    reject(`${label} must be an ordinary array`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== value.length + 1
    || !keys.includes('length')
  ) {
    reject(`${label} must be dense and unadorned`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    snapshot.push(readOwnEnumerableDataProperty(value, String(index), label, reject));
  }
  return snapshot;
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
  options: ClosedDataSnapshotOptions = {},
): Readonly<Record<Keys[number], unknown>> {
  const reject = options.reject ?? defaultReject;
  if (!isClosedDataRecord(value, options.prototypePolicy)) {
    reject(`${label} must be a plain data object`);
  }
  const record = value as Record<string, unknown>;

  const actual = Reflect.ownKeys(record);
  if (actual.some((key) => typeof key !== 'string')) {
    reject(`${label} must not contain symbol properties`);
  }
  const strings = actual as string[];
  const sortedExpected = [...expected].sort();
  if (
    strings.length !== sortedExpected.length
    || [...strings].sort().some((key, index) => key !== sortedExpected[index])
  ) {
    reject(`${label} has unknown or missing fields`);
  }

  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of expected) {
    snapshot[key] = readOwnEnumerableDataProperty(record, key, label, reject);
  }
  return Object.freeze(snapshot) as Readonly<Record<Keys[number], unknown>>;
}

/** Require one plain record to contain exactly enumerable string data fields. */
export function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  snapshotExactDataRecord(record, expected, label);
}

function defaultReject(message: string): never {
  throw new Error(message);
}
