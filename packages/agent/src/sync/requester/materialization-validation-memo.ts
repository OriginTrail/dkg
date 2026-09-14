import { BoundedLruCache } from '@origintrail-official/dkg-core';
import {
  asGraphWriteRevisionSource,
  type GraphWriteRevision,
  type GraphWriteRevisionSource,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_TTL_MS = 30_000;

export interface MaterializationValidationDescriptor {
  readonly graph: string;
  readonly digest: string;
  readonly count: number;
}

interface MaterializationValidationEntry {
  readonly digest: string;
  readonly count: number;
  readonly writeGeneration: number;
  readonly expiresAtMs: number;
}

export interface MaterializationValidationProbe {
  readonly reusable: boolean;
  /** Record a successful exact count-and-digest validation. */
  recordVerified(): void;
}

export interface MaterializationValidationMemoOptions {
  readonly enabled?: boolean;
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

function memoEnabledFromEnvironment(): boolean {
  const raw = process.env['DKG_SWM_MATERIALIZATION_WITNESS']?.trim();
  if (!raw) return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

/**
 * Bounded process-local memo for exact materialization measurements.
 *
 * Reuse is admitted only when the store supplies a stable revision token that
 * observes every writer. A process-local revision cannot certify a shared
 * SPARQL backend, so that capability always receives the exact validation path.
 */
export class MaterializationValidationMemo {
  private readonly entries: BoundedLruCache<string, MaterializationValidationEntry>;
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly writeRevisionSource: GraphWriteRevisionSource | null;

  constructor(
    store: TripleStore,
    options: MaterializationValidationMemoOptions = {},
  ) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new RangeError('materialization validation memo ttlMs must be a positive safe integer');
    }
    this.entries = new BoundedLruCache(maxEntries);
    this.enabled = options.enabled ?? memoEnabledFromEnvironment();
    this.now = options.now ?? Date.now;
    this.writeRevisionSource = asGraphWriteRevisionSource(store);
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('materialization validation memo clock must return a non-negative safe integer');
    }
    return value;
  }

  private stableRevision(descriptor: MaterializationValidationDescriptor): GraphWriteRevision | null {
    if (
      !this.enabled
      || descriptor.count === 0
      || this.writeRevisionSource?.writeRevisionCoverage !== 'all-writers'
    ) {
      return null;
    }
    try {
      const revision = this.writeRevisionSource.getWriteRevision(descriptor.graph);
      return revision.stable ? revision : null;
    } catch {
      return null;
    }
  }

  probe(descriptor: MaterializationValidationDescriptor): MaterializationValidationProbe {
    const initialRevision = this.stableRevision(descriptor);
    if (!initialRevision) return { reusable: false, recordVerified: () => {} };

    const entry = this.entries.get(descriptor.graph);
    const nowMs = this.currentTime();
    const reusable = entry !== undefined
      && entry.digest === descriptor.digest
      && entry.count === descriptor.count
      && entry.writeGeneration === initialRevision.generation
      && entry.expiresAtMs > nowMs;
    if (entry !== undefined && !reusable) this.entries.delete(descriptor.graph);

    let recorded = false;
    return {
      reusable,
      recordVerified: () => {
        if (recorded || reusable) return;
        recorded = true;
        const finalRevision = this.stableRevision(descriptor);
        if (!finalRevision || finalRevision.generation !== initialRevision.generation) return;
        const verifiedAtMs = this.currentTime();
        const expiresAtMs = verifiedAtMs + this.ttlMs;
        if (!Number.isSafeInteger(expiresAtMs)) {
          throw new TypeError('materialization validation memo expiry exceeds the safe integer range');
        }
        this.entries.set(descriptor.graph, {
          digest: descriptor.digest,
          count: descriptor.count,
          writeGeneration: finalRevision.generation,
          expiresAtMs,
        });
      },
    };
  }

  delete(graph: string): void {
    this.entries.delete(graph);
  }
}

export function createMaterializationValidationMemo(
  store: TripleStore,
  options?: MaterializationValidationMemoOptions,
): MaterializationValidationMemo {
  return new MaterializationValidationMemo(store, options);
}
