import { describe, expect, it } from 'vitest';
import {
  readSparqlVariable as readCoreVariable,
  skipSparqlIriRefForStructuralScan as skipCoreIriRef,
  skipSparqlStringLiteral as skipCoreStringLiteral,
} from '@origintrail-official/dkg-core/sparql-cursors';
import {
  readSparqlVariable,
  skipSparqlIriRef,
  skipSparqlStringLiteral,
} from '../src/sparql-utils.js';

describe('shared SPARQL lexical cursor primitives', () => {
  it.each([
    ['xx"abc"tail', 2, 7],
    ["xx'''a { # }'''tail", 2, 15],
    [String.raw`xx"a\"b"tail`, 2, 8],
    [String.raw`xx\u0022abc\u0022tail`, 2, 17],
    ['xx"unterminated', 2, 15],
  ] as const)(
    'keeps string boundaries and raw offsets identical for %s',
    (source, start, expected) => {
      expect(skipCoreStringLiteral(source, start)).toBe(expected);
      expect(skipSparqlStringLiteral(source, start)).toBe(expected);
    },
  );

  it.each([
    ['xx<urn:test>tail', 2, 12],
    [String.raw`xx\u003Curn:test\u003Etail`, 2, 22],
    [String.raw`xx<urn:\u00E9>tail`, 2, 14],
    ['xx<>tail', 2, null],
    ['xx< 5', 2, null],
  ] as const)(
    'keeps IRIREF boundaries and raw offsets identical for %s',
    (source, start, expected) => {
      expect(skipCoreIriRef(source, start)).toBe(expected);
      expect(skipSparqlIriRef(source, start)).toBe(expected);
    },
  );

  it.each([
    ['xx?δοκιμή tail', 2, '?δοκιμή'],
    [String.raw`xx\u003F\u03B1\u00B7x tail`, 2, String.raw`\u003F\u03B1\u00B7x`],
    [String.raw`xx?\u0031count tail`, 2, String.raw`?\u0031count`],
    [String.raw`xx?\u0020bad tail`, 2, null],
    [String.raw`xx?\uD800bad tail`, 2, null],
  ] as const)(
    'keeps Unicode variable grammar and raw ranges identical for %s',
    (source, start, expected) => {
      expect(readCoreVariable(source, start)).toBe(expected);
      expect(readSparqlVariable(source, start)).toBe(expected);
    },
  );
});
