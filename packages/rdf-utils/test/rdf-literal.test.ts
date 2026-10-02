import { describe, expect, it } from 'vitest';
import {
  escapeRdfLiteral,
  decodeRdfLiteralBody,
  decodeNTriplesIriEscapesPreservingLegacy,
  decodeNTriplesIriEscapesStrict,
  decodeNTriplesUcharEscapes,
  formatCanonicalRdfLiteralTerm,
  isRdfTerm,
  normalizeRdfObject,
  parseRdfLiteralLexicalTerm,
  parseRdfLiteralTerm,
  type RdfLiteralTerm,
} from '../src/index.js';

describe('escapeRdfLiteral', () => {
  it('escapes quotes, backslashes, ECHAR controls, remaining C0 controls, and DEL', () => {
    expect(escapeRdfLiteral('q"\\b\bt\tn\nf\fr\rnul\u0000vt\u000Bus\u001Fdel\u007F')).toBe(
      'q\\"\\\\b\\bt\\tn\\nf\\fr\\rnul\\u0000vt\\u000Bus\\u001Fdel\\u007F',
    );
  });

  it('owns the complete dependency-free RDF object normalization boundary', () => {
    expect(isRdfTerm('urn:test:entity')).toBe(true);
    expect(isRdfTerm('_:blank')).toBe(true);
    expect(isRdfTerm('plain')).toBe(false);
    expect(normalizeRdfObject('urn:test:entity')).toBe('urn:test:entity');
    expect(normalizeRdfObject('a "quote"\u0000')).toBe('"a \\"quote\\"\\u0000"');
    expect(normalizeRdfObject(null)).toBe('""');
  });
});

describe('N-Triples UCHAR decoding', () => {
  it('decodes BMP, scalar, and paired UTF-16 escape forms', () => {
    expect(decodeNTriplesUcharEscapes(String.raw`caf\u00E9/\U0001F600/\uD83D\uDE00`, {
      surrogatePolicy: 'combine',
    })).toBe('café/😀/😀');
  });

  it('rejects malformed, unpaired, and out-of-range escapes by default', () => {
    expect(decodeNTriplesUcharEscapes(String.raw`\q`)).toBeNull();
    expect(decodeNTriplesUcharEscapes(String.raw`\uD800`, {
      surrogatePolicy: 'combine',
    })).toBeNull();
    expect(decodeNTriplesUcharEscapes(String.raw`\uDC00`, {
      surrogatePolicy: 'combine',
    })).toBeNull();
    expect(decodeNTriplesUcharEscapes(String.raw`\U00110000`)).toBeNull();
  });

  it('supports the consensus compatibility policy explicitly', () => {
    expect(decodeNTriplesUcharEscapes(String.raw`\q/\uD800`, {
      invalidEscape: 'preserve',
      surrogatePolicy: 'allow',
    })).toBe(`\\q/\uD800`);
  });

  it('preserves malformed prefixes without hiding a later valid legacy escape', () => {
    expect(decodeNTriplesIriEscapesPreservingLegacy(String.raw`\u12\u0041`))
      .toBe(String.raw`\u12A`);
    expect(decodeNTriplesIriEscapesPreservingLegacy(String.raw`\\u0041`))
      .toBe(String.raw`\A`);
  });

  it('combines only two short surrogate escapes in strict IRI mode', () => {
    expect(decodeNTriplesIriEscapesStrict(String.raw`\uD83D\uDE00`)).toBe('😀');
    expect(decodeNTriplesIriEscapesStrict(String.raw`\U0000D83D\uDE00`)).toBeNull();
  });

  it('rejects recognized ECHAR in strict IRIs and preserves it for legacy datatype IRIs', () => {
    expect(decodeNTriplesIriEscapesStrict(String.raw`urn:x\n`)).toBeNull();
    expect(decodeNTriplesIriEscapesPreservingLegacy(String.raw`urn:x\n`))
      .toBe(String.raw`urn:x\n`);
  });
});

