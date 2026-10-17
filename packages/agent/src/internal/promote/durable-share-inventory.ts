import { throwInventoryRecoveryFailure } from './inventory-recovery-failure.js';
import { commitConfirmedDurableShareInventory } from './durable-vm-share-inventory.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../../rfc64/swm-inventory-shadow-runtime-v1.js';
import { type SwmInventoryWriteOutcome } from '../swm-inventory-write.js';
import type { ContextGraphIdV1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import { createPromoteRetryableFailure, runPromoteCommittedFinalization } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../../dkg-agent.js';
import type { AfterDurableSwmPromotionParamsV1, BoundDurableSwmPromotionParamsV1, ObserveRfc64DurableSwmPromotionParamsV1 } from '../../dkg-agent-rfc64-catalog-auto-publish.js';

/** Queue completion transfers ownership to durable inventory, not a detached callback. */
export async function commitDurableShareInventory(agent: DKGAgent, params: BoundDurableSwmPromotionParamsV1): Promise<void> {
  // The strict seal resolver enforces coordinate author == seal/UAL author.
  // Use the same asset and author-lane boundary as confirmed VM removal.
  const result = await rfc64SwmInventoryShadowRuntimeV1(agent).runInventoryWriteExclusive({
    contextGraphId: params.contextGraphId, subGraphName: params.subGraphName,
    authorAddress: params.lifecycleAgentAddress, assertionCoordinate: params.assertionCoordinate,
  }, () => commitInventoryUnderAssetLock(agent, params));
  if (result === 'vm-confirmed') await commitConfirmedDurableShareInventory(agent, params);
}

async function commitInventoryUnderAssetLock(agent: DKGAgent, params: BoundDurableSwmPromotionParamsV1): Promise<'vm-confirmed' | undefined> {
  let result: SwmInventoryWriteOutcome;
  try { result = await agent.commitRfc64SwmAuthorInventoryV1({ ...params, shareOperationId: params.recoveryBinding.intent.operationId }); }
  catch (error) { return throwInventoryRecoveryFailure(error); }
  if (result.status === 'dormant') {
    const reason = result.dormantReason;
    switch (reason) {
      case 'policy-mismatch':
        throw Object.assign(new Error('Catalog policy no longer matches the admitted share'),
          { code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
      // A confirmation must transfer ownership before the share can complete.
      case 'vm-confirmed': return 'vm-confirmed';
      case 'inactive-lane':
      case 'authority-transition':
        throw createPromoteRetryableFailure(new Error(`Durable share inventory remains pending: ${reason}`));
      default: { const unreachable: never = reason; throw new Error(`Unknown inventory outcome: ${unreachable}`); }
    }
  }
  agent.requestRfc64SwmCatalogProjectionV1({
    contextGraphId: params.contextGraphId as ContextGraphIdV1,
    authorAddress: params.lifecycleAgentAddress.toLowerCase() as EvmAddressV1,
    ctx: params.ctx,
  });
}

export async function finishDurableShare(
  agent: DKGAgent, params: AfterDurableSwmPromotionParamsV1,
  stamp: () => Promise<void>, schedule: (observation: ObserveRfc64DurableSwmPromotionParamsV1) => void,
): Promise<void> {
  try { await runPromoteCommittedFinalization(stamp); }
  finally {
    const shareOperationId = params.recoveryBinding ? params.recoveryBinding.intent.operationId : params.shareOperationId;
    if (shareOperationId !== null && !params.recoveryBinding?.inventoryRequired) schedule({ ...params, shareOperationId });
  }
  if (params.recoveryBinding && params.recoveryBinding.inventoryRequired) await commitDurableShareInventory(agent, params);
}
