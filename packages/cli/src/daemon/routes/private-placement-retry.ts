import { actorFromRequestContext } from './context.js';
import { requireNodeAdmin } from '../node-admin-guard.js';
import { jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

/** Explicit operator retry changes scheduling only; no marker, receipt or authority is replaced. */
export async function handlePrivatePlacementRetry(ctx: RequestContext): Promise<boolean> {
  if (ctx.req.method !== 'POST' || ctx.path !== '/api/rfc64/private-placement/retry-failed') return false;
  if (!requireNodeAdmin(actorFromRequestContext(ctx).authentication, ctx.res,
    'POST /api/rfc64/private-placement/retry-failed', 'retry private catalog repairs')) return true;
  try {
    const requested = ctx.agent.retryRfc64FailedPrivatePlacementsV1();
    jsonResponse(ctx.res, 202, { requested });
  } catch {
    jsonResponse(ctx.res, 503, { code: 'PRIVATE_PLACEMENT_RETRY_UNAVAILABLE',
      error: 'Private placement retry scheduling is unavailable; owed work is retained.' });
  }
  return true;
}
