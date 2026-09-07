import { describe, expect, it } from 'vitest';
import {
  codePointLowerBound,
  createSortedUniqueStringCatalog,
  insertSortedUniqueStringCatalog,
  removeSortedUniqueStringCatalog,
} from '../src/code-point-order.js';

describe('sorted unique string catalog mutation', () => {
  it('shares one canonical lower-bound lookup across catalog consumers', () => {
    const catalog = createSortedUniqueStringCatalog(['a', 'c', '\uE000', '\u{10000}']);
    expect(codePointLowerBound(catalog, '0')).toBe(0);
    expect(codePointLowerBound(catalog, 'b')).toBe(1);
    expect(codePointLowerBound(catalog, 'c')).toBe(1);
    expect(codePointLowerBound(catalog, '\uFFFF')).toBe(3);
    expect(codePointLowerBound(catalog, '\u{10001}')).toBe(4);
  });

  it('inserts immutably at the beginning, middle, and end', () => {
    let catalog = createSortedUniqueStringCatalog(['b', 'd']);
    catalog = insertSortedUniqueStringCatalog(catalog, 'a');
    catalog = insertSortedUniqueStringCatalog(catalog, 'c');
    catalog = insertSortedUniqueStringCatalog(catalog, 'e');

    expect(catalog).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it('removes immutably at the beginning, middle, and end', () => {
    let catalog = createSortedUniqueStringCatalog(['a', 'b', 'c', 'd', 'e']);
    catalog = removeSortedUniqueStringCatalog(catalog, 'a');
    catalog = removeSortedUniqueStringCatalog(catalog, 'c');
    catalog = removeSortedUniqueStringCatalog(catalog, 'e');

    expect(catalog).toEqual(['b', 'd']);
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it('returns the original catalog for duplicate insertion and missing removal', () => {
    const catalog = createSortedUniqueStringCatalog(['a', 'b']);

    expect(insertSortedUniqueStringCatalog(catalog, 'a')).toBe(catalog);
    expect(removeSortedUniqueStringCatalog(catalog, 'missing')).toBe(catalog);
  });

  it('preserves Unicode code-point ordering', () => {
    const astral = 'urn:\u{10000}';
    const privateUse = 'urn:\uE000';
    let catalog = createSortedUniqueStringCatalog(['urn:a', astral]);

    catalog = insertSortedUniqueStringCatalog(catalog, privateUse);
    expect(catalog).toEqual(['urn:a', privateUse, astral]);
    expect(removeSortedUniqueStringCatalog(catalog, privateUse)).toEqual(['urn:a', astral]);
  });
});
