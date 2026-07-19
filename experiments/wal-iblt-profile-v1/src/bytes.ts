export const WAL_OBJECT_ID_LENGTH = 32;
export const RECONCILIATION_NONCE_LENGTH = 32;

export class InvalidBytesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBytesError';
  }
}

export function assertLength(value: Uint8Array, length: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new InvalidBytesError(`${label} must be exactly ${length} bytes`);
  }
}

export function copyBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

export function concatBytes(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, value) => sum + value.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

export function xorInto(target: Uint8Array, value: Uint8Array): void {
  if (target.length !== value.length) {
    throw new InvalidBytesError('XOR operands must have equal length');
  }
  for (let index = 0; index < target.length; index += 1) {
    target[index] ^= value[index];
  }
}

export function isZero(value: Uint8Array): boolean {
  for (const byte of value) {
    if (byte !== 0) return false;
  }
  return true;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

export function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

export function hexToBytes(value: string, expectedLength?: number): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new InvalidBytesError('hex value must contain complete hexadecimal bytes');
  }
  const output = new Uint8Array(Buffer.from(value, 'hex'));
  if (expectedLength !== undefined) assertLength(output, expectedLength, 'hex value');
  return output;
}

export function u64be(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new InvalidBytesError('u64 value is out of range');
  }
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, value, false);
  return output;
}

export function readU64le(value: Uint8Array): bigint {
  assertLength(value, 8, 'u64');
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(0, true);
}