describe('RDF literal term codec', () => {
  const value = 'café 😀 "quote" \\ tab:\t control:\u0001 del:\u007F slash-n:\\n';
  const body = 'café 😀 \\"quote\\" \\\\ tab:\\t control:\\u0001 del:\\u007F slash-n:\\\\n';

  it('owns plain, language-tagged, and typed binding formatting', () => {
    expect(formatCanonicalRdfLiteralTerm({ kind: 'plain', value })).toBe(`"${body}"`);
    expect(formatCanonicalRdfLiteralTerm({ kind: 'language', value, language: 'en' })).toBe(`"${body}"@en`);
    expect(formatCanonicalRdfLiteralTerm({ kind: 'typed', value, datatype: 'urn:test:datatype' }))
      .toBe(`"${body}"^^<urn:test:datatype>`);
    expect(formatCanonicalRdfLiteralTerm({
      kind: 'typed',
      value,
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    })).toBe(`"${body}"`);
  });

  it.each<RdfLiteralTerm>([
    { kind: 'plain', value },
    { kind: 'language', value, language: 'sr-Latn' },
    { kind: 'typed', value, datatype: 'urn:test:datatype' },
  ])('round-trips $kind literals through the canonical formatter and parser', (literal) => {
    const formatted = formatCanonicalRdfLiteralTerm(literal);
    expect(parseRdfLiteralTerm(formatted)).toEqual(literal);
    expect(formatCanonicalRdfLiteralTerm(parseRdfLiteralTerm(formatted)!)).toBe(formatted);
  });

  it('round-trips the complete escaped C0 and DEL control range', () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('')
      + '\u007F';
    const literal: RdfLiteralTerm = { kind: 'plain', value: controls };
    expect(parseRdfLiteralTerm(formatCanonicalRdfLiteralTerm(literal))).toEqual(literal);
  });

  it('keeps XSD string elision in the typed formatting path', () => {
    const typed: RdfLiteralTerm = {
      kind: 'typed',
      value,
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    };
    const formatted = formatCanonicalRdfLiteralTerm(typed);
    expect(formatted).toBe(`"${body}"`);
    expect(parseRdfLiteralTerm(formatted)).toEqual({ kind: 'plain', value });
  });

  it('unescapes standard short and Unicode escapes in a single parity-safe pass', () => {
    expect(parseRdfLiteralTerm(
      '"quote:\\" slash:\\\\ controls:\\b\\t\\n\\f\\r BMP:\\u00E9 astral:\\U0001F600"',
    )).toEqual({ kind: 'plain', value: 'quote:" slash:\\ controls:\b\t\n\f\r BMP:é astral:😀' });
    expect(parseRdfLiteralTerm('"literal-backslash-n:\\\\n"'))
      .toEqual({ kind: 'plain', value: 'literal-backslash-n:\\n' });
  });

  it('preserves supported raw tabs in suffixed literal terms', () => {
    expect(parseRdfLiteralTerm('"a\tb"@en'))
      .toEqual({ kind: 'language', value: 'a\tb', language: 'en' });
    expect(parseRdfLiteralTerm('"a\tb"^^<urn:test:datatype>'))
      .toEqual({ kind: 'typed', value: 'a\tb', datatype: 'urn:test:datatype' });
  });

  it('rejects non-literal and malformed literal terms', () => {
    expect(parseRdfLiteralTerm('urn:test:not-a-literal')).toBeNull();
    expect(parseRdfLiteralTerm('"unterminated')).toBeNull();
    expect(parseRdfLiteralTerm('"x"@en^^<urn:test>')).toBeNull();
    expect(parseRdfLiteralTerm('"unknown:\\q"')).toBeNull();
    expect(parseRdfLiteralTerm('"bad-unicode:\\u00ZZ"')).toBeNull();
    expect(parseRdfLiteralTerm('"out-of-range:\\U00110000"')).toBeNull();
    expect(parseRdfLiteralTerm('"surrogate-short:\\uD800"')).toBeNull();
    expect(parseRdfLiteralTerm('"surrogate-long:\\U0000DFFF"')).toBeNull();
    expect(parseRdfLiteralTerm('"raw\nnewline"')).toBeNull();
  });

  it('shares the broad lexical boundary without weakening strict term parsing', () => {
    expect(parseRdfLiteralLexicalTerm('"v"^^urn:test:bare')).toEqual({
      body: 'v',
      suffix: { kind: 'datatype', datatype: 'urn:test:bare', syntax: 'bare' },
    });
    expect(parseRdfLiteralTerm('"v"^^urn:test:bare')).toBeNull();
    expect(parseRdfLiteralLexicalTerm('"unknown:\\q"')).toEqual({
      body: 'unknown:\\q',
      suffix: { kind: 'plain' },
    });
    expect(parseRdfLiteralTerm('"unknown:\\q"')).toBeNull();
  });

  it('makes strict and compatibility escape-decoding contracts explicit', () => {
    expect(decodeRdfLiteralBody('valid:\\t\\u00E9')).toBe('valid:\té');
    expect(decodeRdfLiteralBody('unknown:\\q')).toBeNull();
    expect(decodeRdfLiteralBody('unknown:\\q', { invalidEscape: 'preserve' }))
      .toBe('unknown:\\q');
    expect(decodeRdfLiteralBody('surrogate:\\uD800')).toBeNull();
    expect(decodeRdfLiteralBody('surrogate:\\uD800', {
      invalidEscape: 'preserve',
      allowSurrogateCodePoints: true,
    })).toBe('surrogate:\uD800');
  });
});

