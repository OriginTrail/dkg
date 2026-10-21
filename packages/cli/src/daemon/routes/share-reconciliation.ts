import { validateShareReconciliationInput } from '@origintrail-official/dkg-publisher';
import { actorFromRequestContext, type RequestContext } from './context.js';
import { requireContextGraphReadAuthority } from './context-graph-read-authority.js';
import { jsonResponse, validateOptionalSubGraphName } from '../http-utils.js';

/** Read-only: independent of worker readiness, and never calls an admission path. */
export async function handleShareReconciliation(ctx: RequestContext): Promise<void> {
  const actor = actorFromRequestContext(ctx);
  const operator = actor.authentication.principal.kind === 'nodeOperator';
  if (!operator && !actor.authenticatedAgentAddress) {
    return jsonResponse(ctx.res, 403, { error: 'Authenticated share reconciliation is required.' });
  }
  const fields = ['contextGraphId', 'assertionName', 'agentAddress', 'authorAddress', 'subGraphName',
    'entities', 'kaUal', 'assertionVersion', 'merkleRoot', 'shareOperationId'];
  const raw: Record<string, unknown> = {};
  let input;
  try {
    for (const [key, value] of ctx.url.searchParams) {
      if (!fields.includes(key) || key in raw) throw new Error('Invalid or duplicate reconciliation parameter');
      raw[key] = key === 'entities' && value !== 'all' ? JSON.parse(value) : value;
    }
    input = validateShareReconciliationInput(raw);
  } catch {
    return jsonResponse(ctx.res, 400, { error: 'A complete, valid exact share identity is required.' });
  }
  if (!validateOptionalSubGraphName(input.subGraphName, ctx.res)) return;
  if (!operator && input.agentAddress !== actor.authenticatedAgentAddress?.toLowerCase()) {
    return jsonResponse(ctx.res, 403, { error: 'Not authorized to reconcile this storage lane.' });
  }
  if (!await requireContextGraphReadAuthority(ctx, input.contextGraphId)) return;
  const result = await ctx.agent.assertion.reconcileShare(input);
  return jsonResponse(ctx.res, result.outcome === 'unproven' && result.reason === 'unavailable' ? 503 : 200, result);
}
