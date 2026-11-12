// SPDX-License-Identifier: Apache-2.0
import { readableViewSemanticsDeltaReport } from '@origintrail-official/dkg-agent';
import { authenticatedAgentAddress, canAdministerNode } from '../../auth.js';
import { jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

export const VIEW_SEMANTICS_DELTA_PATH = '/api/query/view-semantics-delta';

/**
 * Node-admin report of sampled view queries: per context graph, how often the answer
 * with `semantics: "merged"` would differ from the per-asset answer, and the query
 * shapes involved. It holds shapes, never values, and only context graphs the caller
 * may read. `?contextGraphId=` narrows it to one.
 */
export async function handleViewSemanticsRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, url, agent, authentication } = ctx;
  if (req.method !== 'GET' || path !== VIEW_SEMANTICS_DELTA_PATH) return;
  if (!canAdministerNode(authentication)) {
    return jsonResponse(res, 403, { error: `GET ${VIEW_SEMANTICS_DELTA_PATH} requires a node-level admin token (~/.dkg/auth.token).` });
  }
  const contextGraphId = url.searchParams.get('contextGraphId') || undefined;
  const contextGraphs = await readableViewSemanticsDeltaReport(agent, {
    contextGraphId, callerAgentAddress: authenticatedAgentAddress(authentication),
  });
  return jsonResponse(res, 200, { contextGraphs });
}
