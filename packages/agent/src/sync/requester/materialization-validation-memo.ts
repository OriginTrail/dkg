import { BoundedLruCache } from '@origintrail-official/dkg-core';
import {
  asGraphWriteRevisionSource,
  type GraphWriteRevision,
  type GraphWriteRevisionSource,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

const DEFAULT_MAX_ENTRIES = 4_096;

export interface MaterializationValidationDescriptor {
  readonly graph: string;
  readonly digest: string;
  readonly count: number;
}

interface MaterializationValidationEntry {
  readonly digest: string;
  readonly count: number;
  readonly writeGeneration: number;
}

export interface MaterializationValidationMemoOptions {
  readonly enabled?: boolean;
  readonly maxEntries?: number;
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
  private readonly writeRevisionSource: GraphWriteRevisionSource | null;

  constructor(
    store: TripleStore,
    options: MaterializationValidationMemoOptions = {},
  ) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.entries = new BoundedLruCache(maxEntries);
    this.enabled = options.enabled ?? memoEnabledFromEnvironment();
    this.writeRevisionSource = asGraphWriteRevisionSource(store);
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

  async validate(
    descriptor: MaterializationValidationDescriptor,
    exactValidation: () => Promise<boolean>,
  ): Promise<boolean> {
    const initialRevision = this.stableRevision(descriptor);
    if (!initialRevision) return exactValidation();

    const entry = this.entries.get(descriptor.graph);
    const reusable = entry !== undefined
      && entry.digest === descriptor.digest
      && entry.count === descriptor.count
      && entry.writeGeneration === initialRevision.generation;
    if (reusable) return true;

    const verified = await exactValidation();
    if (!verified) return false;
    const finalRevision = this.stableRevision(descriptor);
    if (!finalRevision || finalRevision.generation !== initialRevision.generation) return true;
    this.entries.set(descriptor.graph, {
      digest: descriptor.digest,
      count: descriptor.count,
      writeGeneration: finalRevision.generation,
    });
    return true;
  }
}

export function createMaterializationValidationMemo(
  store: TripleStore,
  options?: MaterializationValidationMemoOptions,
): MaterializationValidationMemo {
  return new MaterializationValidationMemo(store, options);
}
