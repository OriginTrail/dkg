import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import type { PromoteJob, PromoteRequest } from '../src/async-promote-queue-types.js';

const graph = 'urn:dkg:promote-queue:control-plane';
const prefix = 'urn:dkg:promote-queue:';
const author = `0x${'aa'.repeat(20)}`;
const request: PromoteRequest = { contextGraphId: 'upgrade', subGraphName: 'code',
  assertionName: 'previous-asset', entities: 'all', authorAgentAddress: author };
const key = 'upgrade\u001fcode\u001fprevious-asset\u001f';

describe('persisted format-3 upgrade', () => {
  let store: OxigraphStore;
  beforeEach(() => { store = new OxigraphStore(); });
  afterEach(async () => { await store.close(); });
  const reopen = () => new TripleStoreAsyncPromoteQueue(store, { now: () => 10_000, leaseMs: 1_000 });

  // Deliberately independent of the current writer's version constant and serializer.
  // These are the previous daemon's RDF indexes and JSON payload, not a new enqueue.
  async function persistPreviousJob(started?: boolean): Promise<void> {
    const running = started !== undefined;
    const job: PromoteJob = { jobId: 'previous-v3', formatVersion: 3, request,
      state: running ? 'running' : 'queued', enqueuedAt: 1, updatedAt: 2,
      attempt: { count: running ? 1 : 0, maxRetries: 5 },
      ...(running ? { lease: { workerId: 'old-daemon', acquiredAt: 2, expiresAt: 1_000,
        lastHeartbeatAt: 2, claimToken: 'old-claim' },
      commitMarker: { promoteStarted: started!, swmInserted: false, wmCleaned: false,
        lifecycleStamped: false, gossiped: false } } : {}),
    };
    const values: Array<[string, string]> = [
      ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `<${prefix}Job>`],
      [`${prefix}state`, JSON.stringify(job.state)],
      [`${prefix}payload`, JSON.stringify(JSON.stringify(job))],
      [`${prefix}contextGraphId`, '"upgrade"'], [`${prefix}subGraphName`, '"code"'],
      [`${prefix}assertionName`, '"previous-asset"'], [`${prefix}uniquenessKey`, JSON.stringify(key)],
      [`${prefix}enqueuedAt`, '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'],
      [`${prefix}updatedAt`, '"2"^^<http://www.w3.org/2001/XMLSchema#integer>'],
    ];
    if (running) values.push([`${prefix}leaseExpiresAt`, '"1000"^^<http://www.w3.org/2001/XMLSchema#integer>'],
      [`${prefix}claimToken`, '"old-claim"']);
    await store.insert(values.map(([predicate, object]) => ({ subject: `${prefix}job:previous-v3`, predicate, object, graph })));
  }

  it('claims an author-only v3 default storage lane without making it a wildcard', async () => {
    await persistPreviousJob();
    const queue = reopen();
    expect((await queue.getStatus('previous-v3'))?.formatVersion).toBe(3);
    await expect(queue.enqueue(request)).rejects.toMatchObject({ existingJobId: 'previous-v3' });
    const claimed = await queue.claimNext('new-daemon');
    expect(claimed?.jobId).toBe('previous-v3');
    expect(claimed?.request).toEqual(request);
    expect(claimed?.request.agentAddress).toBeUndefined();
    expect(claimed?.request.recoveryBinding).toBeUndefined();
    // Reconstruct again after claiming: persisted lane policy must survive both transitions.
    const reconstructed = reopen();
    await expect(reconstructed.enqueue(request)).rejects.toMatchObject({ existingJobId: 'previous-v3' });
    const independent = await reconstructed.enqueue({ ...request, agentAddress: author });
    expect((await reconstructed.claimNext('explicit-lane'))?.jobId).toBe(independent);
    expect((await reconstructed.getStatus('previous-v3'))?.state).toBe('running');
  });

  it.each([false, true])('keeps v3 startup recovery conservative when promoteStarted=%s', async started => {
    await persistPreviousJob(started);
    const queue = reopen();
    expect((await queue.getStatus('previous-v3'))?.formatVersion).toBe(3);
    expect(await queue.recoverOnStartup()).toMatchObject({ reclaimed: started ? 0 : 1, abandoned: started ? 1 : 0 });
    const reconstructed = reopen();
    const restored = await reconstructed.getStatus('previous-v3');
    expect(restored?.request).toEqual(request);
    expect(restored?.request.recoveryBinding).toBeUndefined();
    expect(restored?.lease).toBeUndefined();
    if (started) {
      expect(restored?.state).toBe('failed');
      expect(restored?.reason).toMatch(/partial promote ambiguity/i);
      expect(await reconstructed.claimNext('automatic')).toBeNull();
      await expect(reconstructed.recover('previous-v3')).rejects.toThrow(/partial promote ambiguity/i);
    } else {
      expect(restored?.state).toBe('queued');
      const claimed = await reconstructed.claimNext('automatic');
      expect(claimed?.jobId).toBe('previous-v3');
      expect(claimed?.request).toEqual(request);
    }
  });
});
