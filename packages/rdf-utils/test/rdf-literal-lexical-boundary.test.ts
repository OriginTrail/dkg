import { describe, expect, it } from 'vitest';
import { parseRdfLiteralLexicalTerm } from '../src/index.js';

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
