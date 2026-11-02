import { describe, expect, it } from 'vitest';
import { kindColor, kindColorForType } from '../src/ui/entity-kind-colors.js';

describe('entity kind colours (C12)', () => {
  it('maps each known kind to its own data-palette slot', () => {
    const kinds = ['package', 'file', 'decision', 'task', 'pr', 'issue', 'commit'] as const;
    const cols = kinds.map(kindColor);
    expect(new Set(cols).size).toBe(kinds.length);
    for (const c of cols) expect(c).toMatch(/^var\(--data-[1-8]\)$/);
  });
  it('resolves rdf:type IRIs and returns null for unknown types', () => {
    expect(kindColorForType('http://dkg.io/ontology/decisions/Decision')).toBe(kindColor('decision'));
    expect(kindColorForType('http://schema.org/Thing')).toBeNull();
  });
});
