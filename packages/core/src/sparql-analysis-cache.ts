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

interface CacheCounters {
  smallHits: number;
  smallMisses: number;
  largeHits: number;
  largeMisses: number;
}

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
class SparqlAnalysisCache {
  private tiers = createTiers();
  private collectTestingMetrics = false;
  private counters: CacheCounters = {
    smallHits: 0,
    smallMisses: 0,
    largeHits: 0,
    largeMisses: 0,
  };

  private tierFor(source: string): CacheTier {
    return source.length <= SMALL_MAX_SOURCE_LENGTH ? 'small' : 'large';
  }

  get(source: string): CachedSparqlOperationFacts | undefined {
    const tier = this.tierFor(source);
    const value = this.tiers[tier].get(source);
    if (this.collectTestingMetrics) {
      if (tier === 'small') {
        if (value === undefined) this.counters.smallMisses += 1;
        else this.counters.smallHits += 1;
      } else if (value === undefined) this.counters.largeMisses += 1;
      else this.counters.largeHits += 1;
    }
    return value;
  }

  set(source: string, facts: CachedSparqlOperationFacts): void {
    this.tiers[this.tierFor(source)].set(source, facts);
  }

  resetForTesting(): void {
    this.tiers = createTiers();
    this.collectTestingMetrics = true;
    this.counters = {
      smallHits: 0,
      smallMisses: 0,
      largeHits: 0,
      largeMisses: 0,
    };
  }

  snapshotForTesting() {
    return Object.freeze({
      ...this.counters,
      smallSize: this.tiers.small.size,
      largeSize: this.tiers.large.size,
    });
  }

  hasForTesting(source: string): boolean {
    return this.tiers[this.tierFor(source)].has(source);
  }
}

export const sparqlAnalysisCache = new SparqlAnalysisCache();

/** Deep-imported by package tests; absent from the published root API. */
export const sparqlAnalysisCacheTesting = Object.freeze({
  reset: () => sparqlAnalysisCache.resetForTesting(),
  snapshot: () => sparqlAnalysisCache.snapshotForTesting(),
  has: (source: string) => sparqlAnalysisCache.hasForTesting(source),
  smallMaxSourceLength: SMALL_MAX_SOURCE_LENGTH,
  largeMaxSourceLength: LARGE_MAX_SOURCE_LENGTH,
});
