import { describe, expect, it } from 'vitest';
import {
  IMPORTED_ARTIFACT_MAX_PAGE_BYTES,
  isDkgContentHash,
  keccak256ContentHash,
  parseDkgContentHash,
  sha256ContentHash,
  verifyDkgContentHash,
} from '../src/index.js';

describe('imported artifact byte protocol helpers', () => {
  it('centralizes the artifact page-size cap', () => {
    expect(IMPORTED_ARTIFACT_MAX_PAGE_BYTES).toBe(1024 * 1024);
  });

  it('parses prefixed and legacy bare content hashes', () => {
    const hex = 'a'.repeat(64);

    expect(parseDkgContentHash(`sha256:${hex}`)).toEqual({ algo: 'sha256', hex });
    expect(parseDkgContentHash(`keccak256:${hex}`)).toEqual({ algo: 'keccak256', hex });
    expect(parseDkgContentHash(hex)).toEqual({ algo: 'sha256', hex });
    expect(isDkgContentHash('not-a-hash')).toBe(false);
  });

  it('computes and verifies sha256 and keccak256 content hashes', () => {
    const bytes = new TextEncoder().encode('abc');
    const sha = sha256ContentHash(bytes);
    const keccak = keccak256ContentHash(bytes);

    expect(sha).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(keccak).toBe('keccak256:4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    expect(verifyDkgContentHash(sha, bytes)).toBe(true);
    expect(verifyDkgContentHash(keccak, bytes)).toBe(true);
    expect(verifyDkgContentHash(sha.slice('sha256:'.length), bytes)).toBe(true);
    expect(verifyDkgContentHash(sha, new TextEncoder().encode('abcd'))).toBe(false);
  });
});
