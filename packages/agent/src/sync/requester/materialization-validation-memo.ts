import { BoundedLruCache } from '@origintrail-official/dkg-core';
import {
  type GraphWriteRevision,
  type GraphWriteRevisionSource,
} from '@origintrail-official/dkg-storage';
import type {
  GraphScopedSwmMaterializationDescriptor,
} from '../graph-scoped-swm-recovery.js';

const DEFAULT_MAX_ENTRIES = 4_096;

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

  private stableRevision(
    descriptor: GraphScopedSwmMaterializationDescriptor,
  ): GraphWriteRevision | null {
    if (
      !this.enabled
      || descriptor.publicQuadsCount === 0
      || this.writeRevisionSource?.writeRevisionCoverage !== 'all-writers'
    ) {
      return null;
    }
    try {
      const revision = this.writeRevisionSource.getWriteRevision(descriptor.assertionGraph);
      return revision.stable ? revision : null;
    } catch {
      return null;
    }
  }

  async validate<Descriptor extends GraphScopedSwmMaterializationDescriptor>(
    descriptor: Descriptor,
    exactValidation: (descriptor: Descriptor) => Promise<boolean>,
  ): Promise<boolean> {
    const initialRevision = this.stableRevision(descriptor);
    if (!initialRevision) return exactValidation(descriptor);

    const entry = this.entries.get(descriptor.assertionGraph);
    const reusable = entry !== undefined
      && entry.digest === descriptor.publicQuadsDigest
      && entry.count === descriptor.publicQuadsCount
      && entry.writeGeneration === initialRevision.generation;
    if (reusable) return true;

    const verified = await exactValidation(descriptor);
    if (!verified) return false;
    const finalRevision = this.stableRevision(descriptor);
    if (!finalRevision || finalRevision.generation !== initialRevision.generation) return true;
    this.entries.set(descriptor.assertionGraph, {
      digest: descriptor.publicQuadsDigest,
      count: descriptor.publicQuadsCount,
      writeGeneration: finalRevision.generation,
    });
    return true;
  }
}
