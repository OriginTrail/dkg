import { describe, expect, it } from 'vitest';

import { canonicalizeObjectTermForHash } from '../src/crypto/term-canon.js';

describe('V10 datatype-IRI escape compatibility', () => {
  function decodeWithLegacyConsensusRegex(value: string): string {
    return value.replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (match, bmp, wide) => {
      const codePoint = Number.parseInt(bmp ?? wide, 16);
      return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : match;
    });
  }

  const cases = [
    ['valid BMP escape', String.raw`urn:\u0041`],
    ['valid astral escape', String.raw`urn:\U0001F600`],
    ['isolated high surrogate', String.raw`urn:\uD83D`],
    ['isolated low surrogate', String.raw`urn:\uDE00`],
    ['out-of-range wide escape', String.raw`urn:\U00110000`],
    ['malformed short prefix with overlapping valid escape', String.raw`urn:\u12\u0041`],
    ['malformed wide prefix with overlapping valid escape', String.raw`urn:\U0001\u0041`],
    ['adjacent escapes', String.raw`urn:\u0041\U0001F600\u0042`],
    ['escaped backslash before valid escape', String.raw`urn:\\u0041`],
  ] as const;

  it.each(cases)('preserves legacy consensus decoding for %s', (_label, datatype) => {
    expect(canonicalizeObjectTermForHash(`"x"^^<${datatype}>`))
      .toBe(`"x"^^<${decodeWithLegacyConsensusRegex(datatype)}>`);
  });
});
