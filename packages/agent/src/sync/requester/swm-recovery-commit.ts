// SPDX-License-Identifier: Apache-2.0
import { healthyRecoveredAliasRows } from './swm-draft-order.js';
import type { DurableRootAtomicCompanionResolver } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';
import type { SharedMemorySnapshotMaterializer } from './swm-snapshot-materializer.js';
import { canonicalQuadKey } from './quad-key.js';

export interface SwmRecoveryCommitResult {
  readonly kind: 'committed' | 'superseded' | 'deferred';
  readonly insertedGraphQuads: number;
  readonly insertedMetaQuads: number;
  /** Every provider row this locked operation has settled, for later bulk writes. */
  readonly withholdRows: readonly Quad[];
}

/** Preserve the verified asset's mode and require acquisition only for replacement. */
export type SwmRecoveryCommitAsset =
  | { readonly kind: 'replace'; readonly descriptor: GraphScopedSwmRecoveryDescriptor;
      readonly loadVerifiedQuads: () => Promise<readonly Quad[]> }
  | { readonly kind: 'preserve-equivalent'; readonly descriptor: GraphScopedSwmRecoveryDescriptor }
  | { readonly kind: 'already-replaced'; readonly descriptor: GraphScopedSwmRecoveryDescriptor };

/**
 * One per-KA recovery commit protocol for public graph/store and private lanes.
 * Transport acquisition supplies verified bytes; authority hooks preserve each
 * lane's admission policy. Ordering is reread after awaited acquisition before
 * preparing companions, replacing content, preserving aliases, and writing meta.
 */
export async function commitRecoveredSwmAsset(input: {
  contextGraphId: string;
  asset: SwmRecoveryCommitAsset;
  materializer: SharedMemorySnapshotMaterializer;
  insertMetadata: (rows: readonly Quad[]) => Promise<unknown>;
  ensureContextGraph?: () => Promise<void>;
  mutationAttribution?: Readonly<{ graphSource: string; metadataSource: string }>;
  resolveRootAtomicCompanion?: DurableRootAtomicCompanionResolver;
  assertCurrent?: () => void;
  allowed?: () => boolean;
}): Promise<SwmRecoveryCommitResult> {
  const { materializer, contextGraphId, asset } = input;
  const result = (kind: SwmRecoveryCommitResult['kind'], insertedGraphQuads = 0, insertedMetaQuads = 0): SwmRecoveryCommitResult => ({ kind, insertedGraphQuads, insertedMetaQuads, withholdRows: asset.descriptor.metadataQuads });
  if (asset.kind === 'already-replaced') return result('committed');
  return materializer.withKaWriteLock(contextGraphId, asset.descriptor.subGraphName, asset.descriptor.kaUal, async () => {
    const authorityAllows = () => { input.assertCurrent?.(); return input.allowed?.() !== false; };
    if (!authorityAllows()) return result('deferred');
    const descriptor = await materializer.prepareRecoveredDescriptor(asset.descriptor);
    let equivalent = await materializer.isGraphAssetMaterialized(descriptor);
    if (!authorityAllows()) return result('deferred');
    if (!await materializer.draftMayReplace(contextGraphId, descriptor, equivalent)) return result('superseded');
    let quads: readonly Quad[] | null = null;
    if (equivalent && descriptor.subGraphName === undefined && input.resolveRootAtomicCompanion) {
      quads = await materializer.readExactMaterializedGraph(descriptor);
      if (quads === null) throw new Error(`stored root recovery asset ${descriptor.kaUal} changed before boundary commit`);
    } else if (!equivalent) {
      if (asset.kind === 'preserve-equivalent') throw new Error(`stored recovery asset ${descriptor.kaUal} changed before equivalent commit`);
      quads = await asset.loadVerifiedQuads();
      await input.ensureContextGraph?.();
    }
    // Snapshot/context reads can yield to authority revocation or a coherent
    // chain proof changing. Recheck immediately before any durable effect.
    if (!authorityAllows()) return result('deferred');
    equivalent = await materializer.isGraphAssetMaterialized(descriptor);
    if (!await materializer.draftMayReplace(contextGraphId, descriptor, equivalent)) return result('superseded');
    if (!authorityAllows()) return result('deferred');
    const companion = descriptor.subGraphName === undefined ? input.resolveRootAtomicCompanion?.(Object.freeze({ contextGraphId, kaUal: descriptor.kaUal, assertionVersion: descriptor.assertionVersion, shareOperationId: descriptor.shareOperationId })) : undefined;
    if (quads !== null) {
      if (companion) await materializer.replaceGraphWithAtomicCompanion(descriptor.assertionGraph, [...quads], companion, input.mutationAttribution ? { source: input.mutationAttribution.graphSource } : undefined);
      else if (!equivalent) await materializer.replaceGraph(descriptor.assertionGraph, [...quads], input.mutationAttribution ? { source: input.mutationAttribution.graphSource } : undefined);
    }
    const stored = descriptor.storedHead;
    const selected = await materializer.selectRepairIdentity(contextGraphId, descriptor);
    // Equivalent healthy aliases are a normal resolved state. Keep the whole
    // class, including queued ACK identities; no head/operation repair is owed.
    if (selected && stored.status === 'resolved') {
      const history = healthyRecoveredAliasRows(contextGraphId, descriptor)!;
      if (history.length > 0) await input.insertMetadata(history);
      const providerKeys = new Set(asset.descriptor.metadataQuads.map(canonicalQuadKey));
      return result('committed', equivalent ? 0 : quads?.length ?? 0, history.filter(row => providerKeys.has(canonicalQuadKey(row))).length);
    }
    let withheld: readonly Quad[] = [];
    if (selected) {
      await materializer.repairHeadPreservingIdentity(contextGraphId, descriptor, selected.winnerShareOperationId);
      withheld = selected.withholdRows;
    } else {
      await materializer.replaceHeadMetadata(contextGraphId, descriptor, input.mutationAttribution ? { source: input.mutationAttribution.metadataSource } : undefined);
    }
    const keys = new Set(withheld.map(canonicalQuadKey));
    const rows = descriptor.metadataQuads.filter(row => !keys.has(canonicalQuadKey(row)));
    if (rows.length > 0) await input.insertMetadata(rows);
    return result('committed', equivalent ? 0 : quads?.length ?? 0, rows.length);
  });
}
