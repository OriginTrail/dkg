import { inventoryHandoffPendingFailure, inventoryHandoffPendingReason, throwInventoryRecoveryFailure } from './inventory-recovery-failure.js';
import { rfc64SwmInventorySettlementCanConvergeV1 } from '../../rfc64/swm-inventory-settlement-outlook-v1.js';
import { commitConfirmedDurableShareInventory } from './durable-vm-share-inventory.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../../rfc64/swm-inventory-shadow-runtime-v1.js';
import { type SwmInventoryWriteOutcome } from '../swm-inventory-write.js';
import type { ContextGraphIdV1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import { runPromoteCommittedFinalization } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../../dkg-agent.js';
import type { AfterDurableSwmPromotionParamsV1, BoundDurableSwmPromotionParamsV1, ObserveRfc64DurableSwmPromotionParamsV1 } from '../../dkg-agent-rfc64-catalog-auto-publish.js';

/** Queue completion transfers ownership to durable inventory, not a detached callback. */
export async function commitDurableShareInventory(agent: DKGAgent, params: BoundDurableSwmPromotionParamsV1): Promise<void> {
  // The strict seal resolver enforces coordinate author == seal/UAL author.
  // Use the same asset and author-lane boundary as confirmed VM removal.
  const commit = () => rfc64SwmInventoryShadowRuntimeV1(agent).runInventoryWriteExclusive({
    contextGraphId: params.contextGraphId, subGraphName: params.subGraphName,
    authorAddress: params.lifecycleAgentAddress, assertionCoordinate: params.assertionCoordinate,
  }, () => commitInventoryUnderAssetLock(agent, params));
  let result: Awaited<ReturnType<typeof commit>>;
  try { result = await commit(); } catch (error) {
    // The second commit rechecks the lane under the asset lock, so a lane that is still
    // closed writes nothing and keeps the obligation pending.
    if (!await reopenedLaneAfterAdmission(agent, params.contextGraphId, error)) throw error;
    result = await commit();
  }
  if (result === 'vm-confirmed') await commitConfirmedDurableShareInventory(agent, params);
}

/**
 * A lane accepted at admission can close before the commit while responsibility or
 * authority is still settling. Outside the asset lock, one responsibility pass (the
 * detached observer's, without its delay ladder) says whether one more commit can apply.
 */
async function reopenedLaneAfterAdmission(agent: DKGAgent, contextGraphId: string, failure: unknown): Promise<boolean> {
  const reason = inventoryHandoffPendingReason(failure);
  if (reason !== 'inactive-lane' && reason !== 'authority-transition') return false;
  try {
    if (!rfc64SwmInventorySettlementCanConvergeV1(agent.rfc64CatalogAuthorityRefreshFailureReasonV1(contextGraphId))) return false;
    const selection = await agent.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
    return selection.active && selection.mode !== 'legacy';
  } catch { return false; }
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
        throw inventoryHandoffPendingFailure(reason, `Durable share inventory remains pending: ${reason}`);
      default: { const unreachable: never = reason; throw new Error(`Unknown inventory outcome: ${unreachable}`); }
    }
  }
  // A committed row still needs accepted projection admission before releasing its owner.
  try {
    const accepted = agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: params.contextGraphId as ContextGraphIdV1,
      authorAddress: params.lifecycleAgentAddress.toLowerCase() as EvmAddressV1,
      ctx: params.ctx,
    });
    if (!accepted) throw inventoryHandoffPendingFailure('projection-admission', 'Durable share catalog projection admission remains pending');
  } catch (error) { return throwInventoryRecoveryFailure(error); }
}

export async function finishDurableShare(
  agent: DKGAgent, params: AfterDurableSwmPromotionParamsV1,
  stamp: () => Promise<void>, schedule: (observation: ObserveRfc64DurableSwmPromotionParamsV1) => void,
): Promise<void> {
  let durableOwner = false;
  try {
    await runPromoteCommittedFinalization(stamp);
    if (params.recoveryBinding && !params.recoveryBinding.inventoryRequired) {
      // Persist before success, then let that one owner execute and retry the share.
      await runPromoteCommittedFinalization(async () => {
        durableOwner = await agent.recordRfc64OwedShareInventoryV1(params);
      });
    }
  } finally {
    const shareOperationId = params.recoveryBinding ? params.recoveryBinding.intent.operationId : params.shareOperationId;
    // Preserve best-effort recovery when stamping/recording failed or persistence is unavailable.
    if (!durableOwner && shareOperationId !== null && !params.recoveryBinding?.inventoryRequired) schedule({ ...params, shareOperationId });
  }
  if (params.recoveryBinding && params.recoveryBinding.inventoryRequired) await commitDurableShareInventory(agent, params);
}
