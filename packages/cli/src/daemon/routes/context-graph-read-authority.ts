// SPDX-License-Identifier: Apache-2.0
import {
  CONTEXT_GRAPH_AUTHORITY_RPC_SITES,
  withRpcUsageSite,
  type ContextGraphAuthorityRpcSite,
} from '@origintrail-official/dkg-chain';
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
  return requireReadAuthority(ctx, contextGraphId, site);
}

/** A local curator proof authorizes only the caller's own draft inspection lane. */
export async function requireKnowledgeAssetDraftReadAuthority(
  ctx: RequestContext,
  contextGraphId: unknown,
  draftAgentAddress: string | undefined,
): Promise<boolean> {
  return requireReadAuthority(ctx, contextGraphId, CONTEXT_GRAPH_AUTHORITY_RPC_SITES.query, draftAgentAddress);
}

async function requireReadAuthority(
  ctx: RequestContext,
  contextGraphId: unknown,
  site: ContextGraphAuthorityRpcSite,
  draftAgentAddress?: string,
): Promise<boolean> {
  if (!validateRequiredContextGraphId(contextGraphId, ctx.res)) return false;
  const validatedId = contextGraphId as string;
  const actor = actorFromRequestContext(ctx);
  if (hasNodeOperatorReadAccess(ctx)) return true;
  const lifecycle = createStoreQueryRequestLifecycle(ctx.req, ctx.res, 'api.context_graph.read_authority');
  try {
    lifecycle.signal.throwIfAborted();
    const authority = await withRpcUsageSite(site, () => ctx.agent.resolveContextGraphReadAuthority(
      validatedId,
      { callerAgentAddress: actor.authenticatedAgentAddress, signal: lifecycle.signal },
    ));
    lifecycle.signal.throwIfAborted();
    // Unavailable authority is retryable, not a terminal caller refusal. The
    // canonical response hides the CG, authority source and internal reason.
    if (authority.outcome === 'unavailable') {
      respondContextGraphReadAuthorityUnavailable(ctx.res, authority);
      return false;
    }
    // A positive node grant does not let one bearer inherit another author's draft.
    // Canonical local-create/unregistered provenance and curator identity narrow that
    // grant to this caller's lane. Explicit refusals and unavailable evidence never fall back.
    let ownLocalDraft = false;
    const caller = actor.authenticatedAgentAddress;
    if (authority.outcome === 'allowed' && authority.source === 'legacy-local'
      && authority.grantScope === 'node' && caller !== undefined
      && draftAgentAddress?.toLowerCase() === caller.toLowerCase()
      && await ctx.agent.isLocalFirstUnregisteredContextGraph(validatedId)) {
      lifecycle.signal.throwIfAborted();
      const meta = await ctx.agent.getCgMeta(validatedId, { signal: lifecycle.signal });
      lifecycle.signal.throwIfAborted();
      const curator = await ctx.agent.getContextGraphCurator(validatedId, { signal: lifecycle.signal });
      ownLocalDraft = !meta.revokedAgents.some(address => address.toLowerCase() === caller.toLowerCase())
        && ctx.agent.curatorDidMatchesChecksumAgent(curator ?? undefined, caller);
      lifecycle.signal.throwIfAborted();
    }
    // The resolver owns whether evidence grants this caller, the public, or only the node.
    if (!ownLocalDraft && (authority.outcome !== 'allowed' || (
      actor.authenticatedAgentAddress !== undefined
      && authority.grantScope !== 'caller' && authority.grantScope !== 'public'
    ))) {
      jsonResponse(ctx.res, 403, { error: 'Not authorized to read this context graph.' });
      return false;
    }
    return true;
  } catch (error) {
    if (!lifecycle.signal.aborted && !isApiQueryCallerDisconnected(error)) throw error;
    if (!ctx.res.writableEnded) ctx.res.end();
    return false;
  } finally {
    lifecycle.dispose();
  }
}
