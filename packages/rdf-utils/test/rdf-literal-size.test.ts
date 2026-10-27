import { describe, expect, it } from 'vitest';
import { DKG_RDF_LITERAL_SAFE_MUTF8_BYTES, javaModifiedUtf8ByteLength } from '../src/index.js';

describe('javaModifiedUtf8ByteLength', () => {
  it.each([
    ['', 0],
    ['\u0000', 2],
    ['a', 1],
    ['\u007f', 1],
    ['\u0080', 2],
    ['é', 2],
    ['߿', 2],
    ['ࠀ', 3],
    ['漢', 3],
    ['￿', 3],
    ['\ud800', 3],
    ['😀', 6],
    ['"a\u0000é😀"', 13],
  ])('counts %j as %i bytes', (value, bytes) => {
    expect(javaModifiedUtf8ByteLength(value)).toBe(bytes);
  });

  it('pins the limit a node allows one serialized literal term', () => {
    expect(DKG_RDF_LITERAL_SAFE_MUTF8_BYTES).toBe(60_000);
  });
});
