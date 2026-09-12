import { describe, expect, it } from 'vitest';
import { swmEntityWriteLockKey, swmKaWriteLockKey } from '../src/index.js';

describe('SWM write-lock key compatibility', () => {
  it.each([
    { name: 'root', subGraphName: undefined, namespace: 'ExampleCG' },
    { name: 'named subgraph', subGraphName: 'Claims', namespace: 'ExampleCG\0Claims' },
    { name: 'legacy empty subgraph', subGraphName: '', namespace: 'ExampleCG' },
  ])('preserves entity and KA key bytes for $name', ({ subGraphName, namespace }) => {
    expect(swmEntityWriteLockKey('ExampleCG', subGraphName, 'urn:entity:Alice'))
      .toBe(`${namespace}\0urn:entity:Alice`);
    expect(swmKaWriteLockKey('ExampleCG', subGraphName, 'did:dkg:31337/0xABCD/1'))
      .toBe(`${namespace}\0ka\0did:dkg:31337/0xabcd/1`);
  });

  it('keeps differently cased RDF subjects in distinct entity locks', () => {
    expect(swmEntityWriteLockKey('ExampleCG', undefined, 'urn:entity:Alice'))
      .not.toBe(swmEntityWriteLockKey('ExampleCG', undefined, 'urn:entity:alice'));
  });
});
