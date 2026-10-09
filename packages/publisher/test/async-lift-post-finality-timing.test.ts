/**
 * GH#3081 — the post-finality timeline through the real publisher. A detached executor parks in
 * its post-receipt tail, recovery parks in its handler, and the one line written when the terminal
 * record lands must charge each wait to the segment it was spent in. An inline result and a held
 * failed record finalized by the dispatcher are labelled by their own paths.
 */
import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import { DEFAULT_CONTROL_GRAPH_URI } from '../src/async-lift-control-plane.js';
import { LiftJobChainObservations } from '../src/lift-job-chain-observations.js';
import { LiftJobCompletionTiming } from '../src/lift-job-completion-timing.js';
import {
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  kaVmRecoveryEvidence,
  recoveredResolution,
  stageKnowledgeAssetShareSnapshot,
} from '../../../scripts/testing/ka-vm-publish.js';
import {
  TX_HASH,
  confirmedPublishResult,
  createAsyncLift2270Harness,
} from './_helpers/async-lift-2270-harness.js';
import { createReceiptHintHarness } from './_helpers/receipt-hint-scenario.js';

/** Replace the store's shared timeline with one on a clock the row moves by hand. */
function installTimeline(store: TripleStore, tick = 0) {
  const clock = { now: 0 };
  const lines: Array<{ level: 'info' | 'debug'; ctx: OperationContext; message: string }> = [];
  LiftJobChainObservations.shared(store, DEFAULT_CONTROL_GRAPH_URI).completion = new LiftJobCompletionTiming({
    clock: () => (clock.now += tick),
    log: {
      info: (ctx, message) => { lines.push({ level: 'info', ctx, message }); },
      debug: (ctx, message) => { lines.push({ level: 'debug', ctx, message }); },
    },
  });
  return { clock, lines };
}

describe('async publish post-finality timing', () => {
  it('charges a detached job its executor tail, its recovery admission and its recovery handler', async () => {
    const h = createReceiptHintHarness();
    const { clock, lines } = installTimeline(h.store);
    let enterRepair!: () => void;
    const repairEntered = new Promise<void>((resolve) => { enterRepair = resolve; });
    let finishRepair!: () => void;
    const repairGate = new Promise<void>((resolve) => { finishRepair = resolve; });
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      finalizeRecovered: async () => {
        enterRepair();
        await repairGate;
      },
    });
    try {
      // The receipt hint fired at 0. The reconciler proves the transaction while the tail is parked.
      clock.now = 1_000;
      await publisher.recover();
      expect((await publisher.getStatus(jobId))?.status).toBe('included');
      expect(lines).toEqual([]);

      clock.now = 61_000;
      releaseTail();
      await publisher.drainDetachedExecutions();

      clock.now = 63_500;
      const recovering = publisher.recover();
      await repairEntered;
      clock.now = 103_500;
      finishRepair();
      await recovering;

      expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
      expect(lines).toHaveLength(1);
      expect(lines[0]!.level).toBe('info');
      expect(lines[0]!.ctx.sourceOperationId).toBe(jobId);
      expect(lines[0]!.message).toBe(
        `async_publish_post_finality job=${jobId} path=detached anchor=finality totalMs=102500 `
        + 'tailMs=60000 recoveryAdmissionMs=2500 recoveryRetryMs=0 proofMs=0 recoveryMs=40000 '
        + 'terminalWriteMs=0 recoveryTurns=1 recoveryAttempts=1 receiptToFinalityMs=1000',
      );
    } finally {
      releaseTail();
      finishRepair();
      await publisher.drainDetachedExecutions();
    }
  });

  it('logs a short detached job at debug and keeps a deferred repair inside the retry segment', async () => {
    const h = createReceiptHintHarness();
    const { clock, lines } = installTimeline(h.store);
    let repairs = 0;
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      finalizeRecovered: async () => {
        repairs += 1;
        if (repairs === 1) throw new Error('SWM catch-up still in progress');
      },
    });
    try {
      clock.now = 100;
      await publisher.recover();
      clock.now = 200;
      releaseTail();
      await publisher.drainDetachedExecutions();
      clock.now = 300;
      await publisher.recover();
      expect((await publisher.getStatus(jobId))?.status).toBe('included');
      clock.now = 900;
      await publisher.recover();

      expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
      expect(repairs).toBe(2);
      expect(lines.map(({ level }) => level)).toEqual(['debug']);
      expect(lines[0]!.message).toBe(
        `async_publish_post_finality job=${jobId} path=detached anchor=finality totalMs=800 `
        + 'tailMs=100 recoveryAdmissionMs=100 recoveryRetryMs=600 proofMs=0 recoveryMs=0 '
        + 'terminalWriteMs=0 recoveryTurns=2 recoveryAttempts=2 receiptToFinalityMs=100',
      );
    } finally {
      releaseTail();
      await publisher.drainDetachedExecutions();
    }
  });

  it('reports an inline result from its first inclusion evidence, all of it as the tail', async () => {
    const h = createAsyncLift2270Harness();
    h.reset();
    const { lines } = installTimeline(h.store, 100);
    const publisher = h.createPublisher();
    await stageKnowledgeAssetShareSnapshot({ store: h.store, graphManager: new GraphManager(h.store) });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claim = await publisher.claimNext('wallet-a');
    if (!claim) throw new Error('expected a claim');
    await publisher.openClaimSession(claim).update('validated', { validation: KA_VM_VALIDATION });

    expect((await publisher.recordPublishResult(jobId, confirmedPublishResult())).status).toBe('finalized');

    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('debug');
    expect(lines[0]!.message).toBe(
      `async_publish_post_finality job=${jobId} path=inline anchor=receipt totalMs=100 tailMs=100 `
      + 'recoveryAdmissionMs=- recoveryRetryMs=- proofMs=- recoveryMs=- terminalWriteMs=- '
      + 'recoveryTurns=0 recoveryAttempts=0 receiptToFinalityMs=-',
    );
  });

  it('labels a held failed record finalized by the chain-proof dispatcher', async () => {
    const h = createAsyncLift2270Harness();
    h.reset();
    const { clock, lines } = installTimeline(h.store);
    const publisher = h.createPublisher({
      chainProofResolver: async () => recoveredResolution(TX_HASH),
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(TX_HASH),
      knowledgeAssetVmPublishHandler: {
        execute: async () => {
          throw new Error('the dispatcher must never cause a send');
        },
        finalizeRecovered: async () => {
          clock.now += 25_000;
        },
      },
    });
    const failed = await h.failAfterRecordedTxHash(publisher);
    clock.now = 5_000;

    expect(await publisher.recover()).toBe(1);

    expect((await publisher.getStatus(failed.jobId))?.status).toBe('finalized');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('info');
    expect(lines[0]!.message).toBe(
      `async_publish_post_finality job=${failed.jobId} path=held-failed anchor=finality totalMs=25000 `
      + 'tailMs=- recoveryAdmissionMs=- recoveryRetryMs=- proofMs=0 recoveryMs=25000 '
      + 'terminalWriteMs=0 recoveryTurns=0 recoveryAttempts=1 receiptToFinalityMs=0',
    );
  });
});
