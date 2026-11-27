import { describe, expect, it, vi } from 'vitest';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot, KA_VM_EXECUTOR_TX_HASH } from '../../../scripts/testing/ka-vm-publish.js';
import { completeResult, completesWithin, fixture, gate, observe } from './_helpers/journal-completion.js';

describe('journal completion outside canonical publisher locks', () => {
  it.each(['MAX', 'INSERT'] as const)('settles a failed journal %s and permits the next same-lineage append', async (failure) => {
    const f = fixture();
    const publisher = f.create();
    let first = true;
    const rejectOnce = async () => {
      if (first) { first = false; throw new Error('auxiliary journal failure'); }
    };
    if (failure === 'MAX') f.hooks.read = rejectOnce;
    else f.hooks.insert = rejectOnce;
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    await expect(publisher.claimNext('wallet-1')).resolves.toMatchObject({ jobId });
    expect((await publisher.readJournalByJob(jobId)).entries.map((entry) => [entry.seq, entry.kind])).toEqual([[0, 'claimed']]);
    await publisher.drainDetachedExecutions();
  });

  it('starts an already-accepted job while another admission awaits its journal, without settling that admission', async () => {
    const f = fixture();
    const heldJournal = gate();
    const handler = gate();
    const work = vi.fn();
    const publisher = f.create({ knowledgeAssetVmPublishHandler: {
      execute: async ({ publishOptions }) => {
        await handler.wait();
        await publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
        await publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
        return completeResult();
      },
    } });
    await stageKnowledgeAssetShareSnapshot({ store: f.store });
    const first = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    publisher.reconciliationScheduling.attachScheduler({ onReconciliationDemand() {}, onWalletRelease() {}, onWorkAvailable: work });
    f.hooks.insert = async (entry) => { if (entry.jobId === 'job-2' && entry.kind === 'admission') await heldJournal.wait(); };
    const admission = observe(publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'second' })));
    let processing: Promise<unknown> | undefined;
    try {
      expect(await completesWithin(heldJournal.reached)).toBe(true);
      expect((await publisher.getStatus('job-2'))?.status).toBe('accepted');
      processing = publisher.processNext('wallet-1');
      expect(await completesWithin(handler.reached), 'a real executor must start before the unrelated journal is released').toBe(true);
      expect((await publisher.getStatus(first))?.status).toBe('validated');
      expect(admission.settled()).toBe(false);
      expect(work).not.toHaveBeenCalled();
    } finally {
      heldJournal.release(); handler.release();
      await Promise.allSettled([admission.promise, ...(processing ? [processing] : [])]);
    }
    expect(await admission.promise).toBe('job-2');
    expect(work).toHaveBeenCalledOnce();
  });

  it('does not dispatch a claimed journal while its authoritative wallet write is still inside the critical section', async () => {
    const f = fixture();
    const publisher = f.create();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const readsBefore = f.journalReads.mock.calls.length;
    const walletWrite = gate();
    f.hooks.walletWrite = () => walletWrite.wait();
    const claim = publisher.claimNext('wallet-1');
    try {
      expect(await completesWithin(walletWrite.reached)).toBe(true);
      expect((await publisher.getStatus(jobId))?.status).toBe('claimed');
      expect(f.journalReads.mock.calls.length, 'MAX must wait until canonical job and wallet ownership settle').toBe(readsBefore);
      expect(f.journalInserts.filter((entry) => entry.kind === 'claimed')).toEqual([]);
    } finally {
      walletWrite.release();
      await claim.catch(() => {});
    }
    expect((await claim)?.jobId).toBe(jobId);
    expect(f.journalInserts.filter((entry) => entry.kind === 'claimed')).toHaveLength(1);
  });

  it('joins a cross-instance duplicate after the original job advanced, while preserving same-lineage journal FIFO', async () => {
    const f = fixture();
    const admissionPublisher = f.create();
    const runtime = f.create({}, f.decoratedStore());
    const heldJournal = gate();
    f.hooks.insert = async (entry) => { if (entry.jobId === 'job-1' && entry.kind === 'admission') await heldJournal.wait(); };
    const admission = observe(admissionPublisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest()));
    const pending: Promise<unknown>[] = [admission.promise];
    let duplicate: ReturnType<typeof observe<string>> | undefined;
    try {
      expect(await completesWithin(heldJournal.reached)).toBe(true);
      const claim = runtime.claimNext('wallet-1'); pending.push(claim);
      await expect.poll(() => f.walletWrites.mock.calls.length, { timeout: 500 }).toBe(1);
      expect((await runtime.getStatus('job-1'))?.status).toBe('claimed');
      expect(f.journalReads).toHaveBeenCalledOnce(); // claimed cannot allocate before admission insert settles
      duplicate = observe(runtime.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest()));
      pending.push(duplicate.promise);
      const unrelated = runtime.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'unrelated' }));
      pending.push(unrelated);
      expect(await completesWithin(unrelated), 'a duplicate join must release the global lock before awaiting its predecessor').toBe(true);
      expect(await unrelated).toBe('job-2');
      expect(admission.settled()).toBe(false);
      expect(duplicate.settled()).toBe(false);
    } finally {
      heldJournal.release();
      await Promise.allSettled(pending);
    }
    expect(await duplicate!.promise).toBe('job-1');
    expect((await runtime.readJournalByJob('job-1')).entries.map((entry) => [entry.seq, entry.kind])).toEqual([[0, 'admission'], [1, 'claimed']]);
    expect(f.journalInserts.filter((entry) => entry.jobId === 'job-1' && entry.kind === 'admission')).toHaveLength(1);
  });

  it('drains a successful primary journal after wallet persistence fails, preserving the wallet error identity', async () => {
    const f = fixture();
    const publisher = f.create();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const journal = gate();
    const walletFailure = new Error('wallet ownership write rejected');
    const attemptedWallet = vi.fn();
    f.hooks.walletWrite = async () => { attemptedWallet(); throw walletFailure; };
    f.hooks.insert = async (entry) => { if (entry.kind === 'claimed') await journal.wait(); };
    const claiming = observe(publisher.claimNext('wallet-1'));
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      expect(attemptedWallet, 'authoritative work must settle before journal dispatch, including errors').toHaveBeenCalledOnce();
      expect((await publisher.getStatus(jobId))?.status).toBe('claimed');
      expect(claiming.settled()).toBe(false);
    } finally {
      journal.release();
      await claiming.promise.catch(() => {});
    }
    await expect(claiming.promise).rejects.toBe(walletFailure);
    expect((await publisher.readJournalByJob(jobId)).entries.map((entry) => entry.kind)).toEqual(['admission', 'claimed']);
  });
});
