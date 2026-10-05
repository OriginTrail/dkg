import type { RequestContext } from './context.js';
import { jsonResponse, sanitizeRpcMessage } from '../http-utils.js';
import { diagnosticPromoteStage } from '../promote-stage-diagnostics.js';

export interface PromoteRecoveryContext {
  contextGraphId: string;
  name: string;
  phase: string;
  subGraphName?: string;
}

/** Seconds a client waits before repeating a share whose prerequisite was unavailable. */
const PROMOTE_PREREQUISITE_RETRY_AFTER_SECONDS = '1';

const ATTRIBUTION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A closed-set identity such as an error code or reason; anything else is dropped. */
function attributionToken(source: unknown, field: string): string | undefined {
  if ((typeof source !== 'object' && typeof source !== 'function') || source === null) return undefined;
  try {
    const value: unknown = Reflect.get(source, field);
    return typeof value === 'string' && ATTRIBUTION_TOKEN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
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
  if (e?.code === 'PROMOTE_RETRYABLE_FAILURE') {
    // A prerequisite of the share could not be read just now. The same share is
    // safe to repeat and nothing is lost, but it is not a clean no-op: the draft
    // is already sealed, and a share interrupted later than its prerequisites
    // keeps its operation id. So the answer names the asset to resume instead of
    // reporting that nothing started. Which prerequisite it was goes to the
    // daemon log as closed-set tokens; the wrapped cause's own message can quote
    // a raw dependency error and stays out of both the log and the response.
    const cause: unknown = e.cause;
    const causeCode = attributionToken(cause, 'code');
    const causeReason = attributionToken(cause, 'reason');
    process.stderr.write(`[DKG-Daemon] ${JSON.stringify({
      event: 'knowledge_asset_share_prerequisite_unavailable',
      code: e.code,
      step: diagnosticPromoteStage(typeof e.message === 'string' ? e.message : ''),
      ...(causeCode ? { causeCode } : {}),
      ...(causeReason ? { causeReason } : {}),
      ...context,
    })}\n`);
    jsonResponse(
      res,
      503,
      { ...promoteRecoveryResponseBody(e, context), retryable: true },
      undefined,
      { 'Retry-After': PROMOTE_PREREQUISITE_RETRY_AFTER_SECONDS },
    );
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

