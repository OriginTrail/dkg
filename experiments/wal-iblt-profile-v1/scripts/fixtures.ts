import { hashBytes } from '../src/hash.js';

const encoder = new TextEncoder();

export function deterministicId(label: string): Uint8Array {
  return hashBytes(encoder.encode(`wal-iblt-lab-id-v1\0${label}`));
}

export function deterministicSet(prefix: string, count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, index) => deterministicId(`${prefix}:${index}`));
}
