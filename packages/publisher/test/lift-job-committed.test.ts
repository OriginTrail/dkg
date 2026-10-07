import { describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import type { LiftJobClaimed } from '../src/lift-job.js';
import { committedLiftJob, requireActiveLiftJobClaim } from '../src/lift-job-committed.js';
import {
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from '../../../scripts/testing/ka-vm-publish.js';

describe('committed lift-job writes', () => {
  async function claimOne() {
    const store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      now: () => 1_000,
      idGenerator: () => 'job-1',
      claimTokenGenerator: () => 'claim-1',
    });
    await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const accepted = await publisher.getStatus(jobId);
    if (accepted?.status !== 'accepted') throw new Error('expected an accepted job');
    const claim = await publisher.claimNext('wallet-a');
    if (!claim) throw new Error('expected a claim');
    return { publisher, jobId, accepted, claim };
  }

  it('hands a worker the committed record, with the fence it was claimed under', async () => {
    const { publisher, jobId, claim } = await claimOne();

    expect(claim.status).toBe('claimed');
    expect(claim.claim.claimToken).toBe(`wallet-a:${jobId}:claim-1`);
    expect(claim.claim.claimLeaseExpiresAt).toBeGreaterThan(1_000);
    // The handle is the record persistence rebuilt, not the in-memory write candidate.
    expect(await publisher.getStatus(jobId)).toEqual(claim);
  });

  it('narrows a canonical record only to the state of its write candidate', async () => {
    const { accepted, claim } = await claimOne();

    expect(committedLiftJob(claim, claim)).toBe(claim);
    expect(() => committedLiftJob(claim, accepted))
      .toThrow('Canonical LiftJob is claimed; its write candidate was accepted');
  });

  it('re-establishes the fence on a copy of the committed claim', async () => {
    const { claim } = await claimOne();
    const committed: LiftJobClaimed = claim;

    const active = requireActiveLiftJobClaim(committed);

    expect(active).toEqual(claim);
    expect(active).not.toBe(committed);
    expect(active.claim).not.toBe(committed.claim);
  });

  it('refuses a committed claim without a token or a lease as live worker authority', async () => {
    const { claim } = await claimOne();
    const { walletId, claimToken, claimLeaseExpiresAt } = claim.claim;
    const fenceless: readonly LiftJobClaimed['claim'][] = [
      { walletId, claimLeaseExpiresAt },
      { walletId, claimToken: '', claimLeaseExpiresAt },
      { walletId, claimToken },
    ];

    for (const withoutFence of fenceless) {
      expect(() => requireActiveLiftJobClaim({ ...claim, claim: withoutFence }))
        .toThrow(`Committed claim of LiftJob ${claim.jobId} carries no ownership fence`);
    }
  });
});
