import { describe, expect, it } from 'vitest';
import { compareCodePoint } from '../src/sync/responder/graph-plan.js';

function allocatingReference(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = left[index].codePointAt(0)! - right[index].codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

function buildCorpus(): string[] {
  const atoms = [
    '',
    '\0',
    'a',
    'z',
    '\u007F',
    '\u0080',
    '\u07FF',
    '\u0800',
    '\uD7FF',
    '\uD800',
    '\uDBFF',
    '\uDC00',
    '\uDFFF',
    '\uE000',
    '\uFFFF',
    String.fromCodePoint(0x10000),
    String.fromCodePoint(0x1F600),
    String.fromCodePoint(0x10FFFF),
  ];
  const corpus = new Set<string>([
    ...atoms,
    'did:dkg:context-graph:profile/data',
    'did:dkg:context-graph:profile/data/assertion/000001',
    'did:dkg:context-graph:profile/data/assertion/000002',
    'did:dkg:context-graph:profile/swm/_meta',
  ]);
  for (const left of atoms) {
    corpus.add(`urn:dkg:graph:${left}`);
    for (const right of atoms) corpus.add(`${left}${right}`);
  }
  return [...corpus];
}

describe('graph-plan code-point ordering', () => {
  it('matches the allocating comparator exactly across Unicode boundaries', () => {
    const corpus = buildCorpus();
    let comparisons = 0;
    for (const left of corpus) {
      for (const right of corpus) {
        const expected = allocatingReference(left, right);
        const actual = compareCodePoint(left, right);
        if (actual !== expected) {
          throw new Error(
            `comparison mismatch for ${JSON.stringify(left)} and ${JSON.stringify(right)}: ` +
            `expected ${expected}, received ${actual}`,
          );
        }
        comparisons += 1;
      }
    }
    expect(comparisons).toBeGreaterThan(100_000);
  });

  it('produces the same deterministic graph order as the allocating comparator', () => {
    const corpus = buildCorpus().reverse();
    expect([...corpus].sort(compareCodePoint)).toEqual([...corpus].sort(allocatingReference));
  });
});
