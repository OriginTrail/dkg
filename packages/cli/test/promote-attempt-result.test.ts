import { describe, expect, it, vi } from 'vitest';
import { createPromoteRetryableFailure } from '@origintrail-official/dkg-publisher';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { createAsyncPromoteWorkerFixture } from './_helpers/async-promote-worker-fixture.js';

describe('attempt result preserves the domain outcome', () => {
  it.each(['succeeded', 'failed_retrying', 'failed_terminal', 'partial_promote_ambiguity', 'failure_bookkeeping_uncertain'] as const)(
    'returns the original result/cause with %s bookkeeping', async outcome => {
      const fixture = createAsyncPromoteWorkerFixture();
      const { queue, clock, store } = fixture;
      try {
        const job = await fixture.enqueueAndClaim();
        const domainResult = { promotedCount: 0, sealed: true, publishReady: false, shareOperationId: 'original-operation' };
        const cause = outcome === 'failed_retrying' ? createPromoteRetryableFailure(new Error('dependency unavailable')) : new Error('domain refusal');
        const bookkeepingCause = new Error('bookkeeping lease fenced');
        if (outcome === 'partial_promote_ambiguity') vi.spyOn(queue, 'succeed').mockRejectedValue(bookkeepingCause);
        if (outcome === 'failure_bookkeeping_uncertain') vi.spyOn(queue, 'fail').mockRejectedValue(bookkeepingCause);
        const attempt = await runPromoteJob({ job, queue, workerId: 'worker-test', now: clock.now,
          heartbeatIntervalMs: 0, log: () => undefined,
          runPromote: async (_request, started) => {
            await started();
            if (outcome === 'succeeded' || outcome === 'partial_promote_ambiguity') return domainResult;
            throw cause;
          },
        });
        expect(attempt.outcome).toBe(outcome);
        if (attempt.outcome === 'succeeded' || attempt.outcome === 'partial_promote_ambiguity') expect(attempt.result).toBe(domainResult);
        if (attempt.outcome === 'partial_promote_ambiguity') expect(attempt.cause).toBe(bookkeepingCause);
        if (attempt.outcome === 'failed_retrying' || attempt.outcome === 'failed_terminal' || attempt.outcome === 'failure_bookkeeping_uncertain') expect(attempt.cause).toBe(cause);
        if (attempt.outcome === 'failure_bookkeeping_uncertain') expect(attempt.bookkeepingCause).toBe(bookkeepingCause);
        if (outcome === 'partial_promote_ambiguity' || outcome === 'failure_bookkeeping_uncertain') {
          expect((await queue.getStatus(job.jobId))?.state).toBe('running');
        }
      } finally { await store.close(); }
    },
  );
});
