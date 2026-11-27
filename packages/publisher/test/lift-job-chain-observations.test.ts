import { beforeEach, describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import type { LiftJobIncluded } from '../src/lift-job.js';
import { LiftJobChainObservations } from '../src/lift-job-chain-observations.js';
import { confirmedPublishResult } from './_helpers/async-lift-2270-harness.js';
import { readPersistedLiftJob } from './_helpers/persisted-lift-job.js';
import {
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  kaVmRecoveryEvidence,
  recoveredResolution,
  stageKnowledgeAssetShareSnapshot,
} from '../../../scripts/testing/ka-vm-publish.js';

const TX_HASH = `0x${'aa'.repeat(32)}` as const;

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
    expect(await readPersistedLiftJob(store, jobId)).toEqual(finalized);
  });

  /**
   * A broadcast job that only recovery can settle: no executor ever reported a receipt for it.
   * One instance admits the job and serves its views, as the daemon's control instance does;
   * another one reconciles it and parks in local repair until `finishRepair` is called.
   */
  async function recoveringBroadcastJob(evidenceTxHash: `0x${string}` = TX_HASH) {
    let enterRepair!: () => void;
    const repairEntered = new Promise<void>((resolve) => { enterRepair = resolve; });
    let finishRepair!: () => void;
    const repairFinished = new Promise<void>((resolve) => { finishRepair = resolve; });
    const store = new OxigraphStore();
    const clock = { now: () => ++now, idGenerator: () => 'job-1' };
    await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
    const control = new TripleStoreAsyncLiftPublisher(store, clock);
    const jobId = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await control.claimNext('wallet-a');
    await control.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await control.update(jobId, 'broadcast', {
      broadcast: { txHash: TX_HASH, walletId: 'wallet-a', operationKind: 'create' },
    });
    const runtime = new TripleStoreAsyncLiftPublisher(store, {
      ...clock,
      chainProofResolver: async () => recoveredResolution(TX_HASH),
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(evidenceTxHash),
      knowledgeAssetVmPublishHandler: {
        execute: async () => { throw new Error('the executor must not run in this test'); },
        finalizeRecovered: async () => {
          enterRepair();
          await repairFinished;
        },
      },
    });
    const reconciled = runtime.reconciliationScheduling.reconcile();
    await repairEntered;
    return { store, control, runtime, jobId, finishRepair, reconciled };
  }

  it('shows finality from a recovery proof while local repair is still running', async () => {
    const { store, control, runtime, jobId, finishRepair, reconciled } = await recoveringBroadcastJob();
    try {
      const held = await runtime.getStatus(jobId);
      expect(held?.status).toBe('broadcast');
      const provedAt = held?.timestamps.finalityObservedAt;
      expect(provedAt).toBeGreaterThan(held!.timestamps.broadcastAt!);
      expect(held?.timestamps.receiptObservedAt).toBe(provedAt);
      expect(await control.getStatus(jobId)).toEqual(held);
      expect((await control.list()).find((job) => job.jobId === jobId)).toEqual(held);
      expect((await readPersistedLiftJob(store, jobId))?.timestamps).not.toHaveProperty('finalityObservedAt');

      finishRepair();
      await reconciled;

      const finalized = await readPersistedLiftJob(store, jobId);
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.timestamps).toMatchObject({ receiptObservedAt: provedAt, finalityObservedAt: provedAt });
      expect(finalized?.timestamps.finalizedAt).toBeGreaterThan(provedAt!);
    } finally {
      finishRepair();
      await reconciled.catch(() => {});
    }
  });

  it('records nothing for the job when recovery evidence names another transaction', async () => {
    const { store, runtime, jobId, finishRepair, reconciled } = await recoveringBroadcastJob(`0x${'bb'.repeat(32)}`);
    try {
      expect((await runtime.getStatus(jobId))?.timestamps).not.toHaveProperty('finalityObservedAt');

      finishRepair();
      await reconciled;

      const finalized = await readPersistedLiftJob(store, jobId);
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.timestamps).not.toHaveProperty('receiptObservedAt');
      expect(finalized?.timestamps).not.toHaveProperty('finalityObservedAt');
    } finally {
      finishRepair();
      await reconciled.catch(() => {});
    }
  });

  it('is one set of observations per store and control graph', () => {
    const store = new OxigraphStore();
    const shared = LiftJobChainObservations.shared(store, 'urn:graph:a');

    expect(LiftJobChainObservations.shared(store, 'urn:graph:a')).toBe(shared);
    expect(LiftJobChainObservations.shared(store, 'urn:graph:b')).not.toBe(shared);
    expect(LiftJobChainObservations.shared(new OxigraphStore(), 'urn:graph:a')).not.toBe(shared);
  });

  it('keeps the first receipt of a transaction, at the evidence time it is given', async () => {
    const job = await unobservedIncludedJob();
    const observations = new LiftJobChainObservations();

    observations.receipt(job.jobId, job.broadcast.txHash, 5);
    observations.receipt(job.jobId, job.broadcast.txHash.toUpperCase(), 9_000);

    const projected = observations.project(job);
    expect(projected.timestamps.receiptObservedAt).toBe(5);
    expect(projected.timestamps).not.toHaveProperty('finalityObservedAt');
    expect(projected).not.toBe(job);
    expect(job.timestamps).not.toHaveProperty('receiptObservedAt');
  });

  it('records finality once, when canonical evidence is observed', async () => {
    const job = await unobservedIncludedJob();
    const observations = new LiftJobChainObservations();

    observations.finality(job.jobId, job.broadcast.txHash, 7_000);
    observations.finality(job.jobId, job.broadcast.txHash, 8_000);

    expect(observations.project(job).timestamps).toMatchObject({
      receiptObservedAt: 7_000,
      finalityObservedAt: 7_000,
    });
  });

  it('lets a persisted observation win over a later one in this process', async () => {
    const job = await unobservedIncludedJob();
    const observations = new LiftJobChainObservations();
    observations.finality(job.jobId, job.broadcast.txHash, 9_000);

    const projected = observations.project({
      ...job,
      timestamps: { ...job.timestamps, receiptObservedAt: 11, finalityObservedAt: 12 },
    });

    expect(projected.timestamps).toMatchObject({ receiptObservedAt: 11, finalityObservedAt: 12 });
  });

  it('keeps nothing the restart schema would reject', async () => {
    const job = await unobservedIncludedJob();
    const brokenClock = new LiftJobChainObservations();
    brokenClock.receipt(job.jobId, job.broadcast.txHash, Number.NaN);
    brokenClock.finality(job.jobId, job.broadcast.txHash, Number.NaN);
    brokenClock.receipt(job.jobId, job.broadcast.txHash, Number.POSITIVE_INFINITY);

    expect(brokenClock.project(job)).toBe(job);

    // A clock that fails after a good receipt costs the finality observation, nothing else.
    const failingClock = new LiftJobChainObservations();
    failingClock.receipt(job.jobId, job.broadcast.txHash, 5);
    failingClock.finality(job.jobId, job.broadcast.txHash, Number.NaN);

    expect(failingClock.project(job).timestamps).toEqual({ ...job.timestamps, receiptObservedAt: 5 });
    expect(failingClock.project(job).timestamps).not.toHaveProperty('finalityObservedAt');
  });

  it('never attaches the observation of one transaction to another', async () => {
    const job = await unobservedIncludedJob();
    const observations = new LiftJobChainObservations();

    observations.finality(job.jobId, `0x${'ee'.repeat(32)}`, 5);
    expect(observations.project(job)).toBe(job);

    observations.receipt(job.jobId, job.broadcast.txHash, 6);
    observations.finality(job.jobId, '', 7);
    expect(observations.project(job).timestamps).not.toHaveProperty('finalityObservedAt');
  });

  it('leaves a job without a transaction untouched', async () => {
    const { claim } = await validatedJob();
    const observations = new LiftJobChainObservations();
    observations.receipt(claim.jobId, `0x${'ee'.repeat(32)}`, 5);

    expect(observations.project(claim)).toBe(claim);
    expect(observations.project(null)).toBeNull();
  });

  it('forgets the oldest job once it holds 512', async () => {
    const job = await unobservedIncludedJob();
    const observations = new LiftJobChainObservations();
    observations.receipt(job.jobId, job.broadcast.txHash, 5);

    for (let other = 0; other < 511; other += 1) observations.receipt(`other-${other}`, '0x01', 6);
    expect(observations.project(job).timestamps.receiptObservedAt).toBe(5);

    observations.receipt('other-511', '0x01', 6);
    expect(observations.project(job)).toBe(job);
  });
});
