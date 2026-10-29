import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { createAsyncPromoteWorkerFixture } from './_helpers/async-promote-worker-fixture.js';

const author = '0x3333333333333333333333333333333333333333';
const evidence = {
  version: 1, contextGraphId: 'graphify', assertionName: 'shard-1', subGraphName: 'code',
  agentAddress: author, entities: 'all', shareOperationId: 'share-original',
  seal: {
    assertionMerkleRoot: `0x${'aa'.repeat(32)}`, authorAddress: author,
    authorAttestationR: `0x${'11'.repeat(32)}`, authorAttestationVS: `0x${'22'.repeat(32)}`,
    authorSchemeVersion: '1', assertedAtChainId: '31337',
    assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
    reservedKaId: ((BigInt(author) << 96n) | 7n).toString(),
    assertionFinalizedAt: '2026-10-19T00:00:00.000Z', contentScopeVersion: '2',
    kaUal: `did:dkg:evm:31337/${author}/7`, assertionVersion: '2',
    publicTripleCount: '1', privateTripleCount: '0', privateMerkleRoot: null,
  },
} as const;

describe('async share producer evidence', () => {
  it('retains the actual producer association when the queue is reconstructed without the enqueue reply', async () => {
    const f = createAsyncPromoteWorkerFixture();
    // Deliberately discard enqueue's response; no second mutation is posted.
    await f.queue.enqueue(f.makeRequest({ agentAddress: author }));
    const job = (await f.queue.claimNext('worker-test'))!;
    const producer = vi.fn(async () => ({ promotedCount: 1, shareEvidence: evidence }));
    expect(await runPromoteJob({ job, queue: f.queue, workerId: 'worker-test',
      runPromote: producer, now: f.clock.now, heartbeatIntervalMs: 0, log: () => {},
    })).toMatchObject({ outcome: 'succeeded' });
    const reopened = new TripleStoreAsyncPromoteQueue(f.store, { now: f.clock.now });
    const retained = await reopened.list({ contextGraphId: 'graphify' });
    expect(retained).toHaveLength(1);
    expect(retained[0].result).toMatchObject({ shareEvidence: evidence });
    expect(producer).toHaveBeenCalledTimes(1);
  });
});
