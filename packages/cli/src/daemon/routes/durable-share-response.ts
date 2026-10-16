import { classifyAssertionError } from './knowledge-assets-error-mapping.js';
import { classifyStoreUnavailable, sanitizeRpcMessage } from '../http-utils.js';
import type { AssertionFailureResponse } from './assertion-failure-response.js';
import type { PromoteRecoveryContext } from './promote-recovery-response.js';

/** Only observation metadata is public; never expose the queue claim or binding. */
export function durableRecoveryDetails(error: any): Record<string, unknown> {
  return error?.recoveryJobId ? { recoveryJobId: error.recoveryJobId,
    recoveryState: error.recoveryState, recoveryStatusUrl: error.recoveryStatusUrl,
    ...(error.recoveryState === 'inspection-required' ? { retryable: false } : {}) } : {};
}

/** Decorate the existing classification once, at the synchronous share boundary. */
export function classifySynchronousShareFailure(error: any, context: PromoteRecoveryContext): AssertionFailureResponse {
  let failure: AssertionFailureResponse;
  if (error?.code === 'UNSEALED_SHARE_BLOCKED') {
    failure = { status: 409, body: { code: error.code, error: error.message, recovery: error.recovery } };
  } else if (error?.code === 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED') {
    failure = { status: 409, body: { code: error.code, error: error.message,
      namedGraphs: Array.isArray(error.namedGraphs) ? error.namedGraphs : undefined } };
  } else {
    failure = classifyAssertionError(error, context);
  }
  if (isDurableSharePending(error)) {
    failure = { ...failure, status: 503, headers: { ...failure.headers, 'Retry-After': '1' },
      body: { ...failure.body, code: failure.body.code ?? error.code ?? 'SHARE_RECOVERY_PENDING',
        error: sanitizeRpcMessage(String(failure.body.error ?? error.message)), retryable: true } };
  }
  return { ...failure, body: { ...failure.body, ...durableRecoveryDetails(error) } };
}

export function isDurableSharePending(error: any): boolean {
  return error?.code === 'SHARE_RECOVERY_UNAVAILABLE'
    || Boolean(error?.recoveryJobId && error.recoveryState !== 'inspection-required');
}

/** Store uncertainty keeps its existing 503 contract even when held for inspection. */
export function isDurableSharePartialUnavailable(error: any): boolean {
  return isDurableSharePending(error) || Boolean(error?.recoveryJobId && classifyStoreUnavailable(error));
}

export function partialDurableShareFailure(result: Record<string, unknown>, recovery: Record<string, unknown>, name: string) {
  return { created: true, ...result, ...recovery, partial: true,
    phase: 'swm-share', failedPhase: 'swm-share',
    retryAction: recovery.retryAction ?? 'retry_same_knowledge_asset', retryKnowledgeAssetName: name };
}
