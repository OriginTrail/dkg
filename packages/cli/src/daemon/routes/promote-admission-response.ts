import { PromoteAdmissionError, type PromoteJobConflictError } from '@origintrail-official/dkg-publisher';
import type { AssertionFailureResponse } from './assertion-failure-response.js';

/** Do not reinterpret an inner store outcome as evidence about job admission. */
export function classifyPromoteAdmissionError(error: unknown): AssertionFailureResponse | undefined {
  if (!(error instanceof PromoteAdmissionError)) return undefined;
  return {
    status: 503,
    headers: { 'Retry-After': '1' },
    body: {
      code: error.code,
      error: error.message,
      retryable: true,
      admissionScope: 'async_promote_job',
      admissionOutcome: error.admissionOutcome,
      phase: error.phase,
      ...(error.jobId ? {
        jobId: error.jobId,
        statusPath: `/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(error.jobId)}`,
      } : {}),
      recovery: error.admissionOutcome === 'indeterminate'
        ? 'Observe this job ID or replay the same selector; do not create a different operation. A missing status response does not prove non-admission.'
        : 'This attempt did not admit a job. Retry the same selector after pressure subsides.',
    },
  };
}

export function promoteConflictResponse(error: PromoteJobConflictError): Record<string, unknown> {
  return { error: error.message, existingJobId: error.existingJobId,
    ...(error.observedAdmission ? { observedAdmission: true } : {}) };
}
