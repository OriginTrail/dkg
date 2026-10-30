import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/async-lift-publisher-impl.js';
import type { PublishResult } from '../src/publisher.js';
import type { AsyncKnowledgeAssetVmPublishCertifiedResult, AsyncKnowledgeAssetVmPublishExecutionResult } from '../src/index.js';
import { CONTROL_STATUS, DEFAULT_CONTROL_GRAPH_URI, DEFAULT_WALLET_LOCK_GRAPH_URI,
  jobSubject, serializeJobRecord, walletLockSubject } from '../src/async-lift-control-plane.js';
import {
  KA_VM_AUTHOR_ADDRESS, KA_VM_EXECUTOR_TX_HASH, KA_VM_KA_UAL,
  kaVmPublishRequest, kaVmRecoveryEvidence, recoveredResolution, stageKnowledgeAssetShareSnapshot,
} from '../../../scripts/testing/ka-vm-publish.js';

function completeResult(): AsyncKnowledgeAssetVmPublishCertifiedResult {
  return {
    status: 'confirmed', localFinalizationComplete: true,
    kaId: 7n, ual: KA_VM_KA_UAL, merkleRoot: new Uint8Array(32).fill(0x12), kaManifest: [],
    onChainResult: { txHash: KA_VM_EXECUTOR_TX_HASH, blockNumber: 1, blockTimestamp: 1, batchId: 7n,
      startKAId: 7n, endKAId: 7n, publisherAddress: KA_VM_AUTHOR_ADDRESS },
  };
}

async function scenario() {
  const store = new OxigraphStore();
  let finish!: (result: AsyncKnowledgeAssetVmPublishExecutionResult) => void;
  let reject!: (error: Error) => void;
  const execution = new Promise<AsyncKnowledgeAssetVmPublishExecutionResult>((resolve, fail) => { finish = resolve; reject = fail; });
  const repair = vi.fn(async () => {});
  let confirm!: () => void;
  let ids = 0;
  const publisher = new TripleStoreAsyncLiftPublisher(store, {
    idGenerator: () => `job-${++ids}`, detachReceiptReconciliation: true,
    chainProofResolver: async () => recoveredResolution(),
    knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
    knowledgeAssetVmPublishHandler: {
      execute: async ({ publishOptions }) => {
        await publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
        await publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
        confirm = () => publishOptions.onPublishConfirmed?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
        return execution;
      }, finalizeRecovered: repair,
    },
  });
  await stageKnowledgeAssetShareSnapshot({ store });
  const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
  await publisher.processNext('wallet-1');
  return { store, publisher, jobId, finish, reject, confirm, repair };
}

