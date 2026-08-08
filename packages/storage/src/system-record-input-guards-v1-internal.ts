import { types as utilTypes } from 'node:util';

export function snapshotSystemRecordDataRecordV1(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  if (utilTypes.isProxy(value)) {
    throw new Error(`${label} must not be a Proxy (plain data object required)`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains a non-string field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

export function snapshotSystemRecordExactDataRecordV1<
  const Keys extends readonly string[],
>(
  value: unknown,
  keys: Keys,
  label: string,
): Readonly<Record<Keys[number], unknown>> {
  const record = snapshotSystemRecordDataRecordV1(value, label);
  const ownKeys = Reflect.ownKeys(record);
  const expected = new Set<string>(keys);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return record as Readonly<Record<Keys[number], unknown>>;
}

export function snapshotSystemRecordDenseArrayV1(
  value: unknown,
  options: Readonly<{
    label: string;
    minLength?: number;
    maxLength: number;
  }>,
): readonly unknown[] {
  const { label, minLength = 0, maxLength } = options;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (utilTypes.isProxy(value)) throw new Error(`${label} must not be a Proxy`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !lengthDescriptor ||
    !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
    lengthDescriptor.enumerable === true ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < minLength ||
    lengthDescriptor.value > maxLength
  ) {
    throw new Error(`${label} length is outside its bound`);
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) throw new Error(`${label} must be a dense closed array`);
  const result = new Array<unknown>(length);
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) {
      throw new Error(`${label} must contain only array indexes`);
    }
    const index = Number(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !Number.isSafeInteger(index) ||
      index >= length ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error(`${label} must contain only enumerable data elements`);
    }
    result[index] = descriptor.value;
  }
  return Object.freeze(result);
}

export function assertSystemRecordUnicodeScalarStringV1(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0 ||
      (code >= 0xd800 &&
        code <= 0xdbff &&
        (index + 1 >= value.length ||
          value.charCodeAt(index + 1) < 0xdc00 ||
          value.charCodeAt(index + 1) > 0xdfff)) ||
      (code >= 0xdc00 &&
        code <= 0xdfff &&
        (index === 0 ||
          value.charCodeAt(index - 1) < 0xd800 ||
          value.charCodeAt(index - 1) > 0xdbff))
    ) {
      throw new Error(`${label} contains a non-scalar Unicode value`);
    }
    if (code >= 0xd800 && code <= 0xdbff) index += 1;
  }
}

export function assertSystemRecordOpaqueIdentityV1(value: unknown, label: string): object {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== null ||
    !Object.isFrozen(value) ||
    Reflect.ownKeys(value).length !== 0
  ) {
    throw new Error(`${label} must be a frozen propertyless null-prototype capability`);
  }
  return value;
}
