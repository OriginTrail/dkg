import { canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1,
  contextGraphAssertionUri, type ContextGraphIdV1 } from '@origintrail-official/dkg-core';
import { createPromoteRetryableFailure, runPromoteCommittedFinalization } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../../dkg-agent.js';
import type { AfterDurableSwmPromotionParamsV1 } from '../../dkg-agent-rfc64-catalog-auto-publish.js';
import { resolveDurableGraphScopedAuthorSealCandidateV1 } from '../../durable-author-seal-resolver-v1.js';
import { SwmCatalogAuthorityNotReady, SwmInventoryWriteFailure } from '../swm-inventory-write.js';

/** The publisher verified VM content, or inventory observed the exact confirmation fence. */
export async function commitConfirmedDurableShareInventory(agent: DKGAgent, params: AfterDurableSwmPromotionParamsV1): Promise<void> {
  const binding = params.recoveryBinding;
  if (!binding?.inventoryRequired || params.shareOperationId !== binding.intent.operationId) {
    throw Object.assign(new Error('Confirmed share lacks its original inventory obligation'), { code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
  }
  const candidate = await resolveDurableGraphScopedAuthorSealCandidateV1({
    store: agent.store, contextGraphId: params.contextGraphId as ContextGraphIdV1,
    agentAddress: params.lifecycleAgentAddress, assertionCoordinate: params.assertionCoordinate,
    subGraphName: params.subGraphName ?? undefined, source: 'agent.durableShare.confirmedSeal',
  });
  if (!candidate || computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(candidate.seal)) !== binding.sealDigest) {
    throw Object.assign(new Error('Confirmed share seal differs from its durable binding'), { code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
  }
  let owned: boolean;
  try {
    owned = await agent.observeRfc64ConfirmedVmV1({
      contextGraphId: params.contextGraphId, subGraphName: params.subGraphName,
      assertionCoordinate: params.assertionCoordinate, shareOperationId: binding.intent.operationId,
      seal: candidate.seal, assertionUri: contextGraphAssertionUri(params.contextGraphId, params.lifecycleAgentAddress, params.assertionCoordinate, params.subGraphName ?? undefined),
      ctx: params.ctx, publicationLabel: 'queued publish', requireDurableOwnership: true,
      expectedWorkspaceAccessPolicy: binding.intent.accessPolicy,
    });
  } catch (error) {
    const cause = error instanceof SwmInventoryWriteFailure ? error.cause : error;
    if (cause instanceof SwmCatalogAuthorityNotReady) throw createPromoteRetryableFailure(cause);
    if (error instanceof SwmInventoryWriteFailure && error.phase === 'inventory-commit') {
      await runPromoteCommittedFinalization(async () => { throw cause; });
    }
    throw cause;
  }
  if (!owned) throw createPromoteRetryableFailure(new Error('Confirmed share catalog ownership remains pending'));
}
