import { blake3 } from '@noble/hashes/blake3.js';

const textEncoder = new TextEncoder();

export function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function concat(...values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

export function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

export function fromHex(value: string, expectedLength?: number): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new Error('hex must be lowercase complete bytes');
  const output = new Uint8Array(Buffer.from(value, 'hex'));
  if (expectedLength !== undefined && output.length !== expectedLength) {
    throw new Error(`expected ${expectedLength} bytes, got ${output.length}`);
  }
  return output;
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function xorInto(target: Uint8Array, value: Uint8Array): void {
  if (target.length !== value.length) throw new Error('XOR length mismatch');
  for (let index = 0; index < target.length; index += 1) target[index] ^= value[index];
}

export function u16be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error('u16 out of range');
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value, false);
  return output;
}

export function u64be(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error('u64 out of range');
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, value, false);
  return output;
}

export function u64le(value: Uint8Array): bigint {
  if (value.length !== 8) throw new Error('u64 requires eight bytes');
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(0, true);
}

export function hash(domain: string, ...values: readonly Uint8Array[]): Uint8Array {
  return blake3(concat(utf8(domain), ...values));
}

export function assertBytes(value: unknown, length?: number): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error('expected byte string');
  if (length !== undefined && value.length !== length) throw new Error(`expected bytes${length}`);
}

export function sortedUniqueBytes(values: readonly Uint8Array[]): Uint8Array[] {
  const sorted = values.map((value) => new Uint8Array(value)).sort(compareBytes);
  for (let index = 1; index < sorted.length; index += 1) {
    if (equalBytes(sorted[index - 1], sorted[index])) throw new Error('duplicate byte value');
  }
  return sorted;
}
