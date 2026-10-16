import { commitConfirmedDurableShareInventory } from './durable-vm-share-inventory.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../../rfc64/swm-inventory-shadow-runtime-v1.js';
import { SwmInventoryWriteFailure, SwmCatalogAuthorityNotReady, type SwmInventoryWriteOutcome } from '../swm-inventory-write.js';
import type { ContextGraphIdV1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import { createPromoteRetryableFailure, runPromoteCommittedFinalization } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../../dkg-agent.js';
import type { AfterDurableSwmPromotionParamsV1 } from '../../dkg-agent-rfc64-catalog-auto-publish.js';

/** Queue completion transfers ownership to durable inventory, not a detached callback. */
export async function commitDurableShareInventory(agent: DKGAgent, params: AfterDurableSwmPromotionParamsV1): Promise<void> {
  // The strict seal resolver enforces coordinate author == seal/UAL author.
  // Use the same asset and author-lane boundary as confirmed VM removal.
  const result = await rfc64SwmInventoryShadowRuntimeV1(agent).runInventoryWriteExclusive({
    contextGraphId: params.contextGraphId, subGraphName: params.subGraphName,
    authorAddress: params.lifecycleAgentAddress, assertionCoordinate: params.assertionCoordinate,
  }, () => commitInventoryUnderAssetLock(agent, params));
  if (result === 'vm-confirmed') await commitConfirmedDurableShareInventory(agent, params);
}

async function commitInventoryUnderAssetLock(agent: DKGAgent, params: AfterDurableSwmPromotionParamsV1): Promise<'vm-confirmed' | undefined> {
  if (!params.shareOperationId) throw new Error('A durable SWM handoff requires the original operation ID');
  let result: SwmInventoryWriteOutcome;
  try { result = await agent.commitRfc64SwmAuthorInventoryV1({ ...params, shareOperationId: params.shareOperationId }); }
  catch (error) {
    if (!(error instanceof SwmInventoryWriteFailure)) throw error;
    if (error.phase === 'authority' && error.cause instanceof SwmCatalogAuthorityNotReady) {
      throw createPromoteRetryableFailure(error.cause);
    }
    // Only the replay-safe inventory CAS is a committed finalization boundary.
    // Authority and preparation-read errors retain their original classification.
    if (error.phase === 'inventory-commit') await runPromoteCommittedFinalization(async () => { throw error.cause; });
    throw error.cause;
  }
  if (result.status === 'dormant' && result.dormantReason === 'policy-mismatch') {
    throw Object.assign(new Error('Catalog policy no longer matches the admitted share'),
      { code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
  }
  // Confirmed public VM content is intentionally no longer in the SWM inventory.
  // Verify the confirmation transfer; a prior observer may have failed to store its owner.
  if (result.status === 'dormant' && result.dormantReason === 'vm-confirmed') return 'vm-confirmed';
  if (result.status !== 'applied' && result.status !== 'existing') {
    throw createPromoteRetryableFailure(new Error(`Durable share inventory remains pending: ${result.dormantReason ?? result.status}`));
  }
  agent.requestRfc64SwmCatalogProjectionV1({
    contextGraphId: params.contextGraphId as ContextGraphIdV1,
    authorAddress: params.lifecycleAgentAddress.toLowerCase() as EvmAddressV1,
    ctx: params.ctx,
  });
}

export async function finishDurableShare(
  agent: DKGAgent, params: AfterDurableSwmPromotionParamsV1,
  stamp: () => Promise<void>, schedule: () => void,
): Promise<void> {
  try { await runPromoteCommittedFinalization(stamp); }
  finally { if (params.shareOperationId !== null && !params.durableInventory) schedule(); }
  if (params.durableInventory) await commitDurableShareInventory(agent, params);
}
