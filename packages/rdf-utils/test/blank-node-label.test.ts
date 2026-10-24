import { describe, expect, it } from 'vitest';
import { isRdfBlankNodeLabel } from '../src/index.js';

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
