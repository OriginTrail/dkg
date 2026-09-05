import { BoundedLruCache } from './bounded-lru-cache.js';

export type CachedSparqlOperationFacts = Readonly<{
  form: string;
  mutatingKeyword: string | null;
  /** Lexically complete with balanced delimiters, so the large tier may retain it. */
  largeCacheable: boolean;
}>;

const SMALL_MAX_ENTRIES = 256;
const SMALL_MAX_SOURCE_LENGTH = 64 * 1024;
const LARGE_MAX_ENTRIES = 4;
const LARGE_MAX_SOURCE_LENGTH = 2 * 1024 * 1024;

type CacheTier = 'small' | 'large';

function createTiers() {
  return {
    small: new BoundedLruCache<string, CachedSparqlOperationFacts>(
      SMALL_MAX_ENTRIES,
      (source) => source.length <= SMALL_MAX_SOURCE_LENGTH,
    ),
    large: new BoundedLruCache<string, CachedSparqlOperationFacts>(
      LARGE_MAX_ENTRIES,
      (source, facts) => source.length > SMALL_MAX_SOURCE_LENGTH
        && source.length <= LARGE_MAX_SOURCE_LENGTH
        && facts.largeCacheable,
    ),
  };
}

/** Package-internal cache boundary; intentionally not re-exported by core's root. */
export class SparqlAnalysisCache {
  private readonly tiers = createTiers();

  private tierFor(source: string): CacheTier {
    return source.length <= SMALL_MAX_SOURCE_LENGTH ? 'small' : 'large';
  }

  get(source: string): CachedSparqlOperationFacts | undefined {
    return this.tiers[this.tierFor(source)].get(source);
  }

  set(source: string, facts: CachedSparqlOperationFacts): void {
    this.tiers[this.tierFor(source)].set(source, facts);
  }

}

export const sparqlAnalysisCache = new SparqlAnalysisCache();
