// SPDX-License-Identifier: Apache-2.0
import { isPromoteRetirementApproval } from '@origintrail-official/dkg-publisher';
import { isExplicitNodeOperator } from '../../auth.js';
import { jsonResponse, readBody, safeParseJson } from '../http-utils.js';
import type { RequestContext } from './context.js';

export async function handleShareRetirement(ctx: RequestContext, jobId: string): Promise<void> {
  const { req, res, authentication } = ctx;
  if (!isExplicitNodeOperator(authentication)) return jsonResponse(res, 403, { error: 'An explicit node operator is required' });
  if (ctx.url.search) return jsonResponse(res, 400, { error: 'Unexpected retirement query parameters' });
  let approval;
  if (req.method === 'POST') {
    const body = safeParseJson(await readBody(req, 1024), res);
    if (!body) return;
    if (!isPromoteRetirementApproval(body)) return jsonResponse(res, 400, { error: 'Expected an exact job digest and acknowledgment of unknown effects' });
    approval = body;
  }
  const result = await ctx.agent.promoteQueue.retireFailedJob(jobId, approval);
  const status = result.outcome === 'not_found' ? 404 : result.outcome === 'unsupported' ? 501
    : result.outcome === 'ineligible' || result.outcome === 'stale' ? 409 : 200;
  jsonResponse(res, status, result);
}
