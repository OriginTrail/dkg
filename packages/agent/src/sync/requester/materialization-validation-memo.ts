import { BoundedLruCache } from '@origintrail-official/dkg-core';
import {
  type GraphWriteRevision,
  type GraphWriteRevisionSource,
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

export interface MaterializationValidationMemoConfig {
  readonly enabled: boolean;
  readonly maxEntries?: number;
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
    writeRevisionSource: GraphWriteRevisionSource | null,
    config: MaterializationValidationMemoConfig,
  ) {
    const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.entries = new BoundedLruCache(maxEntries);
    this.enabled = config.enabled;
    this.writeRevisionSource = writeRevisionSource;
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
