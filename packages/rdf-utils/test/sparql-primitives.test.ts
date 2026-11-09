import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  readSparqlLogicalCodePoint, isSparqlPnCharsBaseCodePoint,
  isSparqlPnCharsUCodePoint, isSparqlPnCharsCodePoint,
  sparqlPnCharsBaseWidth, sparqlPnCharsUWidth, sparqlPnCharsWidth,
  sparqlAsciiDigitWidth, sparqlVariableInitialWidth, sparqlVariableContinuationWidth,
  readSparqlVariable, readSparqlVariableEnd, scanSparqlStringLiteral,
  skipSparqlStringLiteral, scanSparqlIriRef, skipSparqlSpaceAndLineComments,
} from '../src/sparql-lexical-primitives.js';

describe('SPARQL Unicode preprocessing', () => {
  it.each([
    ['A', 0, { codePoint: 65, rawWidth: 1 }],
    ['x😀', 1, { codePoint: 0x1f600, rawWidth: 2 }],
    [String.raw`\u0041`, 0, { codePoint: 65, rawWidth: 6 }],
    [String.raw`\U0001F600`, 0, { codePoint: 0x1f600, rawWidth: 10 }],
    [String.raw`\n`, 0, { codePoint: 92, rawWidth: 1 }],
    ['', 0, null], ['x', -1, null], ['x', 1, null],
    ['\ud800', 0, null], ['\udfff', 0, null],
    [String.raw`\u123`, 0, null], [String.raw`\u12g4`, 0, null],
    [String.raw`\U00110000`, 0, null], [String.raw`\uD800`, 0, null],
    [String.raw`\uDFFF`, 0, null],
  ])('reads a logical character without losing the source width (%j at %i)', (source, index, expected) => {
    expect(readSparqlLogicalCodePoint(source, index)).toEqual(expected);
  });

  it('decodes generated Unicode scalar values in raw and escaped forms', () => {
    const scalar = fc.oneof(fc.integer({ min: 0, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0x10ffff }));
    fc.assert(fc.property(scalar, codePoint => {
      const raw = String.fromCodePoint(codePoint);
      expect(readSparqlLogicalCodePoint(`!${raw}`, 1)).toEqual({ codePoint, rawWidth: raw.length });
      const escaped = `\\U${codePoint.toString(16).padStart(8, '0')}`;
      expect(readSparqlLogicalCodePoint(escaped, 0)).toEqual({ codePoint, rawWidth: 10 });
      if (codePoint <= 0xffff) {
        expect(readSparqlLogicalCodePoint(`\\u${codePoint.toString(16).padStart(4, '0')}`, 0))
          .toEqual({ codePoint, rawWidth: 6 });
      }
    }), { seed: 241026, numRuns: 300 });
  });
});

describe('SPARQL name grammar', () => {
  it('classifies the complete ASCII domain using the SPARQL grammar productions', () => {
    // Independent regular-expression oracle for W3C SPARQL 1.1 productions
    // VARNAME, PN_CHARS_BASE, PN_CHARS_U, and PN_CHARS.
    // https://www.w3.org/TR/sparql11-query/#rVARNAME
    for (let code = 0; code < 128; code++) {
      const char = String.fromCharCode(code);
      expect(isSparqlPnCharsBaseCodePoint(code), `base ${code}`).toBe(/[A-Za-z]/.test(char));
      expect(isSparqlPnCharsUCodePoint(code), `U ${code}`).toBe(/[A-Za-z_]/.test(char));
      expect(isSparqlPnCharsCodePoint(code), `name ${code}`).toBe(/[A-Za-z_0-9-]/.test(char));
      const escaped = `\\u${code.toString(16).padStart(4, '0')}`;
      for (const [source, width] of [[char, 1], [escaped, 6]] as const) {
        expect(sparqlPnCharsBaseWidth(source, 0)).toBe(/[A-Za-z]/.test(char) ? width : 0);
        expect(sparqlPnCharsUWidth(source, 0)).toBe(/[A-Za-z_]/.test(char) ? width : 0);
        expect(sparqlPnCharsWidth(source, 0)).toBe(/[A-Za-z_0-9-]/.test(char) ? width : 0);
        expect(sparqlAsciiDigitWidth(source, 0)).toBe(/[0-9]/.test(char) ? width : 0);
        expect(sparqlVariableInitialWidth(source, 0)).toBe(/[A-Za-z_0-9]/.test(char) ? width : 0);
        expect(sparqlVariableContinuationWidth(source, 0)).toBe(/[A-Za-z_0-9]/.test(char) ? width : 0);
      }
    }
  });

  it.each([
    [0x00b7, false, true], [0x0300, false, true], [0x036f, false, true],
    [0x203f, false, true], [0x2040, false, true], [0x00c0, true, true],
    [0x00d6, true, true], [0x00d7, false, false], [0x00d8, true, true],
    [0x00f6, true, true], [0x00f7, false, false], [0x00f8, true, true],
    [0x02ff, true, true], [0x0370, true, true], [0x037d, true, true],
    [0x037e, false, false], [0x037f, true, true], [0x1fff, true, true],
    [0x2000, false, false], [0x200c, true, true], [0x200d, true, true],
    [0x200e, false, false], [0x2070, true, true], [0x218f, true, true],
    [0x2190, false, false], [0x2c00, true, true], [0x2fef, true, true],
    [0x2ff0, false, false], [0x3001, true, true], [0xd7ff, true, true],
    [0xd800, false, false], [0xf900, true, true], [0xfdcf, true, true],
    [0xfdd0, false, false], [0xfdf0, true, true], [0xfffd, true, true],
    [0xfffe, false, false], [0x10000, true, true], [0xeffff, true, true],
    [0xf0000, false, false],
  ])('respects name-character boundaries at U+%s', (code, base, continuation) => {
    const char = String.fromCodePoint(code);
    expect(isSparqlPnCharsBaseCodePoint(code)).toBe(base);
    expect(isSparqlPnCharsUCodePoint(code)).toBe(base);
    expect(isSparqlPnCharsCodePoint(code)).toBe(continuation);
    expect(sparqlVariableInitialWidth(char, 0)).toBe(base ? char.length : 0);
    expect(sparqlVariableContinuationWidth(char, 0)).toBe(continuation ? char.length : 0);
  });

  it.each([
    ['?name.rest', '?name'], ['$9abc-', '$9abc'], ['?_a·́‿!', '?_a·́‿'],
    [String.raw`\u003F\u0061\U0001F600!`, String.raw`\u003F\u0061\U0001F600`],
    ['?', null], ['$-', null], ['name', null], [String.raw`?\uZZZZ`, null],
  ])('reads the raw variable spelling and stops at the first non-name character (%s)', (source, expected) => {
    expect(readSparqlVariable(` ${source}`, 1)).toBe(expected);
    expect(readSparqlVariableEnd(` ${source}`, 1)).toBe(expected === null ? null : expected.length + 1);
  });
});

