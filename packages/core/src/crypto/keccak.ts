import { keccak_256 } from '@noble/hashes/sha3.js';

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function keccak256Hex(data: Uint8Array): string {
  return '0x' + Array.from(keccak256(data)).map(b => b.toString(16).padStart(2, '0')).join('');
}
