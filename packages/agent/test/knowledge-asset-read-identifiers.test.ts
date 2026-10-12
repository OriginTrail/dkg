// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { classifyKaIdentifier } from '../src/knowledge-asset-read-resolution.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const packed = (BigInt(AUTHOR) << 96n) | 7n;

describe('KA read alias compatibility and literal mutation names', () => {
  it.each([
    `${AUTHOR}:7`,
    `did:dkg:31337/${AUTHOR}/7`,
    `did:dkg:31337/${OTHER}/${packed}`,
    `did:dkg:31337/${packed}`,
  ])('resolves %s to the original packed identity', name => {
    expect(classifyKaIdentifier(name)).toEqual({ kind: 'kaId', kaId: packed });
  });
  it('packs the maximum rootless per-author number without losing its author', () => {
    const number = (1n << 96n) - 1n;
    expect(classifyKaIdentifier(`did:dkg:31337/${AUTHOR}/${number}`))
      .toEqual({ kind: 'kaId', kaId: (BigInt(AUTHOR) << 96n) | number });
  });
  it('preserves the canonical legacy numeric id without a rootless author', () => {
    expect(classifyKaIdentifier('did:dkg:31337/7')).toEqual({ kind: 'kaId', kaId: 7n });
  });
  it.each(['ordinary-document', `${AUTHOR}:-7`, `${AUTHOR}:seven`, 'did:dkg:31337/document', '0xinvalid:7'])
    ('preserves %s as a literal document name', name => {
      expect(classifyKaIdentifier(name)).toEqual({ kind: 'name' });
    });
  it('keeps compact-looking names mutable while retaining canonical UAL classification', () => {
    expect(classifyKaIdentifier(`${AUTHOR}:7`, { includeCompact: false })).toEqual({ kind: 'name' });
    expect(classifyKaIdentifier(`did:dkg:31337/${AUTHOR}/7`, { includeCompact: false }))
      .toEqual({ kind: 'kaId', kaId: packed });
  });
});
