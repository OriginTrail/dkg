import { PromoteJobConflictError, PromoteAdmissionUncertainError } from '@origintrail-official/dkg-publisher';
import { classifyAssertionError } from './knowledge-assets-error-mapping.js';
import { classifyStoreUnavailable, sanitizeRpcMessage } from '../http-utils.js';
import type { AssertionFailureResponse } from './assertion-failure-response.js';
import type { PromoteRecoveryContext } from './promote-recovery-response.js';
import { DurableShareFailure } from './durable-share-failure.js';

/** Only observation metadata is public; never expose the queue claim or binding. */
export function durableRecoveryDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof DurableShareFailure) || error.observation.state === 'unavailable') return {};
  const { state, jobId } = error.observation;
  return { recoveryJobId: jobId, recoveryState: state,
    recoveryStatusUrl: `/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(jobId)}`,
    ...(state === 'inspection-required' || state === 'completed' ? { retryable: false } : {}) };
}

/** Classify the original domain cause once; add observation only at this HTTP boundary. */
export function classifySynchronousShareFailure(error: unknown, context: PromoteRecoveryContext): AssertionFailureResponse {
  const cause: any = error instanceof DurableShareFailure ? error.cause : error;
  let failure: AssertionFailureResponse;
  if (cause?.code === 'UNSEALED_SHARE_BLOCKED') {
    failure = { status: 409, body: { code: cause.code, error: cause.message, recovery: cause.recovery } };
  } else if (cause?.code === 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED') {
    failure = { status: 409, body: { code: cause.code, error: cause.message,
      namedGraphs: Array.isArray(cause.namedGraphs) ? cause.namedGraphs : undefined } };
  } else {
    failure = classifyAssertionError(cause, context);
  }
  if (error instanceof DurableShareFailure) {
    const state = error.observation.state;
    const code = cause instanceof PromoteAdmissionUncertainError ? 'SHARE_ADMISSION_UNCERTAIN'
      : cause instanceof PromoteJobConflictError ? 'SHARE_OWNER_CONFLICT' : undefined;
    const body: Record<string, unknown> = { ...failure.body, ...(code ? { code } : {}) };
    switch (state) {
      case 'pending': case 'admission-unconfirmed': case 'unobserved': case 'unavailable':
        failure = { status: 503, headers: { ...failure.headers, 'Retry-After': '1' },
          body: { ...body, code: body.code ?? (state === 'unavailable' ? 'SHARE_RECOVERY_UNAVAILABLE' : 'SHARE_RECOVERY_PENDING'),
            error: sanitizeRpcMessage(String(body.error ?? error.message)), retryable: true } };
        break;
      case 'inspection-required': case 'completed':
        failure = { ...failure, ...(cause instanceof PromoteJobConflictError ? { status: 409 } : {}), body };
        break;
      default: { const exhaustive: never = state; throw new Error(`Unknown recovery state: ${exhaustive}`); }
    }
  }
  return { ...failure, body: { ...failure.body, ...durableRecoveryDetails(error) } };
}

export function isDurableSharePending(error: unknown): boolean {
  return error instanceof DurableShareFailure && ['pending', 'admission-unconfirmed', 'unobserved', 'unavailable'].includes(error.observation.state);
}

/** Store uncertainty keeps its existing 503 contract even when held for inspection. */
export function isDurableSharePartialUnavailable(error: unknown): boolean {
  return isDurableSharePending(error) || (error instanceof DurableShareFailure && Boolean(classifyStoreUnavailable(error.cause)));
}

export function partialDurableShareFailure(result: Record<string, unknown>, recovery: Record<string, unknown>, name: string) {
  return { created: true, ...result, ...recovery, partial: true,
    phase: 'swm-share', failedPhase: 'swm-share',
    retryAction: recovery.retryAction ?? 'retry_same_knowledge_asset', retryKnowledgeAssetName: name };
}
