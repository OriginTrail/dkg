import { describe, expect, it } from 'vitest';

import { CATALOG_PERSIST_SOURCES } from '../src/catalog-persistence.js';

/**
 * `QueryOptions.source` is an observable diagnostic and failure-injection
 * contract: storage-side tooling and the ACK dead-air guards select store calls
 * by these exact tags.
 *
 * Driven by the production map at RUNTIME, not by the type. The publisher
 * package typechecks only `src`, so a type-level exhaustiveness check here would
 * never execute — a step added to the union would slip through green. Pinning the
 * whole map means a new step is covered automatically.
 *
 * Deliberately NOT asserted: that a tag is derived from its step key. The map
 * exists so the observable tag and the internal step name can move apart — a key
 * rename that intentionally preserves the public tag must stay expressible, and a
 * derived-prefix check would fail it, pushing the maintainer to change the tag
 * instead of the key.
 */
describe('catalog-persist source tags', () => {
  it('pins the exact tag for every step in the production map', () => {
    expect(CATALOG_PERSIST_SOURCES).toEqual({
      deleteSubjects: 'storage-ack.persistCatalog.deleteSubjects',
      deleteByPattern: 'storage-ack.persistCatalog.deleteByPattern',
      insert: 'storage-ack.persistCatalog.insert',
      flush: 'storage-ack.persistCatalog.flush',
    });
  });

  it('gives every step a distinct tag', () => {
    const sources = Object.values(CATALOG_PERSIST_SOURCES);
    expect(sources.length).toBeGreaterThan(0);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
