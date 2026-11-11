import { describe, expect, it } from 'vitest';
import { kindColor, kindColorForType } from '../src/ui/entity-kind-colors.js';

describe('entity kind colours (C12)', () => {
  it('gives kinds that appear together distinct data-palette slots', () => {
    const work = ['package', 'file', 'decision', 'task', 'pr', 'issue', 'commit'] as const;
    const code = ['package', 'file', 'class', 'function', 'typeAlias', 'enum', 'interface'] as const;
    for (const kinds of [work, code]) {
      const cols = kinds.map(kindColor);
      expect(new Set(cols).size).toBe(kinds.length);
      for (const c of cols) expect(c).toMatch(/^var\(--data-[1-8]\)$/);
    }
  });
  it('resolves rdf:type IRIs and returns null for unknown types', () => {
    expect(kindColorForType('http://dkg.io/ontology/decisions/Decision')).toBe(kindColor('decision'));
    expect(kindColorForType('http://schema.org/Thing')).toBeNull();
  });
});
