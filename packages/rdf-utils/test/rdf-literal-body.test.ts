import { describe, expect, it } from 'vitest';
import { rdfLiteralBody } from '../src/index.js';

// The backtracking patterns rdfLiteralBody replaces. The equivalence tests run
// them only on short terms, where they are fast.
const LITERAL_PATTERN = /^"(.*)"(?:\^\^.*|@.*)?$/;
const ANY_SUFFIX_PATTERN = /^"(.*)".*$/;

// The agent and publisher helpers that `plainQuoted` replaces: a quoted term
// first, then the backtracking pattern.
function plainQuotedBefore(term: string): string | undefined {
  if (term.startsWith('"') && term.endsWith('"')) return term.slice(1, -1);
  return LITERAL_PATTERN.exec(term)?.[1];
}

// Every character that matters to those patterns, plus one that doesn't.
const ALPHABET = ['"', '^', '@', '\n', 'a'] as const;

function termsUpTo(maxLength: number): string[] {
  const terms = [''];
  let layer = [''];
  for (let length = 1; length <= maxLength; length++) {
    layer = layer.flatMap((prefix) => ALPHABET.map((character) => prefix + character));
    terms.push(...layer);
  }
  return terms;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mismatches(terms: readonly string[]): string[] {
  return terms
    .filter((term) => rdfLiteralBody(term) !== LITERAL_PATTERN.exec(term)?.[1]
      || rdfLiteralBody(term, { anySuffix: true }) !== ANY_SUFFIX_PATTERN.exec(term)?.[1]
      || rdfLiteralBody(term, { plainQuoted: true }) !== plainQuotedBefore(term))
    .map((term) => JSON.stringify(term));
}

describe('rdfLiteralBody', () => {
  it('returns the body of plain, typed and language-tagged literals', () => {
    expect(rdfLiteralBody('"a"')).toBe('a');
    expect(rdfLiteralBody('""')).toBe('');
    expect(rdfLiteralBody('"42"^^<http://www.w3.org/2001/XMLSchema#integer>')).toBe('42');
    expect(rdfLiteralBody('"42"^^xsd:integer')).toBe('42');
    expect(rdfLiteralBody('"hallo"@de')).toBe('hallo');
  });

  it('returns the body as written, ending at the last quote a suffix may follow', () => {
    expect(rdfLiteralBody('"say \\"hi\\""')).toBe('say \\"hi\\"');
    expect(rdfLiteralBody('"say "hi""')).toBe('say "hi"');
    expect(rdfLiteralBody('"a"@en"b')).toBe('a');
    expect(rdfLiteralBody('"a"^^<x>"')).toBe('a"^^<x>');
  });

  it('returns undefined for a term that is not a literal', () => {
    for (const term of ['', '"', 'a', '<http://example.org/a>', '_:b0', '"a', '"a"b', '"a"^b', 'a"b"']) {
      expect(rdfLiteralBody(term)).toBeUndefined();
    }
  });

  it('returns undefined for a term with a line terminator', () => {
    for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
      expect(rdfLiteralBody(`"a${terminator}b"`)).toBeUndefined();
      expect(rdfLiteralBody(`"a"@en${terminator}`)).toBeUndefined();
    }
  });

  it('with anySuffix, ends the body at the last quote whatever follows it', () => {
    expect(rdfLiteralBody('"a"b', { anySuffix: true })).toBe('a');
    expect(rdfLiteralBody('"a"b"c', { anySuffix: true })).toBe('a"b');
    expect(rdfLiteralBody('"a', { anySuffix: true })).toBeUndefined();
    expect(rdfLiteralBody('"a"b\n', { anySuffix: true })).toBeUndefined();
  });

  it('with plainQuoted, takes any quoted term as a plain literal first', () => {
    expect(rdfLiteralBody('"line one\nline two"', { plainQuoted: true })).toBe('line one\nline two');
    expect(rdfLiteralBody('"a"b"', { plainQuoted: true })).toBe('a"b');
    expect(rdfLiteralBody('"', { plainQuoted: true })).toBe('');
    expect(rdfLiteralBody('"42"^^<http://www.w3.org/2001/XMLSchema#integer>', { plainQuoted: true })).toBe('42');
    expect(rdfLiteralBody('<http://example.org/a>', { plainQuoted: true })).toBeUndefined();
  });

  it('gives the replaced patterns\' result for every term of up to seven characters', () => {
    expect(mismatches(termsUpTo(7))).toEqual([]);
  });

  it('gives the replaced patterns\' result for longer random terms', () => {
    const random = seededRandom(3585);
    const terms = Array.from({ length: 5_000 }, () => {
      const length = 8 + Math.floor(random() * 40);
      const characters = Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]);
      if (random() < 0.8) characters[0] = '"';
      return characters.join('');
    });
    expect(mismatches(terms)).toEqual([]);
  });

  it('runs in linear time on terms that make the replaced patterns backtrack', () => {
    const repeats = 60_000;
    const terms = [
      `""^^${'"^^'.repeat(repeats)}\n`,
      `"${'"a'.repeat(repeats)}`,
      `"${'a"'.repeat(repeats)}b`,
    ];
    for (const term of terms) {
      const started = performance.now();
      rdfLiteralBody(term);
      rdfLiteralBody(term, { anySuffix: true });
      rdfLiteralBody(term, { plainQuoted: true });
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
});
