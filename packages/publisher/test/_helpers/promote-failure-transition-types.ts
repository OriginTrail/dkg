import type { PromoteFailureTransition } from '../../src/index.js';

const retrying: PromoteFailureTransition = { state: 'failed_retrying', jobId: 'job', attemptCount: 1, nextRetryAt: 100 };
const terminal: PromoteFailureTransition = { state: 'failed', jobId: 'job', attemptCount: 1 };
// @ts-expect-error A retrying transition must carry the acknowledged retry deadline.
const missingDeadline: PromoteFailureTransition = { state: 'failed_retrying', jobId: 'job', attemptCount: 1 };
// @ts-expect-error Terminal failures cannot carry a retry deadline.
const terminalRetry: PromoteFailureTransition = { state: 'failed', jobId: 'job', attemptCount: 1, nextRetryAt: 100 };
// @ts-expect-error Failure acknowledgement cannot represent success or a running lease.
const nonFailure: PromoteFailureTransition = { state: 'succeeded', jobId: 'job', attemptCount: 1 };
void [retrying, terminal, missingDeadline, terminalRetry, nonFailure];
