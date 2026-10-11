// SPDX-License-Identifier: Apache-2.0
import {
  CONTEXT_GRAPH_AUTHORITY_RPC_SITES,
  withRpcUsageSite,
  type ContextGraphAuthorityRpcSite,
} from '@origintrail-official/dkg-chain';
import { admitContextGraphReadCaller, type ContextGraphCallerReadAdmission } from '@origintrail-official/dkg-agent/dist/context-graph-read-authority.js';
import { resolveKnowledgeAssetRead, type KnowledgeAssetReadInput, type KnowledgeAssetReadTarget } from '@origintrail-official/dkg-agent/dist/knowledge-asset-read-resolution.js';
import {
  jsonResponse,
  respondContextGraphReadAuthorityUnavailable,
  validateRequiredContextGraphId,
} from '../http-utils.js';
import {
  createStoreQueryRequestLifecycle,
  isApiQueryCallerDisconnected,
} from '../store-query-lifecycle.js';
import { actorFromRequestContext, type RequestContext } from './context.js';

/** Operator read access preserves disabled anonymous clients without widening accepted agents. */
export function hasNodeOperatorReadAccess(ctx: RequestContext): boolean {
  const { authentication } = actorFromRequestContext(ctx);
  return authentication.principal.kind === 'nodeOperator'
    || (authentication.mode === 'disabled' && authentication.principal.kind === 'anonymous');
}

/** One caller-bound authority gate for daemon reads outside the scoped query engine. */
export async function requireContextGraphReadAuthority(
  ctx: RequestContext,
  contextGraphId: unknown,
  site: ContextGraphAuthorityRpcSite = CONTEXT_GRAPH_AUTHORITY_RPC_SITES.query,
): Promise<boolean> {
  return (await requireReadAuthority(ctx, contextGraphId, site, async (id, callerAgentAddress, signal) => ({
    ...admitContextGraphReadCaller(await ctx.agent.resolveContextGraphReadAuthority(id, { callerAgentAddress, signal }), callerAgentAddress),
    value: true,
  }), async () => true)) !== null;
}

/** The KA owner returns both its caller-bound decision and resolved resource. */
export async function requireKnowledgeAssetRead(
  ctx: RequestContext,
  input: KnowledgeAssetReadInput,
): Promise<KnowledgeAssetReadTarget | null> {
  return requireReadAuthority(ctx, input.cg, CONTEXT_GRAPH_AUTHORITY_RPC_SITES.query, async (cg, callerAgentAddress, signal) => {
    const resolution = await resolveKnowledgeAssetRead(ctx.agent, { ...input, cg }, { callerAgentAddress, signal });
    return { ...resolution, value: resolution.target };
  }, async () => (await resolveKnowledgeAssetRead(ctx.agent, input, { nodeOperator: true,
    callerAgentAddress: actorFromRequestContext(ctx).authenticatedAgentAddress,
  })).target);
}

async function requireReadAuthority<T>(
  ctx: RequestContext,
  contextGraphId: unknown,
  site: ContextGraphAuthorityRpcSite,
  resolveAuthority: (id: string, caller: string | undefined, signal: AbortSignal) => Promise<ContextGraphCallerReadAdmission & { value: T }>,
  operatorValue: () => Promise<T>,
): Promise<T | null> {
  if (!validateRequiredContextGraphId(contextGraphId, ctx.res)) return null;
  const validatedId = contextGraphId as string;
  const actor = actorFromRequestContext(ctx);
  if (hasNodeOperatorReadAccess(ctx)) return operatorValue();
  const lifecycle = createStoreQueryRequestLifecycle(ctx.req, ctx.res, 'api.context_graph.read_authority');
  try {
    lifecycle.signal.throwIfAborted();
    const resolution = await withRpcUsageSite(site, () => resolveAuthority(
      validatedId, actor.authenticatedAgentAddress, lifecycle.signal,
    ));
    lifecycle.signal.throwIfAborted();
    // Unavailable authority is retryable, not a terminal caller refusal. The
    // canonical response hides the CG, authority source and internal reason.
    if (resolution.outcome === 'unavailable') {
      respondContextGraphReadAuthorityUnavailable(ctx.res, resolution.decision);
      return null;
    }
    if (resolution.outcome === 'refused') {
      jsonResponse(ctx.res, 403, { error: 'Not authorized to read this context graph.' });
      return null;
    }
    return resolution.value;
  } catch (error) {
    if (!lifecycle.signal.aborted && !isApiQueryCallerDisconnected(error)) throw error;
    if (!ctx.res.writableEnded) ctx.res.end();
    return null;
  } finally {
    lifecycle.dispose();
  }
}
