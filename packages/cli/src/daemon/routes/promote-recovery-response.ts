import type { RequestContext } from './context.js';
import { jsonResponse, sanitizeRpcMessage } from '../http-utils.js';

export interface PromoteRecoveryContext {
  contextGraphId: string;
  name: string;
  phase: string;
  subGraphName?: string;
}

function promoteRecoveryResponseBody(e: any, context?: PromoteRecoveryContext) {
  return {
    code: e.code,
    error: sanitizeRpcMessage(e.message ?? String(e)),
    retryAction: 'resume_existing_knowledge_asset',
    retryPhase: 'swm-share',
    ...(context ? {
      contextGraphId: context.contextGraphId,
      retryKnowledgeAssetName: context.name,
      ...(context.subGraphName ? { subGraphName: context.subGraphName } : {}),
    } : {}),
  };
}

export function respondPromoteRecoveryError(
  res: RequestContext["res"],
  e: any,
  context?: PromoteRecoveryContext,
): boolean {
  if (e?.code === 'PROMOTE_POST_COMMIT_FAILURE') {
    jsonResponse(res, 503, { ...promoteRecoveryResponseBody(e, context), retryable: true });
    return true;
  }
  if (e?.code !== 'KA_PROMOTE_RECOVERY_REQUIRED') return false;
  process.stderr.write(`[DKG-Daemon] ${JSON.stringify({
    event: 'knowledge_asset_recovery_required',
    code: e.code,
    ...context,
  })}\n`);
  jsonResponse(res, 409, promoteRecoveryResponseBody(e, context));
  return true;
}

