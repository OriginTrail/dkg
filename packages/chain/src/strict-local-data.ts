import { type EvmAddressV1 } from '@origintrail-official/dkg-core';

const CANONICAL_NONZERO_EVM_ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;

export interface DenseDataArraySnapshotOptions {
  readonly label: string;
  readonly minLength?: number;
  readonly maxLength?: number;
}

/** Snapshot an exact, plain, enumerable data-only record without invoking accessors. */
export function snapshotExactDataRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('not a record');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('not plain');
  const expectedKeySet = new Set(expectedKeys);
  if (expectedKeySet.size !== expectedKeys.length) {
    throw new Error('expected keys must be unique');
  }
  const actualKeys = Reflect.ownKeys(input);
  if (
    actualKeys.some((key) => typeof key !== 'string')
    || actualKeys.length !== expectedKeys.length
    || (actualKeys as string[]).some((key) => !expectedKeySet.has(key))
  ) {
    throw new Error('unknown or missing fields');
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error('fields must be enumerable data properties');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/** Snapshot a dense ordinary array without iteration or inherited property reads. */
export function snapshotDenseDataArray(
  input: unknown,
  options: DenseDataArraySnapshotOptions,
): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${options.label} must be an ordinary array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  if (
    lengthDescriptor === undefined
    || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < (options.minLength ?? 0)
    || (
      options.maxLength !== undefined
      && lengthDescriptor.value > options.maxLength
    )
  ) {
    throw new Error(`${options.label} length is outside the accepted range`);
  }

  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.length !== length + 1
    || ownKeys.some((key) => (
      typeof key !== 'string'
      || (key !== 'length' && !isCanonicalArrayIndex(key, length))
    ))
  ) {
    throw new Error(`${options.label} must be dense and data-only`);
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error(`${options.label} entries must be enumerable data properties`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

export function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false;
  try {
    const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
    if (abortedGetter === undefined) return false;
    abortedGetter.call(value);
    return true;
  } catch {
    return false;
  }
}

export function assertCanonicalNonzeroEvmAddress(
  value: unknown,
  label: string,
): asserts value is EvmAddressV1 {
  if (typeof value !== 'string' || !CANONICAL_NONZERO_EVM_ADDRESS.test(value)) {
    throw new Error(`${label} must be a canonical lowercase nonzero EVM address`);
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}
