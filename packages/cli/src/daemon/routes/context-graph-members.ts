import { validateContextGraphId } from '@origintrail-official/dkg-core';
import { jsonResponse } from '../http-utils.js';
import { requireContextGraphReadAuthority } from './context-graph-read-authority.js';
import type { RequestContext } from './context.js';

/** GET /api/context-graph/{id}/members: the local membership cache, behind the shared context-graph read gate. */
export async function handleContextGraphMembers(ctx: RequestContext): Promise<boolean> {
  const match = ctx.req.method === 'GET' ? ctx.path.match(/^\/api\/context-graph\/([^/]+)\/members$/) : null;
  if (!match) return false;
  const contextGraphId = decodeURIComponent(match[1]);
  if (!validateContextGraphId(contextGraphId).valid) {
    jsonResponse(ctx.res, 400, { error: 'Invalid context graph id' });
    return true;
  }
  if (!(await requireContextGraphReadAuthority(ctx, contextGraphId))) return true;
  jsonResponse(ctx.res, 200, { contextGraphId, members: ctx.dashDb.listContextGraphMembers(contextGraphId) });
  return true;
}
