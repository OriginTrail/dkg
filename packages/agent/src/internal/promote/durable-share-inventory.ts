import type { ContextGraphIdV1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import { createPromoteRetryableFailure, runPromoteCommittedFinalization } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../../dkg-agent.js';
import type { AfterDurableSwmPromotionParamsV1 } from '../../dkg-agent-rfc64-catalog-auto-publish.js';

/** Queue completion transfers ownership to durable inventory, not a detached callback. */
export async function commitDurableShareInventory(agent: DKGAgent, params: AfterDurableSwmPromotionParamsV1): Promise<void> {
  if (!params.shareOperationId) throw new Error('A durable SWM handoff requires the original operation ID');
  const result = await agent.recordRfc64SwmAuthorInventoryShadowV1({
    ...params, shareOperationId: params.shareOperationId, throwOnFailure: true,
  });
  if (result.status === 'dormant' && result.dormantReason === 'policy-mismatch') {
    throw Object.assign(new Error('Catalog policy no longer matches the admitted share'),
      { code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
  }
  // Confirmed public VM content is intentionally no longer in the SWM inventory.
  // Private finalized inventory has its own durable confirmation owner.
  if (result.status === 'dormant' && result.dormantReason === 'vm-confirmed') return;
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
