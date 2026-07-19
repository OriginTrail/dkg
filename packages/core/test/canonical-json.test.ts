import { describe, expect, it } from 'vitest';

import {
  CanonicalJsonError,
  MAX_CANONICAL_JSON_BYTES,
  MAX_CANONICAL_JSON_DEPTH,
  canonicalizeJson,
  parseCanonicalJson,
  parseJsonStrict,
  type CanonicalJsonValue,
} from '../src/canonical-json.js';

describe('RFC 8785 canonical JSON', () => {
  it('matches the RFC 8785 section 3.2.2 canonicalization sample', () => {
    const value = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
      string: '\u20ac$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };

    expect(canonicalizeJson(value)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts property names by UTF-16 code units rather than Unicode code points', () => {
    expect(canonicalizeJson({ '\ue000': 'bmp', '\u{10000}': 'supplementary' })).toBe(
      '{"𐀀":"supplementary","":"bmp"}',
    );
  });

  it('matches the RFC 8785 Appendix B IEEE-754 number boundary vectors', () => {
    const vectors: Array<[string, string]> = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'],
    ];

    for (const [bits, expected] of vectors) {
      expect(canonicalizeJson(float64FromBits(bits)), bits).toBe(expected);
    }
    expect(() => canonicalizeJson(float64FromBits('7fffffffffffffff'))).toThrow(
      /finite IEEE-754/,
    );
    expect(() => canonicalizeJson(float64FromBits('7ff0000000000000'))).toThrow(
      /finite IEEE-754/,
    );
  });

  it('parses canonical bytes and rejects merely valid, non-canonical JSON', () => {
    expect(parseCanonicalJson('{"a":0,"b":[true,null]}')).toEqual({
      a: 0,
      b: [true, null],
    });

    for (const input of [
      ' {"a":0,"b":[true,null]}',
      '{"b":[true,null],"a":0}',
      '{"a":-0,"b":[true,null]}',
      '{"a":0.0,"b":[true,null]}',
      '{"a":0,"b":[true,null]}\n',
    ]) {
      expect(() => parseCanonicalJson(input)).toThrow(/not RFC 8785 canonical/);
    }
  });

  it('rejects duplicate decoded keys, including differently escaped spellings', () => {
    expect(() => parseJsonStrict('{"a":1,"a":2}')).toThrow(/Duplicate object key/);
    expect(() => parseJsonStrict(String.raw`{"a":1,"\u0061":2}`)).toThrow(
      /Duplicate object key/,
    );
  });

  it('rejects invalid UTF-8, a BOM, invalid grammar, and unpaired surrogates', () => {
    expect(() => parseJsonStrict(new Uint8Array([0xc3, 0x28]))).toThrow(/not valid UTF-8/);
    expect(() => parseJsonStrict(new Uint8Array([0xef, 0xbb, 0xbf, 0x6e, 0x75, 0x6c, 0x6c])))
      .toThrow(/BOM/);

    for (const input of ['01', '1.', '[1,]', '{"a":1,}', 'true false']) {
      expect(() => parseJsonStrict(input)).toThrow(CanonicalJsonError);
    }

    expect(() => parseJsonStrict(String.raw`"\ud800"`)).toThrow(/unpaired high surrogate/);
    expect(() => parseJsonStrict(String.raw`"\udc00"`)).toThrow(/unpaired low surrogate/);
  });

  it('enforces byte and nesting ceilings even for empty nested containers', () => {
    expect(() => parseJsonStrict('{"a":1}', { maxBytes: 6 })).toThrow(/exceeds 6 bytes/);
    expect(parseJsonStrict('{"a":1}', { maxDepth: 1 })).toEqual({ a: 1 });
    expect(() => parseJsonStrict('{"a":{}}', { maxDepth: 1 })).toThrow(
      /nesting exceeds 1/,
    );
    expect(() => parseJsonStrict('[[]]', { maxDepth: 1 })).toThrow(/nesting exceeds 1/);
    expect(() => canonicalizeJson({ a: {} }, { maxDepth: 1 })).toThrow(
      /nesting exceeds 1/,
    );
    expect(() => canonicalizeJson([[]], { maxDepth: 1 })).toThrow(/nesting exceeds 1/);
    expect(canonicalizeJson({ a: 1 }, { maxDepth: 1 })).toBe('{"a":1}');
    expect(canonicalizeJson([1], { maxDepth: 1 })).toBe('[1]');
    expect(() => canonicalizeJson({}, { maxDepth: 0 })).toThrow(/nesting exceeds 0/);
    expect(() => parseJsonStrict('{}', { maxDepth: 0 })).toThrow(/nesting exceeds 0/);
  });

  it('rejects decimal tokens that silently change when converted to IEEE-754', () => {
    expect(() => parseJsonStrict('9007199254740993')).toThrow(/loses information/);
    expect(() => parseJsonStrict('1e-324')).toThrow(/loses information/);
    expect(() => parseJsonStrict('0.10000000000000001')).toThrow(/loses information/);

    expect(parseJsonStrict('9007199254740992')).toBe(9_007_199_254_740_992);
    expect(parseJsonStrict('5e-324')).toBe(5e-324);
    expect(parseJsonStrict('1.0')).toBe(1);
    expect(parseJsonStrict('1e0')).toBe(1);
    expect(parseJsonStrict('100000000000000000000000')).toBe(1e23);
  });

  it('enforces exact UTF-8 byte and protocol depth boundaries in both directions', () => {
    expect(canonicalizeJson('é', { maxBytes: 4 })).toBe('"é"');
    expect(parseCanonicalJson('"é"', { maxBytes: 4 })).toBe('é');
    expect(() => canonicalizeJson('é', { maxBytes: 3 })).toThrow(/exceeds 3 bytes/);
    expect(() => parseCanonicalJson('"é"', { maxBytes: 3 })).toThrow(
      /exceeds 3 bytes/,
    );

    const atLimit = nestedArrayJson(MAX_CANONICAL_JSON_DEPTH);
    expect(parseCanonicalJson(atLimit, { maxDepth: MAX_CANONICAL_JSON_DEPTH })).toBeTruthy();
    expect(canonicalizeJson(parseJsonStrict(atLimit))).toBe(atLimit);
    const overLimit = nestedArrayJson(MAX_CANONICAL_JSON_DEPTH + 1);
    expect(() => parseCanonicalJson(overLimit)).toThrow(/nesting exceeds 64/);

    expect(() => parseJsonStrict('null', {
      maxBytes: MAX_CANONICAL_JSON_BYTES + 1,
    })).toThrow(/no greater than/);
    expect(() => parseJsonStrict('null', {
      maxDepth: MAX_CANONICAL_JSON_DEPTH + 1,
    })).toThrow(/no greater than/);
  });

  it('aborts bounded serialization while traversing an oversized JavaScript value', () => {
    expect(() => canonicalizeJson({ payload: 'x'.repeat(128) }, { maxBytes: 32 })).toThrow(
      /Canonical JSON exceeds 32 bytes/,
    );
  });

  it('rejects JavaScript values that are not lossless plain JSON data', () => {
    expect(() => canonicalizeJson(Number.NaN as unknown as CanonicalJsonValue)).toThrow(
      /finite IEEE-754/,
    );
    expect(() => canonicalizeJson([1, , 3] as unknown as CanonicalJsonValue)).toThrow(
      /Sparse arrays/,
    );
    expect(() => canonicalizeJson(new Date() as unknown as CanonicalJsonValue)).toThrow(
      /plain JSON objects/,
    );

    const cyclic: Record<string, CanonicalJsonValue> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(/Cyclic values/);

    const symbolObject = { a: 1 } as Record<PropertyKey, unknown>;
    symbolObject[Symbol('hidden')] = 2;
    expect(() => canonicalizeJson(symbolObject as CanonicalJsonValue)).toThrow(
      /symbol properties/,
    );

    const accessorObject = {};
    Object.defineProperty(accessorObject, 'a', { enumerable: true, get: () => 1 });
    expect(() => canonicalizeJson(accessorObject as CanonicalJsonValue)).toThrow(
      /accessor properties/,
    );

    const decoratedArray = [1] as unknown[] & { extra?: number };
    decoratedArray.extra = 2;
    expect(() => canonicalizeJson(decoratedArray as CanonicalJsonValue)).toThrow(
      /non-index properties/,
    );
  });
});

function float64FromBits(hex: string): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

function nestedArrayJson(depth: number): string {
  let value = '0';
  for (let index = 0; index < depth; index += 1) value = `[${value}]`;
  return value;
}
