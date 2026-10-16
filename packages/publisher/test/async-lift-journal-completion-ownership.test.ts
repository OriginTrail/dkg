import { describe, expect, it, vi } from 'vitest';
import type { AsyncLiftJournalCompletion } from '../src/async-lift-journal-completion.js';
import type { LiftJobTransitionScope } from '../src/lift-job-transition-scope.js';
import { AsyncLiftRunner } from '../src/async-lift-runner.js';
import type { AsyncLiftClaimCoordinator, AsyncLiftClaimProcessingOutcome } from '../src/async-lift-claim-session.js';
import type { AsyncKnowledgeAssetVmPublishExecutionResult } from '../src/async-lift-publisher-types.js';
import { completionTrace } from '../src/async-lift-completion-trace.js';
import { createLiftJobFailureMetadata } from '../src/lift-job-failures.js';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot, KA_VM_EXECUTOR_TX_HASH, KA_VM_VALIDATION,
  kaVmRecoveryEvidence, recoveredResolution } from '../../../scripts/testing/ka-vm-publish.js';
import { completeResult, completesWithin, fixture, gate, observe } from './_helpers/journal-completion.js';

describe('journal completion retains operation ownership', () => {
  it.each(['public', 'worker'] as const)('gives %s session transitions their declared journal settlement boundary', async (kind) => {
    const f = fixture();
    const publisher = f.create();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const coordinator = (publisher as unknown as { claimCoordinator: AsyncLiftClaimCoordinator }).claimCoordinator;
    const journal = gate();
    const handler = gate();
    f.hooks.insert = (entry) => entry.kind === 'validated' ? journal.wait() : Promise.resolve();
    let transition: ReturnType<typeof observe<unknown>> | undefined;
    const processing = observe(coordinator.processClaim('wallet-1', async (worker) => {
      const session = kind === 'public' ? publisher.openClaimSession(worker.claim) : worker;
      transition = observe(session.update('validated', { validation: KA_VM_VALIDATION }));
      await transition.promise;
      await handler.wait();
      return worker.claim;
    }));
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      expect((await publisher.getStatus(jobId))?.status).toBe('validated');
      expect(await completesWithin(transition!.promise, 30), 'public sessions settle independently; worker sessions defer to their owner')
        .toBe(kind === 'worker');
      expect(processing.settled()).toBe(false);
      expect(coordinator.isProcessing(jobId)).toBe(true);
    } finally {
      journal.release(); handler.release(); await processing.promise;
    }
    expect(coordinator.isProcessing(jobId)).toBe(false);
  });

  it.each([true, false])('rejects expired commit and rollback capabilities before store or repair effects (journal=%s)', async (journalWrites) => {
    const f = fixture();
    const publisher = f.create({ journalWrites });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claim = await publisher.claimNext('wallet-1');
    if (!claim) throw new Error('Expected claim');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    const { claimCoordinator: coordinator, journalCompletion: completion } = publisher as unknown as {
      claimCoordinator: AsyncLiftClaimCoordinator; journalCompletion: AsyncLiftJournalCompletion;
    };
    let captured!: LiftJobTransitionScope;
    let restoreValidated!: () => Promise<void>;
    const stillOpen = gate();
    const operation = completion.runPublicOperation(async (owner) => {
      await coordinator.runPreSendTransaction(owner, claim, async (_job, scope, restore) => { captured = scope; restoreValidated = restore; });
      await stillOpen.wait();
    });
    const primary = vi.spyOn(f.inner, 'replaceSubjectAndInsert');
    const wallet = vi.spyOn(f.inner, 'replaceSubject');
    const repair = vi.fn(async () => null);
    try {
      await stillOpen.reached;
      const current = await publisher.getStatus(jobId);
      if (!current || current.status !== 'validated') throw new Error('Expected real validated job');
      await expect(captured.commit(current, 'validated')).rejects.toThrow('section is closed');
      await expect(restoreValidated()).rejects.toThrow('section is closed');
      await expect(captured.commitProofFinalization(repair)).rejects.toThrow('section is closed');
      await expect(captured.commitRemoval()).rejects.toThrow('section is closed');
      expect(primary).not.toHaveBeenCalled();
      expect(wallet).not.toHaveBeenCalled();
      expect(repair).not.toHaveBeenCalled();
      expect(await publisher.getStatus(jobId)).toEqual(current);
    } finally {
      stillOpen.release(); await operation;
      primary.mockRestore(); wallet.mockRestore();
    }
  });

  it('observes terminal primary and wallet release before the held journal, then full settlement afterward', async () => {
    const f = fixture();
    const journal = gate();
    const primary = vi.spyOn(completionTrace, 'terminalPrimaryCommitted').mockImplementation(() => {});
    const settled = vi.spyOn(completionTrace, 'terminalOperationSettled').mockImplementation(() => {});
    const release = vi.spyOn(completionTrace, 'walletOwnershipReleased').mockImplementation(() => {});
    const enabled = vi.spyOn(completionTrace, 'enabled', 'get').mockReturnValue(true);
    const accepted = vi.spyOn(completionTrace, 'acceptedPrimaryCommitted').mockImplementation(() => {});
    const finality = vi.spyOn(completionTrace, 'finalityObserved').mockImplementation(() => {});
    const publisher = f.create({ knowledgeAssetVmPublishHandler: { execute: async ({ publishOptions }) => {
      await publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
      await publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
      return completeResult();
    } } });
    let processing: Promise<unknown> | undefined;
    try {
      await stageKnowledgeAssetShareSnapshot({ store: f.store });
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expect(accepted).toHaveBeenCalledWith(jobId);
      f.hooks.insert = (entry) => entry.kind === 'finalized' ? journal.wait() : Promise.resolve();
      processing = publisher.processNext('wallet-1');
      expect(await completesWithin(journal.reached)).toBe(true);
      expect(primary).toHaveBeenCalledWith(jobId);
      expect(release).toHaveBeenCalledWith(jobId, 'wallet-1', expect.any(String));
      expect(settled).not.toHaveBeenCalled();
      journal.release(); await processing;
      expect(settled).toHaveBeenCalledWith(jobId);
    } finally {
      journal.release(); await processing;
      for (const spy of [primary, settled, release, enabled, accepted, finality]) spy.mockRestore();
    }
  });

  it.each(['enqueue', 'administrative update', 'retry', 'recovery'] as const)('keeps nested public %s pending until its journal completes', async (api) => {
    const f = fixture();
    const publisher = f.create({ autoRetryEnabled: false });
    let previousId = '';
    if (api === 'retry' || api === 'recovery') {
      previousId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'previous' }));
      await publisher.claimNext('wallet-previous');
      if (api === 'retry') await publisher.update(previousId, 'failed', { failure: { ...createLiftJobFailureMetadata({
        failedFromState: 'claimed', code: 'workspace_unavailable', message: 'workspace temporarily unavailable',
        errorPayloadRef: 'urn:test:retry',
      }), failedFromState: 'claimed' } });
      else f.advance(5 * 60 * 1000 + 1);
    }
    const outerId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'outer' }));
    const coordinator = (publisher as unknown as { claimCoordinator: AsyncLiftClaimCoordinator }).claimCoordinator;
    const journal = gate();
    const kind = { enqueue: 'admission', 'administrative update': 'validated', retry: 'reaccept', recovery: 'recover-reset' }[api];
    f.hooks.insert = (entry) => entry.kind === kind ? journal.wait() : Promise.resolve();
    let inner: ReturnType<typeof observe<unknown>> | undefined;
    const outer = coordinator.processClaim('wallet-outer', async (session) => {
      const operation = api === 'enqueue' ? publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'nested' }))
        : api === 'administrative update' ? publisher.update(outerId, 'validated', { validation: KA_VM_VALIDATION })
          : api === 'retry' ? publisher.retryDetailed({ jobId: previousId }) : publisher.recover();
      inner = observe<unknown>(operation);
      await inner.promise;
      return session.claim;
    });
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      expect(await completesWithin(inner!.promise, 30), 'public API must not donate its journal wait to the parent').toBe(false);
    } finally {
      journal.release(); await outer;
    }
    if (api === 'administrative update') expect((await publisher.getStatus(outerId))?.status).toBe('validated');
    if (api === 'retry' || api === 'recovery') expect((await publisher.getStatus(previousId))?.status).toBe('accepted');
  });

  it.each(['direct claim', 'stale recovery'] as const)('awaits a reentrant %s completion independently of its parent worker', async (kind) => {
    const f = fixture();
    const publisher = f.create();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const innerId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'inner' }));
    const coordinator = (publisher as unknown as { claimCoordinator: AsyncLiftClaimCoordinator }).claimCoordinator;
    const journal = gate();
    f.hooks.insert = (entry) => entry.jobId === innerId && entry.kind === (kind === 'direct claim' ? 'claimed' : 'recover-reset')
      ? journal.wait() : Promise.resolve();
    let inner: ReturnType<typeof observe<unknown>> | undefined;
    const outer = coordinator.processClaim('wallet-outer', async (session) => {
      inner = observe<unknown>(kind === 'direct claim' ? publisher.claimNext('wallet-inner') : coordinator.processClaim('wallet-inner', async (nested) => {
        f.advance(5 * 60 * 1000 + 1);
        await nested.update('validated', { validation: KA_VM_VALIDATION });
        return nested.claim;
      }));
      await inner.promise;
      return session.claim;
    });
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      expect(await completesWithin(inner!.promise, 30), 'nested public completion must retain its own journal').toBe(false);
      if (kind === 'stale recovery') expect(coordinator.isProcessing(innerId)).toBe(false);
    } finally {
      journal.release(); await outer;
    }
    expect((await publisher.getStatus(innerId))?.status).toBe(kind === 'direct claim' ? 'claimed' : 'accepted');
  });

  it('retains a reentrant worker marker until that worker drains its own journal', async () => {
    const f = fixture();
    const publisher = f.create();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const innerId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'inner' }));
    const coordinator = (publisher as unknown as { claimCoordinator: AsyncLiftClaimCoordinator }).claimCoordinator;
    const journal = gate();
    const handler = gate();
    f.hooks.insert = (entry) => entry.jobId === innerId && entry.kind === 'claimed' ? journal.wait() : Promise.resolve();
    let inner: ReturnType<typeof observe<AsyncLiftClaimProcessingOutcome>> | undefined;
    const outer = coordinator.processClaim('wallet-outer', async (session) => {
      inner = observe(coordinator.processClaim('wallet-inner', async (nested) => {
        await handler.wait();
        return nested.claim;
      }));
      await inner.promise;
      return session.claim;
    });
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      expect(await completesWithin(handler.reached)).toBe(true);
      handler.release();
      expect(await completesWithin(inner!.promise, 30), 'inner worker settlement must await its own journal').toBe(false);
      expect(coordinator.isProcessing(innerId)).toBe(true);
    } finally {
      handler.release(); journal.release(); await outer;
    }
    expect(coordinator.isProcessing(innerId)).toBe(false);
  });

  it('captures journal and bookkeeping facts before a handler mutates its returned claim object', async () => {
    const f = fixture();
    const publisher = f.create();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const work = vi.fn();
    publisher.reconciliationScheduling.attachScheduler({ onReconciliationDemand() {}, onWalletRelease() {}, onWorkAvailable: work });
    const journal = gate();
    f.hooks.insert = (entry) => entry.kind === 'claimed' ? journal.wait() : Promise.resolve();
    const coordinator = (publisher as unknown as { claimCoordinator: AsyncLiftClaimCoordinator }).claimCoordinator;
    const processing = coordinator.processClaim('wallet-1', async (session) => {
      // JavaScript consumers can mutate a typed return; deferred bookkeeping owns a snapshot.
      Object.assign(session.claim, { status: 'accepted' });
      return session.claim;
    });
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      expect(work).not.toHaveBeenCalled();
    } finally {
      journal.release(); await processing;
    }
    expect(work).not.toHaveBeenCalled();
    expect((await publisher.getStatus(jobId))?.status).toBe('claimed');
    expect((await publisher.readJournalByJob(jobId)).entries.map((entry) => entry.kind)).toEqual(['admission', 'claimed']);
  });

  it('revalidates direct claim handoff after a delayed journal, expiry and another publisher replacing the claim', async () => {
    const f = fixture();
    const publisher = f.create();
    const other = f.create({ journalWrites: false }, f.decoratedStore());
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const journal = gate();
    f.hooks.insert = async (entry) => { if (entry.kind === 'claimed') await journal.wait(); };
    const original = observe(publisher.claimNext('wallet-1'));
    const pending: Promise<unknown>[] = [original.promise];
    let replacement: Awaited<ReturnType<typeof other.claimNext>> = null;
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      const before = await publisher.getStatus(jobId);
      expect(before?.status).toBe('claimed');
      f.advance(5 * 60 * 1000 + 1);
      const recovery = other.recover(); pending.push(recovery);
      expect(await completesWithin(recovery), 'expired ownership must be recoverable while only auxiliary work remains').toBe(true);
      expect((await other.getStatus(jobId))?.status).toBe('accepted');
      const next = other.claimNext('wallet-1'); pending.push(next);
      expect(await completesWithin(next)).toBe(true);
      replacement = await next;
      expect(replacement?.jobId).toBe(jobId);
      expect(replacement?.claim.claimToken).not.toBe(before?.claim?.claimToken);
      expect(original.settled()).toBe(false);
    } finally {
      journal.release();
      await Promise.allSettled(pending);
    }
    await expect(original.promise).resolves.toBeNull();
    expect((await other.getStatus(jobId))?.claim?.claimToken).toBe(replacement!.claim.claimToken);
    expect(await other.claimNext('wallet-1')).toBeNull(); // old completion did not release the reused wallet
  });

  it('starts the fenced handler before journal drain but retains its process marker until all owned journals settle', async () => {
    const f = fixture();
    const journal = gate();
    const handler = gate();
    const publisher = f.create({ knowledgeAssetVmPublishHandler: {
      execute: async ({ publishOptions }) => {
        await handler.wait();
        await publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
        await publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
        return completeResult();
      },
    } });
    await stageKnowledgeAssetShareSnapshot({ store: f.store });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    f.hooks.insert = async (entry) => { if (entry.kind === 'claimed') await journal.wait(); };
    // Inspect the existing coordinator's real ownership marker; do not stub its control flow.
    const coordinator = (publisher as unknown as { claimCoordinator: AsyncLiftClaimCoordinator }).claimCoordinator;
    const processing = observe(publisher.processNext('wallet-1'));
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      expect(await completesWithin(handler.reached), 'private claim handoff must not wait out a journal lease window').toBe(true);
      expect(coordinator.isProcessing(jobId)).toBe(true);
      handler.release();
      await expect.poll(async () => (await publisher.getStatus(jobId))?.status, { timeout: 500 }).toBe('finalized');
      expect(processing.settled()).toBe(false);
      expect(coordinator.isProcessing(jobId), 'cleanup cannot outlive its completion owner').toBe(true);
    } finally {
      handler.release(); journal.release();
      await processing.promise.catch(() => {});
    }
    expect((await processing.promise)?.status).toBe('finalized');
    expect(coordinator.isProcessing(jobId)).toBe(false);
    expect((await publisher.readJournalByJob(jobId)).entries.map((entry) => entry.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('gives a late detached result its own awaited completion after processNext has returned', async () => {
    const f = fixture();
    const journal = gate();
    let finish!: (result: AsyncKnowledgeAssetVmPublishExecutionResult) => void;
    const execution = new Promise<AsyncKnowledgeAssetVmPublishExecutionResult>((resolve) => { finish = resolve; });
    const publisher = f.create({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => recoveredResolution(),
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
      knowledgeAssetVmPublishHandler: {
        execute: async ({ publishOptions }) => {
          await publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
          await publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
          return execution;
        },
      },
    });
    await stageKnowledgeAssetShareSnapshot({ store: f.store });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const nextId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'next' }));
    await publisher.processNext('wallet-1');
    f.hooks.insert = async (entry) => { if (entry.jobId === jobId && entry.kind === 'finalized') await journal.wait(); };
    finish(completeResult());
    const drain = observe(publisher.drainDetachedExecutions());
    let next: Promise<unknown> | undefined;
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
      expect(drain.settled()).toBe(false);
      next = publisher.claimNext('wallet-1');
      expect(await completesWithin(next), 'terminal journal must not retain released wallet/global ownership').toBe(true);
      expect(await next).toMatchObject({ jobId: nextId });
      expect(drain.settled()).toBe(false);
    } finally {
      journal.release(); finish(completeResult());
      await Promise.allSettled([drain.promise, ...(next ? [next] : [])]);
    }
    expect(await publisher.claimNext('wallet-1')).toBeNull();
    expect((await publisher.readJournalByJob(jobId)).entries.at(-1)?.kind).toBe('finalized');
  });

  it('runner stop drains abandoned admission promises from another decorated publisher in the same queue domain', async () => {
    const f = fixture();
    const admissionPublisher = f.create();
    const runtime = f.create({}, f.decoratedStore());
    const unrelated = fixture().create();
    const runner = new AsyncLiftRunner({ publisher: runtime, walletIds: ['wallet-1'], startPaused: true, pollIntervalMs: 60_000 });
    await runner.start();
    const journal = gate();
    f.hooks.insert = () => journal.wait();
    // The HTTP-like caller retains no active await; shutdown must find the publisher owner itself.
    const admission = observe(admissionPublisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest()));
    let stopping: Promise<void> | undefined;
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      expect((await runtime.getStatus('job-1'))?.status).toBe('accepted');
      expect(await completesWithin(unrelated.drainDetachedExecutions()), 'different stores cannot join this queue drain').toBe(true);
      stopping = runner.stop();
      expect(await completesWithin(stopping), 'stop must retain store lifetime until the other instance completion settles').toBe(false);
      expect(admission.settled()).toBe(false);
    } finally {
      journal.release();
      await Promise.allSettled([admission.promise, stopping ?? runner.stop()]);
    }
    expect((await runtime.readJournalByJob('job-1')).entries.map((entry) => entry.kind)).toEqual(['admission']);
  });
});
