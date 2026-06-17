import { createHash } from 'node:crypto';
import { keccak256Hex } from './crypto/keccak.js';

export const IMPORTED_ARTIFACT_MAX_PAGE_BYTES = 1024 * 1024;

export type DkgContentHashAlgorithm = 'sha256' | 'keccak256';

export interface DkgContentHash {
  algo: DkgContentHashAlgorithm;
  hex: string;
}

/**
 * Parse `sha256:<hex>`, `keccak256:<hex>`, or bare `<hex>` content hashes.
 * Bare hashes are treated as sha256 for historical file-store compatibility.
 */
export function parseDkgContentHash(hash: string): DkgContentHash | null {
  if (typeof hash !== 'string') return null;
  let algo: DkgContentHashAlgorithm = 'sha256';
  let hex = hash;
  if (hash.startsWith('sha256:')) {
    hex = hash.slice('sha256:'.length);
  } else if (hash.startsWith('keccak256:')) {
    algo = 'keccak256';
    hex = hash.slice('keccak256:'.length);
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return { algo, hex: hex.toLowerCase() };
}

export function isDkgContentHash(hash: string): boolean {
  return parseDkgContentHash(hash) !== null;
}

export function formatDkgContentHash(algo: DkgContentHashAlgorithm, hex: string): string {
  return `${algo}:${hex.toLowerCase()}`;
}

export function sha256ContentHash(bytes: Uint8Array): string {
  return formatDkgContentHash('sha256', createHash('sha256').update(bytes).digest('hex'));
}

export function keccak256ContentHash(bytes: Uint8Array): string {
  return formatDkgContentHash('keccak256', keccak256Hex(bytes).replace(/^0x/, ''));
}

export function verifyDkgContentHash(hash: string, bytes: Uint8Array): boolean {
  const parsed = parseDkgContentHash(hash);
  if (!parsed) return false;
  const actual = parsed.algo === 'keccak256'
    ? keccak256ContentHash(bytes)
    : sha256ContentHash(bytes);
  return actual === formatDkgContentHash(parsed.algo, parsed.hex);
}
