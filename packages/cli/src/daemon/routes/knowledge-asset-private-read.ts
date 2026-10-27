import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import type { KnowledgeAssetReadTarget } from '@origintrail-official/dkg-agent/dist/knowledge-asset-read-resolution.js';
import { jsonResponse } from '../http-utils.js';
import { actorFromRequestContext, type RequestContext } from './context.js';
import { respondAssertionError } from './knowledge-assets-error-mapping.js';

/** CG admission has already run. Private payload additionally requires the resolved owner. */
export async function readPrivateKnowledgeAssetPartition(
  ctx: RequestContext, target: KnowledgeAssetReadTarget, layer: 'wm' | 'vm',
): Promise<void> {
  const actor = actorFromRequestContext(ctx);
  const operator = actor.authentication.principal.kind === 'nodeOperator';
  const caller = actor.authenticatedAgentAddress;
  const descriptor = target.descriptor;
  const owner = descriptor?.agentAddress;
  if (!operator && (!caller || !owner || caller.toLowerCase() !== owner.toLowerCase())) {
    return jsonResponse(ctx.res, 403, { code: 'PRIVATE_KA_READ_FORBIDDEN', error: 'Private payload reads require the KA owner or node operator.' });
  }
  if (!descriptor || !owner) return jsonResponse(ctx.res, 404, { error: 'Knowledge asset not found.' });
  try {
    if (layer === 'wm') {
      const quads = await ctx.agent.assertion.queryPrivate(target.cg, target.name, {
        agentAddress: owner, subGraphName: target.subGraphName,
      });
      const sorted = [...quads].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return jsonResponse(ctx.res, 200, { quads: sorted, count: sorted.length, partition: 'private' });
    }
    const ual = descriptor.publishedUal ?? descriptor.reservedUal;
    if (!descriptor.vmCurrentAssertion || !ual) {
      return jsonResponse(ctx.res, 409, { code: 'PRIVATE_KA_NOT_CONFIRMED', error: 'Knowledge asset has no confirmed VM assertion.' });
    }
    // A resolved alias or conflicting local descriptor must never redirect an owner read.
    if (createGraphKnowledgeAssetScope(ual, '1').agentAddress !== owner.toLowerCase()) {
      return jsonResponse(ctx.res, 409, { code: 'PRIVATE_KA_OWNER_MISMATCH', error: 'KA identity and owner disagree.' });
    }
    const result = await ctx.agent.assertion.queryPrivateVm(target.cg, ual, { subGraphName: target.subGraphName });
    if (result.merkleRoot.slice(2).toLowerCase() !== descriptor.vmCurrentAssertion.replace(/^0x/i, '').toLowerCase()) {
      return jsonResponse(ctx.res, 409, { code: 'PRIVATE_KA_VERSION_MOVED', error: 'Confirmed KA version changed; retry the read.' });
    }
    return jsonResponse(ctx.res, 200, { ...result, partition: 'private' });
  } catch (error) {
    if (typeof (error as { code?: unknown })?.code === 'string'
      && (error as { code: string }).code.startsWith('PRIVATE_KA_')) {
      return jsonResponse(ctx.res, 409, { code: (error as { code: string }).code, error: 'Exact private KA readback is unavailable.' });
    }
    return respondAssertionError(ctx.res, error, {
      contextGraphId: target.cg, name: target.name, subGraphName: target.subGraphName, phase: 'private-quads',
    });
  }
}
