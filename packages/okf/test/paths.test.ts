import { describe, it, expect } from 'vitest';
import {
  resolveLinkTarget,
  isValidSegment,
  isReservedFile,
  isConceptFile,
  pathToConceptId,
  conceptIdToIri,
  conceptIdToKaName,
} from '../src/index.js';

describe('isValidSegment (agrees with paths.py _SEGMENT_RE)', () => {
  it('accepts alphanumeric / underscore starts with dot/hyphen inside', () => {
    expect(isValidSegment('crypto_bitcoin')).toBe(true);
    expect(isValidSegment('blocks')).toBe(true);
    expect(isValidSegment('a.b-c_d')).toBe(true);
    expect(isValidSegment('_hidden')).toBe(true);
  });
  it('rejects leading dot/hyphen/slash and empties', () => {
    expect(isValidSegment('.hidden')).toBe(false);
    expect(isValidSegment('-dash')).toBe(false);
    expect(isValidSegment('')).toBe(false);
    expect(isValidSegment('a/b')).toBe(false);
  });
});

describe('reserved / concept classification', () => {
  it('flags index.md and log.md at any depth as reserved', () => {
    expect(isReservedFile('index.md')).toBe(true);
    expect(isReservedFile('tables/index.md')).toBe(true);
    expect(isReservedFile('a/b/log.md')).toBe(true);
    expect(isReservedFile('tables/blocks.md')).toBe(false);
  });
  it('treats non-reserved .md as concepts', () => {
    expect(isConceptFile('tables/blocks.md')).toBe(true);
    expect(isConceptFile('index.md')).toBe(false);
    expect(isConceptFile('viz.html')).toBe(false);
  });
});

describe('pathToConceptId / conceptIdToIri', () => {
  it('strips .md and joins POSIX segments', () => {
    expect(pathToConceptId('tables/blocks.md')).toBe('tables/blocks');
    expect(pathToConceptId('datasets/crypto_bitcoin.md')).toBe('datasets/crypto_bitcoin');
  });
  it('derives a deterministic IRI from the concept ID', () => {
    expect(conceptIdToIri('tables/blocks')).toBe('urn:okf:tables/blocks');
    expect(conceptIdToIri('tables/blocks', 'https://x/')).toBe('https://x/tables/blocks');
  });
});

describe('conceptIdToKaName (node asset names cannot contain "/")', () => {
  it('encodes path separators and underscores deterministically (hex escapes)', () => {
    expect(conceptIdToKaName('tables/transactions')).toBe('tables_2ftransactions');
    expect(conceptIdToKaName('datasets/crypto_bitcoin')).toBe('datasets_2fcrypto_5fbitcoin');
    expect(conceptIdToKaName('flat')).toBe('flat');
    expect(conceptIdToKaName('a/b/c')).toBe('a_2fb_2fc');
  });
  it('never produces a name containing a slash', () => {
    for (const id of ['tables/blocks', 'a/b/c', 'datasets/crypto_bitcoin', 'x']) {
      expect(conceptIdToKaName(id)).not.toContain('/');
    }
  });
  it('is INJECTIVE: "a/b" and the literal concept "a__b" do NOT collide', () => {
    // The naive `/`→`__` mapping collapsed these onto one node KA name.
    expect(conceptIdToKaName('a/b')).not.toBe(conceptIdToKaName('a__b'));
    // Spot-check a few more would-be collisions.
    const ids = ['a/b', 'a__b', 'a_b', 'a/b/c', 'a__b__c', 'tables/x', 'tables__x'];
    expect(new Set(ids.map(conceptIdToKaName)).size).toBe(ids.length);
  });
});

describe('resolveLinkTarget — all OKF §5 link forms', () => {
  // from concept `tables/transactions` (dir = tables/)
  it('bare-sibling', () => {
    expect(resolveLinkTarget('blocks.md', 'tables/transactions')).toBe('tables/blocks');
  });
  it('parent-relative', () => {
    expect(resolveLinkTarget('../datasets/crypto_bitcoin.md', 'tables/transactions')).toBe(
      'datasets/crypto_bitcoin',
    );
  });
  it('absolute bundle-relative', () => {
    expect(resolveLinkTarget('/tables/blocks.md', 'tables/transactions')).toBe('tables/blocks');
  });
  it('explicit ./relative', () => {
    expect(resolveLinkTarget('./inputs.md', 'tables/transactions')).toBe('tables/inputs');
  });
  it('extension-less', () => {
    expect(resolveLinkTarget('blocks', 'tables/transactions')).toBe('tables/blocks');
    expect(resolveLinkTarget('../datasets/crypto_bitcoin', 'tables/transactions')).toBe(
      'datasets/crypto_bitcoin',
    );
  });
  it('strips #anchor and ?query', () => {
    expect(resolveLinkTarget('blocks.md#schema', 'tables/transactions')).toBe('tables/blocks');
    expect(resolveLinkTarget('blocks.md?x=1', 'tables/transactions')).toBe('tables/blocks');
  });
  it('returns null for external URLs, pure anchors, and root escapes', () => {
    expect(resolveLinkTarget('https://example.org/x', 'tables/transactions')).toBeNull();
    expect(resolveLinkTarget('mailto:a@b.c', 'tables/transactions')).toBeNull();
    expect(resolveLinkTarget('#section', 'tables/transactions')).toBeNull();
    expect(resolveLinkTarget('../../escapes.md', 'tables/transactions')).toBeNull();
    expect(resolveLinkTarget('dir/', 'tables/transactions')).toBeNull();
  });
});