describe('literal and IRI token boundaries', () => {
  it.each([
    ['"hello" tail', 7, true, false], ["'hi'!", 4, true, false],
    ['"""a"b""c""" tail', 12, true, false],
    [String.raw`"a\"b" tail`, 6, true, false],
    [String.raw`"\u0022" tail`, 8, true, false],
    [String.raw`"\uZZZZ" tail`, 8, true, true],
    ['"unterminated', 13, false, false],
    ['"\ud800"', 3, true, true],
    ['"\\😀"', 5, true, false],
    [String.raw`\u0022a\u005C\u0022b\u0022!`, 26, true, false],
    [String.raw`\u0022\u0022\u0022x\u0022\u0022\u0022`, 37, true, false],
    [String.raw`\u0022\uZZZZ\u0022`, 18, true, true],
    [String.raw`\u0022x\u005C`, 13, false, false],
  ])('scans string boundaries without treating escaped payload as syntax (%s)', (source, end, closed, malformedUchar) => {
    expect(scanSparqlStringLiteral(source, 0)).toEqual({ end, closed, malformedUchar });
    expect(skipSparqlStringLiteral(source, 0)).toBe(end);
  });

  it.each(['word', '', String.raw`\uZZZZ`])('leaves a non-string start unchanged (%s)', source => {
    expect(scanSparqlStringLiteral(source, 0)).toBeNull();
    expect(skipSparqlStringLiteral(source, 0)).toBe(0);
  });

  it.each([
    ['<urn:é😀> tail', 'urn:é😀', 9], ['<>!', '', 2],
    [String.raw`<urn:\u0061\U0001F600>!`, 'urn:a😀', 22],
    [String.raw`\u003Curn:a\u003E!`, 'urn:a', 17],
    [String.raw`\u003Curn:\u0061\u003E!`, 'urn:a', 22],
  ])('returns decoded IRIs and raw end offsets (%s)', (source, logicalValue, end) => {
    expect(scanSparqlIriRef(source, 0)).toEqual({ logicalValue, end });
  });

  it.each([
    '', 'word', '<unterminated', '<urn: a>', '<urn:|>', '<urn:\ud800>',
    String.raw`<urn:\n>`, String.raw`<urn:\uZZZZ>`,
    String.raw`\u003Cunterminated`, String.raw`\u003Curn:\u0020\u003E`,
    String.raw`\u003Curn:\uZZZZ\u003E`,
  ])('rejects incomplete or malformed IRI references (%s)', source => {
    expect(scanSparqlIriRef(source, 0)).toBeNull();
  });
});

describe('space and comment scanning', () => {
  it.each([
    ['', 0], ['SELECT', 0], [' \t\r\nSELECT', 4], ['# no newline', 12],
    [' # first\r\n# second\nSELECT', 19],
    [String.raw`\u0020\u0023comment\u000ASELECT`, 25],
    [String.raw`#bad\uZZZZ` + '\nSELECT', 11],
    [String.raw` \uZZZZ`, 1],
  ])('returns the first live token offset (%s)', (source, expected) => {
    expect(skipSparqlSpaceAndLineComments(source, 0)).toBe(expected);
  });
});