describe('parseRdfLiteralLexicalTerm keeps the boundary of the pattern it replaced', () => {
  // The pattern the scanner replaced. Hash canonicalization keeps a term the
  // lexical parser rejects verbatim and re-serializes one it accepts, so the
  // scanner has to accept the same terms and split them the same way.
  const REPLACED_PATTERN =
    /^"((?:[^"\\]|\\.)*)"(?:@([A-Za-z0-9-]+)|\^\^(?:<([^>]+)>|([^<].*)))?$/;
  const LF = '\n';
  const CR = '\r';
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const LINE_TERMINATORS: Array<[string, string]> = [['LF', LF], ['CR', CR], ['U+2028', LS], ['U+2029', PS]];

  function splitWithReplacedPattern(term: string): string {
    const match = REPLACED_PATTERN.exec(term);
    if (!match) return 'null';
    if (match[2] !== undefined) return JSON.stringify([match[1], 'language', match[2]]);
    if (match[3] !== undefined) return JSON.stringify([match[1], 'bracketed', match[3]]);
    if (match[4] !== undefined) return JSON.stringify([match[1], 'bare', match[4]]);
    return JSON.stringify([match[1], 'plain']);
  }

  function splitWithScanner(term: string): string {
    const parsed = parseRdfLiteralLexicalTerm(term);
    if (!parsed) return 'null';
    const { body, suffix } = parsed;
    if (suffix.kind === 'language') return JSON.stringify([body, 'language', suffix.language]);
    if (suffix.kind === 'datatype') return JSON.stringify([body, suffix.syntax, suffix.datatype]);
    return JSON.stringify([body, 'plain']);
  }

  it.each(LINE_TERMINATORS)('rejects a backslash followed by %s', (_name, terminator) => {
    expect(parseRdfLiteralLexicalTerm(`"a\\${terminator}b"`)).toBeNull();
    expect(parseRdfLiteralLexicalTerm(`"a\\${terminator}b"@en`)).toBeNull();
    expect(parseRdfLiteralLexicalTerm(`"a\\${terminator}b"^^<urn:test:datatype>`)).toBeNull();
    // Without the backslash the same character is part of the body.
    expect(parseRdfLiteralLexicalTerm(`"a${terminator}b"`)).toEqual({
      body: `a${terminator}b`,
      suffix: { kind: 'plain' },
    });
  });

  it.each(LINE_TERMINATORS)('rejects %s in a bare datatype after its first character', (_name, terminator) => {
    expect(parseRdfLiteralLexicalTerm(`"7"^^urn:test:${terminator}datatype`)).toBeNull();
    expect(parseRdfLiteralLexicalTerm(`"7"^^urn:test:datatype${terminator}`)).toBeNull();
    expect(parseRdfLiteralLexicalTerm(`"7"^^${terminator}urn:test:datatype`)).toEqual({
      body: '7',
      suffix: { kind: 'datatype', datatype: `${terminator}urn:test:datatype`, syntax: 'bare' },
    });
    // A bracketed datatype never had the restriction.
    expect(parseRdfLiteralLexicalTerm(`"7"^^<urn:test:${terminator}datatype>`)).toEqual({
      body: '7',
      suffix: { kind: 'datatype', datatype: `urn:test:${terminator}datatype`, syntax: 'bracketed' },
    });
  });

  it('agrees with the replaced pattern on every short term over the structural alphabet', () => {
    const alphabet = ['"', '\\', '^', '<', '>', '@', 'a', '-', LF, LS];
    const differing: string[] = [];
    let checked = 0;
    let accepted = 0;
    const visit = (term: string, remaining: number): void => {
      const expected = splitWithReplacedPattern(term);
      checked += 1;
      if (expected !== 'null') accepted += 1;
      if (splitWithScanner(term) !== expected && differing.length < 5) differing.push(JSON.stringify(term));
      if (remaining === 0) return;
      for (const character of alphabet) visit(term + character, remaining - 1);
    };
    visit('"', 5);

    expect(differing).toEqual([]);
    // 1 + 10 + ... + 10^5 terms, and enough accepted ones for the agreement to mean something.
    expect(checked).toBe(111_111);
    expect(accepted).toBeGreaterThan(1_000);
  });

  it('agrees with the replaced pattern on longer generated terms', () => {
    // mulberry32: the corpus is the same on every run.
    let state = 0x2916;
    const next = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (items: readonly string[]): string => items[Math.floor(next() * items.length)]!;
    const run = (items: readonly string[], longest: number): string => {
      let out = '';
      for (let count = Math.floor(next() * (longest + 1)); count > 0; count -= 1) out += pick(items);
      return out;
    };
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xde00);
    const bodyParts = ['a', ' ', "'", 'é', '\\', '\\"', '\\\\', '\\n', LF, CR, LS, PS, high, low, high + low];
    const suffixParts = ['a', 'Z', '7', '-', ':', '^', '<', '>', '@', '"', '\\', LF, CR, LS, PS];

    const differing: string[] = [];
    let accepted = 0;
    for (let index = 0; index < 100_000; index += 1) {
      const term = `"${run(bodyParts, 8)}"${pick(['', '', '@', '^^', '^^<', '^'])}${run(suffixParts, 6)}${pick(['', '', '>'])}`;
      const expected = splitWithReplacedPattern(term);
      if (expected !== 'null') accepted += 1;
      if (splitWithScanner(term) !== expected && differing.length < 5) differing.push(JSON.stringify(term));
    }

    expect(differing).toEqual([]);
    expect(accepted).toBeGreaterThan(10_000);
  });
});
