import { BoundedLruCache } from '@origintrail-official/dkg-core';
import { asGraphWriteRevisionSource, type GraphWriteRevision, type TripleStore } from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';

const MATERIALIZATION_MEMO_TTL_MS = 30_000;
const MATERIALIZATION_MEMO_MAX_ENTRIES = 1024;

type MaterializationVersion = Pick<GraphScopedSwmRecoveryDescriptor,
  'assertionGraph' | 'publicQuadsDigest' | 'publicQuadsCount'>;

interface MaterializationMemoEntry {
  digest: string;
  count: number;
  generation: number;
  expiresAt: number;
}

/** Successful content validation, reusable only when every graph writer is observed. */
export function createSwmMaterializationMemo(store: TripleStore) {
  const revisionSource = asGraphWriteRevisionSource(store);
  const source = revisionSource?.writeRevisionCoverage === 'all-writers' ? revisionSource : null;
  // A graph has only one current version. A new admission replaces the prior version.
  const entries = new BoundedLruCache<string, MaterializationMemoEntry>(MATERIALIZATION_MEMO_MAX_ENTRIES);

  const readRevision = (assertionGraph: string): GraphWriteRevision | null => {
    try {
      return source?.getWriteRevision(assertionGraph) ?? null;
    } catch {
      // A failed capability probe costs a validation, never a materialization failure.
      return null;
    }
  };

  return {
    readRevision,
    has(descriptor: MaterializationVersion): boolean {
      if (!source || descriptor.publicQuadsCount <= 0) return false;
      const revision = readRevision(descriptor.assertionGraph);
      if (!revision?.stable) return false;
      const entry = entries.get(descriptor.assertionGraph);
      if (!entry) return false;
      if (entry.expiresAt <= Date.now() || entry.generation !== revision.generation) {
        entries.delete(descriptor.assertionGraph);
        return false;
      }
      return entry.digest === descriptor.publicQuadsDigest && entry.count === descriptor.publicQuadsCount;
    },
    admit(
      descriptor: MaterializationVersion,
      before: GraphWriteRevision | null,
      after: GraphWriteRevision | null,
    ): void {
      // Empty projections require a control-plane health check on every call.
      if (!source || descriptor.publicQuadsCount <= 0 || !before?.stable || !after?.stable
        || before.generation !== after.generation) return;
      entries.set(descriptor.assertionGraph, {
        digest: descriptor.publicQuadsDigest,
        count: descriptor.publicQuadsCount,
        generation: after.generation,
        expiresAt: Date.now() + MATERIALIZATION_MEMO_TTL_MS,
      });
    },
    invalidate(assertionGraph: string): void {
      entries.delete(assertionGraph);
    },
  };
}