describe('detached local completion', () => {
  it('persists a completed executor result without replaying lifecycle recovery', async () => {
    const s = await scenario();
    s.finish(completeResult());
    await s.publisher.drainDetachedExecutions();
    expect((await s.publisher.getStatus(s.jobId))?.status).toBe('finalized');
    expect(await s.publisher.reconcileTransactions()).toBe(0);
    expect(s.repair).not.toHaveBeenCalled();
  });

  it('finishes after proof released the wallet without disturbing its next claim', async () => {
    const s = await scenario();
    s.confirm();
    await s.publisher.reconcileTransactions();
    expect((await s.publisher.getStatus(s.jobId))?.status).toBe('included');
    const nextId = await s.publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      name: 'next', shareOperationId: 'next', intentKey: `sha256:${'cd'.repeat(32)}`,
    }));
    const nextClaim = await s.publisher.claimNext('wallet-1');
    expect(nextClaim?.jobId).toBe(nextId);
    s.finish(completeResult());
    await s.publisher.drainDetachedExecutions();
    expect((await s.publisher.getStatus(s.jobId))?.status).toBe('finalized');
    // A new claim must still be exclusively owned after the older completion.
    expect(await s.publisher.claimNext('wallet-1')).toBeNull();
    await expect(s.publisher.openClaimSession(nextClaim!).update('validated', {
      validation: { canonicalRoots: [], canonicalRootMap: {}, swmQuadCount: 2,
        authorityProofRef: 'knowledge-asset-lifecycle', transitionType: 'CREATE' },
    })).resolves.toBeUndefined();
    expect((await s.publisher.getStatus(nextId))?.status).toBe('validated');
    expect(s.repair).not.toHaveBeenCalled();
  });

  it.each(['unmarked', 'tentative', 'failed', 'local', 'confirmed-no-chain', 'wrong-hash', 'malformed'])(
    'retains recovery for %s results', async (kind) => {
      const s = await scenario();
      const result: PublishResult & { localFinalizationComplete?: true } = { ...completeResult() };
      if (kind === 'unmarked') delete result.localFinalizationComplete;
      if (kind === 'tentative' || kind === 'failed') result.status = kind;
      if (kind === 'local') { result.status = 'tentative'; delete result.onChainResult; }
      if (kind === 'confirmed-no-chain') delete result.onChainResult;
      if (kind === 'wrong-hash') result.onChainResult!.txHash = `0x${'ef'.repeat(32)}`;
      if (kind === 'malformed') (result as unknown as { merkleRoot: unknown }).merkleRoot = null;
      // Untyped external executors can violate the TypeScript contract; retain runtime defenses.
      s.finish(result as unknown as AsyncKnowledgeAssetVmPublishExecutionResult);
      await s.publisher.drainDetachedExecutions();
      expect((await s.publisher.getStatus(s.jobId))?.status).toBe('broadcast');
      expect(await s.publisher.reconcileTransactions()).toBe(1);
      expect(s.repair).toHaveBeenCalledOnce();
    },
  );

  it.each(['token', 'wallet'])('rejects a late result after its claim %s changes', async (field) => {
    const s = await scenario();
    const job = await s.publisher.getStatus(s.jobId);
    if (!job || job.status !== 'broadcast') throw new Error('expected broadcast');
    const replacement = { ...job, claim: { ...job.claim,
      ...(field === 'token' ? { claimToken: 'replacement' } : { walletId: 'wallet-2' }),
    } };
    const rows = serializeJobRecord(replacement, DEFAULT_CONTROL_GRAPH_URI);
    await s.store.replaceSubject(DEFAULT_CONTROL_GRAPH_URI, jobSubject(s.jobId), rows.jobQuads);
    s.finish(completeResult());
    await s.publisher.drainDetachedExecutions();
    expect(await s.publisher.getStatus(s.jobId)).toEqual(replacement);
  });

  it('leaves a failed job untouched by a late successful executor', async () => {
    const s = await scenario();
    await s.publisher.recordPublishFailure(s.jobId, {
      error: new Error('ambiguous execution'), failedFromState: 'broadcast', errorPayloadRef: 'urn:test:failure',
    });
    const failed = await s.publisher.getStatus(s.jobId);
    s.finish(completeResult());
    await s.publisher.drainDetachedExecutions();
    expect(await s.publisher.getStatus(s.jobId)).toEqual(failed);
  });

  it('does not rewrite a job finalized before its late executor result', async () => {
    const s = await scenario();
    await s.publisher.recordPublishResult(s.jobId, completeResult());
    const finalized = await s.publisher.getStatus(s.jobId);
    expect(finalized?.status).toBe('finalized');
    const write = vi.spyOn(s.store, 'replaceSubjectAndInsert');
    s.finish(completeResult());
    await s.publisher.drainDetachedExecutions();
    expect(await s.publisher.getStatus(s.jobId)).toEqual(finalized);
    expect(write).not.toHaveBeenCalled();
    expect(s.repair).not.toHaveBeenCalled();
  });

  it('uses recovery when the detached executor rejects', async () => {
    const s = await scenario();
    s.reject(new Error('receipt polling failed'));
    await s.publisher.drainDetachedExecutions();
    expect((await s.publisher.getStatus(s.jobId))?.status).toBe('broadcast');
    expect(await s.publisher.reconcileTransactions()).toBe(1);
    expect(s.repair).toHaveBeenCalledOnce();
  });

  it('keeps ownership and drain pending while terminal persistence is in flight', async () => {
    const s = await scenario();
    let entered!: () => void;
    const atWrite = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const writeGate = new Promise<void>((resolve) => { release = resolve; });
    const replace = s.store.replaceSubjectAndInsert.bind(s.store);
    s.store.replaceSubjectAndInsert = async (...args) => {
      if (args[2].some((q) => q.predicate === CONTROL_STATUS && q.object === '"finalized"')) {
        entered();
        await writeGate;
      }
      return replace(...args);
    };
    s.finish(completeResult());
    let drained = false;
    const draining = s.publisher.drainDetachedExecutions().then(() => { drained = true; });
    try {
      await atWrite;
      expect(drained).toBe(false);
      // Recovery filters the still-owned execution before trying its transition lock.
      expect(await s.publisher.reconcileTransactions()).toBe(0);
      expect(s.repair).not.toHaveBeenCalled();
    } finally {
      release();
      await draining;
    }
    expect((await s.publisher.getStatus(s.jobId))?.status).toBe('finalized');
  });

  it('preserves chain recovery when the terminal store write fails', async () => {
    const s = await scenario();
    const replace = s.store.replaceSubjectAndInsert.bind(s.store);
    let fail = true;
    s.store.replaceSubjectAndInsert = async (...args) => {
      if (fail && args[2].some((q) => q.predicate === CONTROL_STATUS && q.object === '"finalized"')) {
        fail = false;
        throw new Error('terminal store unavailable');
      }
      return replace(...args);
    };
    s.finish(completeResult());
    await s.publisher.drainDetachedExecutions();
    expect((await s.publisher.getStatus(s.jobId))?.status).toBe('included');
    expect(await s.publisher.reconcileTransactions()).toBe(1);
    expect(s.repair).toHaveBeenCalledOnce();
    expect((await s.publisher.getStatus(s.jobId))?.status).toBe('finalized');
  });

  it('serializes a new claim with deletion after the old matching wallet-lock read', async () => {
    const s = await scenario();
    const nextId = await s.publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      name: 'next', shareOperationId: 'next', intentKey: `sha256:${'cd'.repeat(32)}`,
    }));
    let entered!: () => void;
    const atDelete = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const remove = s.store.deleteByPatternWithoutCount.bind(s.store);
    s.store.deleteByPatternWithoutCount = async (...args) => {
      if (args[0].graph === DEFAULT_WALLET_LOCK_GRAPH_URI
        && args[0].subject === walletLockSubject('wallet-1')) {
        entered();
        await gate;
      }
      return remove(...args);
    };
    s.finish(completeResult());
    await atDelete;
    let claimed = false;
    const next = s.publisher.claimNext('wallet-1').then((job) => { claimed = true; return job; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(claimed).toBe(false);
    } finally {
      release();
      await s.publisher.drainDetachedExecutions();
    }
    expect((await next)?.jobId).toBe(nextId);
    expect(await s.publisher.claimNext('wallet-1')).toBeNull();
  });
});
