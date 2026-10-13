// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';
import { describe, expect, it } from 'vitest';

import {
  STORE_ESCAPE_ALLOWANCE_BYTES_PER_CHARACTER_V1,
  STORE_LEXICAL_FORM_ALLOWANCE_BYTES_PER_TRIPLE_V1,
  projectionReadBackByteLimitV1,
  readBackHoldsProjectionV1,
} from '../src/rfc64/projection-store-read-back-v1.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SUBJECT = 'https://example.org/asset';
const typed = (value: string, datatype: string) => `"${value}"^^<${XSD}${datatype}>`;
const quad = (predicate: string, object: string, graph = ''): Quad => ({
  subject: SUBJECT,
  predicate: `https://example.org/${predicate}`,
  object,
  graph,
});

describe('reading a projection back from the store', () => {
  describe('the byte limit', () => {
    const line = (object: string) => `<${SUBJECT}> <https://example.org/value> ${object} .\n`;

    it('is the projection bytes and the allowance for every triple', () => {
      const text = line('"plain"') + line('"text"');
      expect(projectionReadBackByteLimitV1(text, 2))
        .toBe(text.length + 2 * STORE_LEXICAL_FORM_ALLOWANCE_BYTES_PER_TRIPLE_V1);
    });

    it('is zero for an empty projection', () => {
      expect(projectionReadBackByteLimitV1('', 0)).toBe(0);
    });

    it('does not count the line feed that ends a line', () => {
      const text = line('"a"') + line('"b"') + line('"c"');
      expect(projectionReadBackByteLimitV1(text, 0)).toBe(text.length);
    });

    it('adds the escape allowance for every control character in a literal', () => {
      const text = line('"a\tb\tc\u0001d\u007Fe"');
      expect(projectionReadBackByteLimitV1(text, 1)).toBe(
        text.length
          + 4 * STORE_ESCAPE_ALLOWANCE_BYTES_PER_CHARACTER_V1
          + STORE_LEXICAL_FORM_ALLOWANCE_BYTES_PER_TRIPLE_V1,
      );
    });

    it('counts the bytes of a character outside ASCII, and one allowance for each of its code units', () => {
      // "é" is two bytes and one code unit; the emoji is four bytes and two.
      const text = line('"\u00e9\u{1F680}"');
      expect(projectionReadBackByteLimitV1(text, 0)).toBe(
        Buffer.byteLength(text, 'utf8') + 3 * STORE_ESCAPE_ALLOWANCE_BYTES_PER_CHARACTER_V1,
      );
      expect(Buffer.byteLength(text, 'utf8')).toBe(text.length + 3);
    });

    it('covers every escape a store adapter returns for one character', () => {
      // `\uXXXX` in place of a single byte is the longest.
      expect('\\u0001'.length - 1).toBe(STORE_ESCAPE_ALLOWANCE_BYTES_PER_CHARACTER_V1);
      expect('\\t'.length - 1).toBeLessThanOrEqual(STORE_ESCAPE_ALLOWANCE_BYTES_PER_CHARACTER_V1);
    });

    it('covers the longer lexical forms a store returns for one triple', () => {
      const longest = typed('2026-10-12T13:08:51.000Z', 'dateTime').length
        - typed('2026-10-12T13:08:51', 'dateTime').length;
      expect(longest).toBe(5);
      expect(STORE_LEXICAL_FORM_ALLOWANCE_BYTES_PER_TRIPLE_V1).toBeGreaterThan(longest);
    });
  });

  describe('the comparison', () => {
    it('accepts the same triples', () => {
      const projection = [quad('name', '"Alice"'), quad('age', typed('42', 'integer'))];
      expect(readBackHoldsProjectionV1(projection, [...projection])).toBe(true);
    });

    it('accepts the same triples in another order', () => {
      const projection = [quad('name', '"Alice"'), quad('age', typed('42', 'integer'))];
      expect(readBackHoldsProjectionV1(projection, [...projection].reverse())).toBe(true);
    });

    it('does not compare graph names', () => {
      const projection = [quad('name', '"Alice"')];
      expect(readBackHoldsProjectionV1(projection, [quad('name', '"Alice"', 'urn:graph')])).toBe(true);
    });

    // The left form is the canonical one a projection carries; the right form
    // is what Blazegraph returned for it (measured against a live store).
    it.each([
      ['a whole-second xsd:dateTime', typed('2026-10-12T13:08:51Z', 'dateTime'), typed('2026-10-12T13:08:51.000Z', 'dateTime')],
      ['an integral xsd:double', typed('100', 'double'), typed('100.0', 'double')],
      ['an integral xsd:float', typed('5', 'float'), typed('5.0', 'float')],
      ['an xsd:duration with zero components', typed('PT1H', 'duration'), typed('PT1H0M0S', 'duration')],
      ['an xsd:integer kept as xsd:int', typed('42', 'integer'), typed('42', 'int')],
      ['a plain literal returned as xsd:string', '"Alice"', typed('Alice', 'string')],
    ])('accepts %s in the lexical form of the store', (_name, canonical, stored) => {
      const projection = [quad('name', '"Alice"'), quad('value', canonical)];
      const readBack = [quad('value', stored), quad('name', '"Alice"')];
      expect(readBackHoldsProjectionV1(projection, readBack)).toBe(true);
    });

    // The left form is the canonical one, with the character itself; the right
    // form is what the store adapters return for it, on every store.
    it.each([
      ['a tab', '"a\tb\tc"', '"a\\tb\\tc"'],
      ['a backspace and a form feed', '"a\bb\fc"', '"a\\bb\\fc"'],
      ['a control character', '"a\u0001b"', '"a\\u0001b"'],
      ['the delete character', '"a\u007Fb"', '"a\\u007Fb"'],
    ])('accepts %s that the store returns escaped', (_name, canonical, stored) => {
      const projection = [quad('name', '"Alice"'), quad('text', canonical)];
      const readBack = [quad('name', '"Alice"'), quad('text', stored)];
      expect(readBackHoldsProjectionV1(projection, readBack)).toBe(true);
    });

    it('refuses another character returned escaped', () => {
      const projection = [quad('text', '"a\tb"')];
      expect(readBackHoldsProjectionV1(projection, [quad('text', '"a\\nb"')])).toBe(false);
      expect(readBackHoldsProjectionV1(projection, [quad('text', '"a b"')])).toBe(false);
    });

    it.each([
      ['another instant', typed('2026-10-12T13:08:51Z', 'dateTime'), typed('2026-10-12T13:08:52.000Z', 'dateTime')],
      ['another number', typed('100', 'double'), typed('100.5', 'double')],
      ['another datatype', typed('100', 'double'), typed('100', 'integer')],
      ['another string', '"Alice"', '"Alixe"'],
      ['another language', '"Alice"@en', '"Alice"@de'],
      ['an IRI instead of a literal', '"https://example.org/x"', 'https://example.org/x'],
    ])('refuses %s', (_name, canonical, stored) => {
      const projection = [quad('name', '"Alice"'), quad('value', canonical)];
      const readBack = [quad('name', '"Alice"'), quad('value', stored)];
      expect(readBackHoldsProjectionV1(projection, readBack)).toBe(false);
    });

    it('refuses another subject or predicate', () => {
      const projection = [quad('value', typed('100', 'double'))];
      expect(readBackHoldsProjectionV1(projection, [quad('other', typed('100.0', 'double'))])).toBe(false);
      expect(readBackHoldsProjectionV1(projection, [{
        ...quad('value', typed('100.0', 'double')),
        subject: 'https://example.org/other',
      }])).toBe(false);
    });

    it('refuses a missing or an extra triple', () => {
      const projection = [quad('name', '"Alice"'), quad('value', typed('100', 'double'))];
      expect(readBackHoldsProjectionV1(projection, [quad('name', '"Alice"')])).toBe(false);
      expect(readBackHoldsProjectionV1(projection, [
        ...projection,
        quad('extra', '"x"'),
      ])).toBe(false);
    });

    it('refuses one triple returned twice in place of two', () => {
      const projection = [quad('name', '"Alice"'), quad('value', typed('100', 'double'))];
      const readBack = [quad('name', '"Alice"'), quad('name', '"Alice"')];
      expect(readBackHoldsProjectionV1(projection, readBack)).toBe(false);
    });

    it('compares a term the canonical form does not know character for character', () => {
      const custom = (value: string) => `"${value}"^^<https://example.org/datatype>`;
      const projection = [quad('value', custom('1.0'))];
      expect(readBackHoldsProjectionV1(projection, [quad('value', custom('1.0'))])).toBe(true);
      expect(readBackHoldsProjectionV1(projection, [quad('value', custom('1.00'))])).toBe(false);
    });
  });
});
