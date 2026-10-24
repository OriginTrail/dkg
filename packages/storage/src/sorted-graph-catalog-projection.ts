import { filterSortedUniqueStringCatalog } from '@origintrail-official/dkg-core';
import type { SortedGraphCatalog } from './graph-set-index-store.js';

/** Memoized immutable projection of an immutable sorted graph catalog. */
export class SortedGraphCatalogProjection {
  private cached: {
    source: SortedGraphCatalog;
    value: SortedGraphCatalog;
  } | null = null;

  constructor(private readonly include: (graph: string) => boolean) {}

  project(source: SortedGraphCatalog): SortedGraphCatalog {
    if (this.cached?.source === source) return this.cached.value;
    const value = filterSortedUniqueStringCatalog(source, this.include);
    this.cached = { source, value };
    return value;
  }
}
