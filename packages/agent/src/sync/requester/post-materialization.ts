// SPDX-License-Identifier: Apache-2.0
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { FinalizedVmAssetCommitment } from './finalized-vm-asset-commitment.js';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';
import { reconcileFinalizedSwmTwin, reconcileFinalizedSwmTwinFromCommitment, type FinalizedSwmTwinRetirement } from './finalized-swm-twin-reconciliation.js';

/** Best-effort housekeeping after verified durable publication, shared by both transports. */
interface ReconciliationHost {
  store: Parameters<typeof reconcileFinalizedSwmTwinFromCommitment>[0]["store"];
  writeLocks: Parameters<typeof reconcileFinalizedSwmTwinFromCommitment>[0]["writeLocks"];
  retireFinalizedSwmTwinCandidate: (candidate: FinalizedSwmTwinRetirement, ctx: OperationContext) => Promise<void>;
  retireLegacySwmAfterVerifiedVmTwin: (params: { contextGraphId: string; kaUal: string; assertionVersion: bigint; subGraphName?: string }) => Promise<void>;
  invalidateListContextGraphsCache: () => void;
  log: { info: (ctx: OperationContext, message: string) => void; warn: (ctx: OperationContext, message: string) => void };
}

export function reconcileAfterMaterialization(agent: ReconciliationHost, asset: VerifiedGraphScopedAsset, ctx: OperationContext): Promise<void> {
  return reconcileVerifiedVm(agent, asset, ctx);
}

export function reconcileAfterHeldAsset(agent: ReconciliationHost, commitment: FinalizedVmAssetCommitment, ctx: OperationContext): Promise<void> {
  return reconcileVerifiedVm(agent, commitment, ctx);
}

async function reconcileVerifiedVm(agent: ReconciliationHost, asset: VerifiedGraphScopedAsset | FinalizedVmAssetCommitment, ctx: OperationContext): Promise<void> {
  agent.invalidateListContextGraphsCache();
  try {
    let retiredTwin: FinalizedSwmTwinRetirement | undefined;
    const cleanup = {
      store: agent.store,
      writeLocks: agent.writeLocks,
      retire: async (candidate: FinalizedSwmTwinRetirement) => {
        await agent.retireFinalizedSwmTwinCandidate(candidate, ctx);
        retiredTwin = candidate;
      },
    };
    const retirement = 'dataQuads' in asset
      ? await reconcileFinalizedSwmTwin({ ...cleanup, asset })
      : await reconcileFinalizedSwmTwinFromCommitment({ ...cleanup, commitment: asset });
    if (retirement === 'retired') {
      await agent.retireLegacySwmAfterVerifiedVmTwin({
        contextGraphId: asset.contextGraphId,
        kaUal: asset.ual,
        assertionVersion: asset.assertionVersion,
        // The marker of the namespace whose twin was verified and
        // retired. Without it a twin in a named subgraph would
        // retire the root marker of the same asset.
        subGraphName: retiredTwin?.subGraphName,
      });
      agent.invalidateListContextGraphsCache();
      agent.log.info(
        ctx,
        `Retired byte-identical SWM twin after durable VM materialization for ${asset.ual}`,
      );
    }
  } catch (cause) {
    // VM materialization is already durable and independently
    // verified. A best-effort tier cleanup must never turn that
    // success into a failed sync; the untouched SWM copy remains
    // safe and the next durable replay can reconcile it again.
    agent.log.warn(
      ctx,
      `Deferred SWM twin reconciliation for ${asset.ual}: `
      + `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
