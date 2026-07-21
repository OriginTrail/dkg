import { controlError } from './errors.js';

export const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export function u64Blob(value: bigint, name: string): Buffer {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) {
    controlError('WAL_CONTROL_INVALID_CONFIGURATION', `${name} must be a protocol u64`);
  }
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(value);
  return output;
}

export function blobU64(value: Uint8Array, name: string): bigint {
  if (!(value instanceof Uint8Array) || value.length !== 8) {
    controlError('WAL_CONTROL_CORRUPT', `${name} must be an 8-byte protocol u64`);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).readBigUInt64BE();
}

export function fixedBytes(value: Uint8Array, length: number, name: string): Buffer {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    controlError('WAL_CONTROL_INVALID_CONFIGURATION', `${name} must be exactly ${length} bytes`);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export function safeInteger(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    controlError('WAL_CONTROL_INVALID_CONFIGURATION', `${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}
