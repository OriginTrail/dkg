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
  if (!validateRequiredContextGraphId(contextGraphId, ctx.res)) return false;
  const validatedId = contextGraphId as string;
  const actor = actorFromRequestContext(ctx);
  if (actor.authentication.principal.kind === 'nodeOperator') return true;
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
    // The resolver owns whether evidence grants this caller, the public, or only the node.
    if (authority.outcome !== 'allowed' || (
      actor.authenticatedAgentAddress !== undefined
      && authority.grantScope !== 'caller' && authority.grantScope !== 'public'
    )) {
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
