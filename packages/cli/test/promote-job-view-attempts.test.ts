/**
 * A share job view keeps `attempts` within `maxAttempts`. The queue keeps counting when a recovery rule
 * grants an attempt past the budget, and the view reports those attempts on their own, as
 * `recoveryAttempts`, present only when there were any.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue, type PromoteJob } from '@origintrail-official/dkg-publisher';
import { promoteJobToView } from '../src/daemon/routes/promote-job-view.js';

function job(count: number, maxRetries: number): PromoteJob {
  return {
    jobId: 'share-1',
    request: { contextGraphId: 'cg', assertionName: 'a', entities: 'all' },
    state: 'failed',
    enqueuedAt: 1_000,
    updatedAt: 2_000,
    attempt: { count, maxRetries },
  };
}

describe('share job view attempts', () => {
  it('reports the attempts within the budget as they are, with no recovery count', () => {
    for (const count of [0, 2, 5]) {
      const view = promoteJobToView(job(count, 5));
      expect(view).toMatchObject({ attempts: count, maxAttempts: 5 });
      expect(view).not.toHaveProperty('recoveryAttempts');
    }
  });

  it('stops `attempts` at `maxAttempts` and counts the rest as recovery attempts', () => {
    expect(promoteJobToView(job(6, 5))).toMatchObject({ attempts: 5, maxAttempts: 5, recoveryAttempts: 1 });
    expect(promoteJobToView(job(12, 3))).toMatchObject({ attempts: 3, maxAttempts: 3, recoveryAttempts: 9 });
  });

  it('counts an attempt that runs again after its worker stopped as a recovery attempt', async () => {
    let now = 1_000;
    const queue = new TripleStoreAsyncPromoteQueue(new OxigraphStore(), {
      now: () => now, idGenerator: () => 'share-reclaimed', maxRetries: 1, leaseMs: 60_000,
    });
    await queue.enqueue({ contextGraphId: 'cg', assertionName: 'a', entities: 'all' });
    const first = await queue.claimNext('worker-1');
    expect(promoteJobToView(first!)).toMatchObject({ attempts: 1, maxAttempts: 1 });

    // The worker stops before the share changes anything; its lease expires and the job runs again.
    now += 120_000;
    const second = await queue.claimNext('worker-2');
    expect(second?.jobId).toBe('share-reclaimed');
    expect(second?.attempt.count).toBe(2);
    await queue.fail(second!.jobId, second!.lease!.claimToken, {
      message: 'transient blip', retryable: true, classification: 'transient', recordedAt: now,
    });

    const view = promoteJobToView((await queue.getStatus('share-reclaimed'))!);
    expect(view).toMatchObject({ state: 'failed', attempts: 1, maxAttempts: 1, recoveryAttempts: 1 });
  });
});
