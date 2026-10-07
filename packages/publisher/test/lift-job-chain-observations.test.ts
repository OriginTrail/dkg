import { beforeEach, describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import type { LiftJobIncluded } from '../src/lift-job.js';
import { LiftJobChainObservations } from '../src/lift-job-chain-observations.js';
import { confirmedPublishResult } from './_helpers/async-lift-2270-harness.js';
import {
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from '../../../scripts/testing/ka-vm-publish.js';

describe('lift-job chain observations', () => {
  let now: number;

  beforeEach(() => {
    now = 1_000;
  });

  /** Every clock read is later than the one before, so a value stamped late cannot hide. */
  async function validatedJob() {
    const store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => 'job-1',
    });
    await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claim = await publisher.claimNext('wallet-a');
    if (!claim) throw new Error('expected a claim');
    await publisher.openClaimSession(claim).update('validated', { validation: KA_VM_VALIDATION });
    return { store, publisher, jobId, claim };
  }

  /** A real included record, with the observations a write would have added taken off again. */
  async function unobservedIncludedJob(): Promise<LiftJobIncluded> {
    const { publisher, jobId } = await validatedJob();
    const included = await publisher.recordPublishResult(jobId, {
      ...confirmedPublishResult(),
      status: 'tentative',
    });
    if (included.status !== 'included') throw new Error('expected an included job');
    const { acceptedAt, updatedAt, includedAt } = included.timestamps;
    return { ...included, timestamps: { acceptedAt, updatedAt, includedAt } };
  }

  it('takes inclusion as the first evidence of an inline publish, and records no finality', async () => {
    const { store, publisher, jobId } = await validatedJob();

    // One confirmed result walks broadcast, included and finalized in a single inline pass:
    // no reconciliation pass has proved the transaction, so nothing observed its finality.
    const finalized = await publisher.recordPublishResult(jobId, confirmedPublishResult());

    expect(finalized.status).toBe('finalized');
    const { receiptObservedAt, includedAt, finalizedAt } = finalized.timestamps;
    expect(receiptObservedAt).toBe(includedAt);
    expect(finalizedAt).toBeGreaterThan(includedAt!);
    expect(finalized.timestamps).not.toHaveProperty('finalityObservedAt');
    expect(await publisher.getStatus(jobId)).toEqual(finalized);
    // A second handle on the same store has no in-process observations: this is what was persisted.
    const persisted = await new TripleStoreAsyncLiftPublisher(store).getStatus(jobId);
    expect(persisted?.timestamps).toEqual(finalized.timestamps);
  });

  it('keeps the first receipt of a transaction, at the evidence time it is given', async () => {
    const job = await unobservedIncludedJob();
    const observations = new LiftJobChainObservations(() => now);

    observations.receipt(job.jobId, job.broadcast.txHash, 5);
    now = 9_000;
    observations.receipt(job.jobId, job.broadcast.txHash.toUpperCase());

    const projected = observations.project(job);
    expect(projected.timestamps.receiptObservedAt).toBe(5);
    expect(projected.timestamps).not.toHaveProperty('finalityObservedAt');
    expect(projected).not.toBe(job);
    expect(job.timestamps).not.toHaveProperty('receiptObservedAt');
  });

  it('records finality once, when canonical evidence is observed', async () => {
    const job = await unobservedIncludedJob();
    const observations = new LiftJobChainObservations(() => now);

    now = 7_000;
    observations.finality(job.jobId, job.broadcast.txHash);
    now = 8_000;
    observations.finality(job.jobId, job.broadcast.txHash);

    expect(observations.project(job).timestamps).toMatchObject({
      receiptObservedAt: 7_000,
      finalityObservedAt: 7_000,
    });
  });

  it('lets a persisted observation win over a later one in this process', async () => {
    const job = await unobservedIncludedJob();
    const observations = new LiftJobChainObservations(() => now);
    observations.finality(job.jobId, job.broadcast.txHash);

    const projected = observations.project({
      ...job,
      timestamps: { ...job.timestamps, receiptObservedAt: 11, finalityObservedAt: 12 },
    });

    expect(projected.timestamps).toMatchObject({ receiptObservedAt: 11, finalityObservedAt: 12 });
  });

  it('keeps nothing the restart schema would reject', async () => {
    const job = await unobservedIncludedJob();
    const brokenClock = new LiftJobChainObservations(() => Number.NaN);
    brokenClock.receipt(job.jobId, job.broadcast.txHash);
    brokenClock.finality(job.jobId, job.broadcast.txHash);
    brokenClock.receipt(job.jobId, job.broadcast.txHash, Number.POSITIVE_INFINITY);

    expect(brokenClock.project(job)).toBe(job);

    // A clock that fails after a good receipt costs the finality observation, nothing else.
    const failingClock = new LiftJobChainObservations(() => now);
    const receiptObservedAt = now;
    failingClock.receipt(job.jobId, job.broadcast.txHash);
    now = Number.NaN;
    failingClock.finality(job.jobId, job.broadcast.txHash);

    expect(failingClock.project(job).timestamps).toEqual({ ...job.timestamps, receiptObservedAt });
    expect(failingClock.project(job).timestamps).not.toHaveProperty('finalityObservedAt');
  });

  it('never attaches the observation of one transaction to another', async () => {
    const job = await unobservedIncludedJob();
    const observations = new LiftJobChainObservations(() => now);

    observations.finality(job.jobId, `0x${'ee'.repeat(32)}`);
    expect(observations.project(job)).toBe(job);

    observations.receipt(job.jobId, job.broadcast.txHash);
    observations.finality(job.jobId, '');
    expect(observations.project(job).timestamps).not.toHaveProperty('finalityObservedAt');
  });

  it('leaves a job without a transaction untouched', async () => {
    const { claim } = await validatedJob();
    const observations = new LiftJobChainObservations(() => now);
    observations.receipt(claim.jobId, `0x${'ee'.repeat(32)}`);

    expect(observations.project(claim)).toBe(claim);
    expect(observations.project(null)).toBeNull();
  });

  it('forgets the oldest job once it holds 512', async () => {
    const job = await unobservedIncludedJob();
    const observations = new LiftJobChainObservations(() => now);
    observations.receipt(job.jobId, job.broadcast.txHash);

    for (let other = 0; other < 511; other += 1) observations.receipt(`other-${other}`, '0x01');
    expect(observations.project(job).timestamps.receiptObservedAt).toBe(now);

    observations.receipt('other-511', '0x01');
    expect(observations.project(job)).toBe(job);
  });
});
