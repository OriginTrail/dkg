import { describe, expect, it } from 'vitest';

import { CATALOG_PERSIST_SOURCES } from '../src/catalog-persistence.js';

/**
 * `QueryOptions.source` is an observable diagnostic and failure-injection
 * contract: storage-side tooling and the ACK dead-air guards select store calls
 * by these exact tags.
 *
 * Driven by the production map at RUNTIME, not by the type. The publisher
 * package typechecks only `src`, so a type-level exhaustiveness check here would
 * never execute — a step added to the union would slip through green. Iterating
 * the map itself means a new step is covered automatically, and the expected-key
 * assertion is what fails if one is added without a decision.
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

  it('gives every step a distinct, correctly-prefixed tag', () => {
    const entries = Object.entries(CATALOG_PERSIST_SOURCES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [step, source] of entries) {
      expect(source).toBe(`storage-ack.persistCatalog.${step}`);
    }
    expect(new Set(entries.map(([, source]) => source)).size).toBe(entries.length);
  });
});
