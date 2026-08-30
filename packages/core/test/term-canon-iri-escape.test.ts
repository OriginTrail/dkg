import { describe, expect, it } from 'vitest';

import { canonicalizeObjectTermForHash } from '../src/crypto/term-canon.js';

describe('V10 datatype-IRI escape compatibility', () => {
  it('preserves a malformed prefix while decoding an overlapping valid escape', () => {
    expect(canonicalizeObjectTermForHash(String.raw`"x"^^<urn:\u12\u0041>`))
      .toBe(String.raw`"x"^^<urn:\u12A>`);
  });
});
