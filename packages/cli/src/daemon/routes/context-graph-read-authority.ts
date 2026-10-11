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

/**
 * Read-authority reasons that answer "may this NODE read the context graph?"
 * rather than "may this AGENT read it?".
 *
 * `resolveContextGraphReadAuthorityDecision` only consults `callerAgentAddress`
 * on its chain-registered, RFC-64 and agent-gated-local branches. Everything
 * below falls through to node-scoped facts (peer allowlist, local subscription,
 * the node's own default agent), so an agent-scoped caller must NOT inherit
 * them — doing so is the cross-CG read hole `/api/memory/search` is gated for.
 */
const NODE_SCOPED_READ_AUTHORITY_REASONS: ReadonlySet<string> = new Set([
  'legacy-peer-allowlist',
  'legacy-peer-invitation',
  'legacy-local-agent-participant',
  'legacy-local-identity-participant',
  'legacy-subscription',
  'legacy-edge-subscription',
]);

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
    // Legacy node membership and subscriptions cannot authorize a bearer agent.
    if (authority.outcome !== 'allowed' || (
      actor.authenticatedAgentAddress !== undefined
      && NODE_SCOPED_READ_AUTHORITY_REASONS.has(authority.reason)
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
