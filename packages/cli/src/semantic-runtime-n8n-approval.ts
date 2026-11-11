import { computeEffectRequestDigest, type RuntimeAdapterOperation, type SemanticN8nGrant } from '@origintrail-official/dkg-semantic-runtime';
import { assertN8nValue } from './semantic-runtime-n8n-contract.js';
import type { EffectApprovalPolicy } from './semantic-runtime-types.js';
import { hashParts } from './semantic-runtime-values.js';

/** Materialize the owner's schema-bounded grant as the same durable per-effect approval. */
export function n8nEffectApproval(grant: SemanticN8nGrant, bindingDigest: string,
  effectClass: RuntimeAdapterOperation['effectClass']): EffectApprovalPolicy {
  return (proposal, store) => {
    assertN8nValue(grant.inputSchema, proposal.normalizedInput, 'INPUT');
    const approvalId = `urn:sr:approval:n8n:${hashParts([bindingDigest, proposal.effectId])}`;
    if (!store.approval(approvalId)) store.putApproval({
      approvalId, executionId: proposal.executionId, effectClass, principal: proposal.principal,
      requestDigest: computeEffectRequestDigest(proposal.adapterId, proposal.adapterVersion, proposal.verb, proposal.resource, proposal.normalizedInput),
      notBefore: Date.now() - 1000, expiresAt: store.capability(proposal.capabilityId)!.expiresAt,
      oneShot: true, consumedAt: null,
    });
    return approvalId;
  };
}
