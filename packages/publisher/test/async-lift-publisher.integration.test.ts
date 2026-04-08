import { afterEach, describe, expect, it } from 'vitest';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  createLiftJobFailureMetadata,
  type LiftRequest,
} from '../src/index.js';

describe('TripleStoreAsyncLiftPublisher integration', () => {
  const stores: TripleStore[] = [];

  const request = (shareOperationId: string, roots: readonly string[] = ['urn:local:/rihana']): LiftRequest => ({
    swmId: 'swm-1',
    shareOperationId,
    roots,
    contextGraphId: 'music-social',
    namespace: 'aloha',
    scope: 'person-profile',
    transitionType: 'CREATE',
    authority: { type: 'owner', proofRef: 'proof:owner:1' },
  });

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it('persists and reloads async lift jobs through the TripleStore factory', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    stores.push(store);

    let now = 10_000;
    let ids = 0;
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
    });

    const acceptedId = await publisher.lift(request('op-1'));
    const retryId = await publisher.lift(request('op-2', ['urn:local:/manson', 'urn:local:/rihana']));

    await publisher.claimNext('wallet-1');
    await publisher.claimNext('wallet-2');
    await publisher.update(retryId, 'failed', {
      failure: createLiftJobFailureMetadata({
        failedFromState: 'claimed',
        code: 'wallet_unavailable',
        message: 'wallet offline',
        errorPayloadRef: 'urn:error:wallet-offline',
      }),
    });

    const accepted = await publisher.getStatus(acceptedId);
    const failed = await publisher.getStatus(retryId);
    const failedJobs = await publisher.list({ status: 'failed' });
    const stats = await publisher.getStats();

    expect(accepted?.status).toBe('claimed');
    expect(accepted?.jobSlug).toBe('music-social/person-profile/create/op-1/rihana');
    expect(failed?.status).toBe('failed');
    expect(failed?.jobSlug).toBe('music-social/person-profile/create/op-2/manson-rihana');
    expect(failedJobs).toHaveLength(1);
    expect(failedJobs[0]?.jobId).toBe(retryId);
    expect(stats.claimed).toBe(1);
    expect(stats.failed).toBe(1);

    expect(await publisher.retry()).toBe(1);
    expect((await publisher.getStatus(retryId))?.status).toBe('accepted');
  });
});
