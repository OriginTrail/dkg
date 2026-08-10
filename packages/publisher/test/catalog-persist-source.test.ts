import { describe, expect, it } from 'vitest';

import { catalogPersistSource, type CatalogPersistStep } from '../src/catalog-persistence.js';

/**
 * `QueryOptions.source` is an observable diagnostic and failure-injection
 * contract: storage-side tooling and the ACK dead-air guards select calls by
 * this exact tag. Pin the literal strings here, independently of the builder.
 *
 * Every other assertion in the suite now compares against `catalogPersistSource(step)`,
 * which proves the WIRING (production and test agree) but cannot prove the FORMAT —
 * a changed prefix would move both sides together and stay green. These literals are
 * the half that fails when the externally visible tag changes.
 */
describe('catalog-persist source tags', () => {
  it('pins the canonical source string for every step', () => {
    expect(catalogPersistSource('deleteSubjects')).toBe('storage-ack.persistCatalog.deleteSubjects');
    expect(catalogPersistSource('deleteByPattern')).toBe('storage-ack.persistCatalog.deleteByPattern');
    expect(catalogPersistSource('insert')).toBe('storage-ack.persistCatalog.insert');
    expect(catalogPersistSource('flush')).toBe('storage-ack.persistCatalog.flush');
  });

  it('covers every member of the step union', () => {
    const steps: readonly CatalogPersistStep[] = [
      'deleteSubjects', 'deleteByPattern', 'insert', 'flush',
    ];
    // A step added to the union without a literal above would leave this list
    // stale; the exhaustive switch makes that a compile error rather than a gap.
    for (const step of steps) {
      const covered: boolean = ((s: CatalogPersistStep): boolean => {
        switch (s) {
          case 'deleteSubjects': case 'deleteByPattern': case 'insert': case 'flush': return true;
          default: { const never: never = s; return never; }
        }
      })(step);
      expect(covered).toBe(true);
      expect(catalogPersistSource(step)).toBe(`storage-ack.persistCatalog.${step}`);
    }
  });
});
