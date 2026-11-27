import { BoundedLruCache } from './bounded-lru-cache.js';

/** Cohesive analyzer result retained by the cache and inspected for admission. */
export type SparqlAnalysisCacheEntry = Readonly<{
  largeCacheable: boolean;
}>;

const SMALL_MAX_ENTRIES = 256;
const SMALL_MAX_SOURCE_LENGTH = 64 * 1024;
const LARGE_MAX_ENTRIES = 4;
const LARGE_MAX_SOURCE_LENGTH = 2 * 1024 * 1024;

type CacheTier = 'small' | 'large';

function createTiers<Value extends SparqlAnalysisCacheEntry>() {
  return {
    small: new BoundedLruCache<string, Value>(
      SMALL_MAX_ENTRIES,
      (source) => source.length <= SMALL_MAX_SOURCE_LENGTH,
    ),
    large: new BoundedLruCache<string, Value>(
      LARGE_MAX_ENTRIES,
      (source) => source.length > SMALL_MAX_SOURCE_LENGTH
        && source.length <= LARGE_MAX_SOURCE_LENGTH,
    ),
  };
}

/** Package-internal cache boundary; intentionally not re-exported by core's root. */
export class SparqlAnalysisCache<Value extends SparqlAnalysisCacheEntry> {
  private readonly tiers = createTiers<Value>();

  private tierFor(source: string): CacheTier {
    return source.length <= SMALL_MAX_SOURCE_LENGTH ? 'small' : 'large';
  }

  get(source: string): Value | undefined {
    return this.tiers[this.tierFor(source)].get(source);
  }

  set(source: string, value: Value): void {
    const tier = this.tierFor(source);
    if (tier === 'large' && !value.largeCacheable) return;
    this.tiers[tier].set(source, value);
  }
}
