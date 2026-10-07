import { describe, expect, it } from 'vitest';
import { isRdfBlankNodeLabel, parseSparqlTsvResultTerm, parseWritableRdfTerm } from '../src/index.js';

describe('isRdfBlankNodeLabel', () => {
  it.each([
    'b0',
    '0',
    '_',
    '7f3a9c0e5d',
    'c14n0',
    'n3-0',
    'a.b',
    'genid_1',
    'é',
    'x·y',
    'á',
    'x‿y',
    '😀',
  ])('accepts %s', (label) => {
    expect(isRdfBlankNodeLabel(label)).toBe(true);
  });

  it.each([
    '',
    '_:b0',
    'b.',
    '.b',
    '-b',
    '·b',
    'a b',
    'b\n',
    'b>',
    'b:c',
    'ª',
    '×',
  ])('rejects %j', (label) => {
    expect(isRdfBlankNodeLabel(label)).toBe(false);
  });
});

// The BLANK_NODE_LABEL grammar has one implementation, isRdfBlankNodeLabel. The
// writable-term and TSV parsers give the same verdict on every label, so a
// scanner of their own can never drift from it unnoticed.
describe('one blank-node label grammar across the validator and both parsers', () => {
  // The first and last code point of each production range, and their neighbours.
  const boundaries = [
    0x2d, 0x30, 0x39, 0x41, 0x5a, 0x5f, 0x61, 0x7a, 0xb7, 0xc0, 0xd6, 0xd8, 0xf6, 0xf8, 0x2ff, 0x300, 0x36f,
    0x370, 0x37d, 0x37f, 0x1fff, 0x200c, 0x200d, 0x203f, 0x2040, 0x2070, 0x218f, 0x2c00, 0x2fef, 0x3001,
    0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xf900, 0xfdcf, 0xfdf0, 0xfffd, 0xffff, 0x10000, 0xeffff, 0xf0000,
    0x10ffff,
  ].flatMap((codePoint) => [codePoint - 1, codePoint, codePoint + 1]).filter((codePoint) => codePoint >= 0 && codePoint <= 0x10ffff);
  const characters = [...new Set(boundaries)].map((codePoint) => String.fromCodePoint(codePoint));

  const labels = new Set<string>(['', '.', 'a.', '.a', 'a.b', 'a..b', 'a...b', 'a.·', 'a·.', 'a.\u0300', String.raw`\u0061`, String.raw`a\u0062`,
    String.raw`\U00000061`, String.raw`_\u0301`, '\ud83d', 'a\ud83d', '\ude00', 'a\ude00', '\ud83dx', '😀', 'a😀', 'a😀b']);
  for (const character of characters) {
    labels.add(character);
    labels.add(`a${character}`);
    labels.add(`a${character}b`);
    labels.add(`${character}b`);
    labels.add(`a${character}.`);
  }
  const alphabet = ['a', '0', '_', '-', '.', '·', '\u0300', 'é', '×', '\\', '\ud800', '\udc00', '😀'];
  const extend = (prefixes: string[]) => prefixes.flatMap((prefix) => alphabet.map((character) => prefix + character));
  // Every string of up to three characters over a structural alphabet.
  let level = [''];
  for (let length = 1; length <= 3; length += 1) {
    level = extend(level);
    for (const label of level) labels.add(label);
  }

  it('covers accepted and rejected labels of every kind', () => {
    const verdicts = [...labels].map((label) => isRdfBlankNodeLabel(label));
    expect(verdicts.filter(Boolean).length).toBeGreaterThan(500);
    expect(verdicts.filter((accepted) => !accepted).length).toBeGreaterThan(500);
  });

  it('gives the validator, the writable-term parser and the TSV parser one verdict per label', () => {
    const disagreements: string[] = [];
    for (const label of labels) {
      const expected = isRdfBlankNodeLabel(label);
      const writable = parseWritableRdfTerm(`_:${label}`);
      const tsv = parseSparqlTsvResultTerm(`_:${label}`);
      const parsedAsBlankNode = (term: { kind: string; value?: unknown } | null) => term?.kind === 'blank-node';
      if (parsedAsBlankNode(writable) !== expected || parsedAsBlankNode(tsv) !== expected) {
        disagreements.push(JSON.stringify(label));
      }
      if (expected) {
        expect(writable).toEqual({ kind: 'blank-node', value: label });
        expect(tsv).toEqual({ kind: 'blank-node', value: label });
      }
    }
    expect(disagreements).toEqual([]);
  });
});
