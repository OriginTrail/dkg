import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { AsyncLiftRunner, AsyncLiftWalletFunding, LiftJobPendingChainProofError, TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot, KA_VM_EXECUTOR_TX_HASH, KA_VM_VALIDATION, KA_VM_KA_UAL } from '../../../scripts/testing/ka-vm-publish.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import { DEFAULT_CONTROL_GRAPH_URI, jobSubject, serializeJob } from '../src/async-lift-control-plane.js';
import { isHeldForChainProof } from '../src/async-lift-retry-disposition.js';

function fundingFixture() {
  let now = Date.now();
  const balances = new Map([['a', 10n], ['b', 10n]]);
  const readers = new Map([...balances.keys()].map((id) => [id, vi.fn(async () => ({
    observedAt: now, balanceWei: balances.get(id)!, requiredWei: 2n, gasLimit: 1n, feePerGasWei: 2n,
  }))]));
  const funding = new AsyncLiftWalletFunding(readers, () => now);
  return { funding, balances, readers, advance: (ms: number) => { now += ms; } };
}

describe('async publisher gas eligibility (#3591)', () => {
  it('the real runner revisits a replenished later wallet and claims the retained job without enqueue', async () => {
    vi.useFakeTimers();
    const f = fundingFixture();
    const store = new OxigraphStore();
    const used: string[] = [];
    await stageKnowledgeAssetShareSnapshot({ store });
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      walletEligibility: f.funding, fundingRecoveryPolicy: 'proof-first',
      knowledgeAssetVmPublishHandler: { execute: async ({ walletId }) => {
        used.push(walletId); throw new Error('Stop this claim-only fixture before any send');
      } },
    });
    const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    f.balances.set('a', 0n); f.balances.set('b', 0n);
    const runner = new AsyncLiftRunner({ publisher, walletIds: ['a', 'b'] });
    try {
      await runner.start(); await vi.advanceTimersByTimeAsync(100);
      expect((await publisher.getStatus(id))?.status).toBe('accepted');
      expect(used).toEqual([]);
      f.balances.set('b', 10n); f.advance(30_000);
      await vi.advanceTimersByTimeAsync(32_000);
      expect(used).toEqual(['b']);
      expect((await publisher.getStatus(id))?.jobId).toBe(id);
      expect((await publisher.getStatus(id))?.claim?.walletId).toBe('b');
    } finally { await runner.stop(); vi.useRealTimers(); await store.close(); }
  });

  it.each([undefined, 'legacy', 'proof-first'] as const)(
    'durable recovery policy %s is explicit and independent of installed eligibility', async (policy) => {
      for (const recorded of [false, true]) {
        const f = fundingFixture();
        const store = new OxigraphStore();
        await stageKnowledgeAssetShareSnapshot({ store });
        const publisher = new TripleStoreAsyncLiftPublisher(store, {
          walletEligibility: f.funding, fundingRecoveryPolicy: policy,
          knowledgeAssetVmPublishHandler: { execute: async ({ publishOptions }) => {
            if (recorded) await publishOptions.onBeforeBroadcast!({ txHash: KA_VM_EXECUTOR_TX_HASH, nonce: 8, operationKind: 'create' });
            throw new Error('insufficient funds');
          } },
        });
        const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
        const result = await publisher.processNext('a');
        expect(result?.jobId).toBe(id);
        expect(result?.status).toBe(policy === 'proof-first' ? recorded ? 'broadcast' : 'accepted' : 'failed');
        if (recorded) expect(result?.broadcast?.txHash).toBe(KA_VM_EXECUTOR_TX_HASH);
        await store.close();
      }
    },
  );
  it('paces one/all underfunded wallets and observes replenishment', async () => {
    const f = fundingFixture();
    f.balances.set('a', 1n);
    expect(await f.funding.prepare('a')).toBe(false);
    expect(await f.funding.prepare('b')).toBe(true);
    f.balances.set('b', 0n);
    expect(await f.funding.prepare('b')).toBe(false);
    f.balances.set('a', 10n);
    expect(await f.funding.prepare('a')).toBe(false);
    expect(f.readers.get('a')).toHaveBeenCalledTimes(1);
    f.advance(30_000);
    expect(await f.funding.prepare('a')).toBe(true);
    expect(f.funding.snapshot().find((s) => s.walletId === 'a')?.reason).toBe('eligible');
  });

  it('rejects stale observations and RPC errors without calling them insufficient funds', async () => {
    const f = fundingFixture();
    f.readers.get('a')!.mockRejectedValueOnce(new Error('private endpoint credentials'));
    expect(await f.funding.prepare('a')).toBe(false);
    expect(f.funding.snapshot()[0]?.reason).toBe('funding-unavailable');
    expect(JSON.stringify(f.funding.snapshot())).not.toContain('private');
    expect(await f.funding.prepare('b')).toBe(true);
    f.advance(5_001);
    expect(f.funding.isEligible('b')).toBe(false);
    expect(await f.funding.prepare('b')).toBe(true);
  });

  it('coalesces concurrent observations and never lets an older read undo a cooldown', async () => {
    const f = fundingFixture();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const read = f.readers.get('a')!.getMockImplementation()!;
    f.readers.get('a')!.mockImplementation(async () => { await wait; return read(); });
    const one = f.funding.prepare('a');
    const two = f.funding.prepare('a');
    f.funding.defer('a');
    finish();
    expect(await Promise.all([one, two])).toEqual([false, false]);
    expect(f.readers.get('a')).toHaveBeenCalledTimes(1);
    expect(f.funding.snapshot()[0]?.reason).toBe('funding-cooldown');
  });

  it('keeps all-ineligible work accepted, then claims it under the same ID after replenishment', async () => {
    const f = fundingFixture();
    const store = new OxigraphStore();
    await stageKnowledgeAssetShareSnapshot({ store });
    const publisher = new TripleStoreAsyncLiftPublisher(store, { walletEligibility: f.funding });
    const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    f.balances.set('a', 0n); f.balances.set('b', 0n);
    expect(await publisher.claimNext('a')).toBeNull();
    expect(await publisher.processNext('b')).toBeNull();
    expect((await publisher.getStatus(id))?.status).toBe('accepted');
    f.balances.set('b', 10n); f.advance(30_000);
    expect((await publisher.claimNext('b'))?.jobId).toBe(id);
    expect(await publisher.claimNext('b')).toBeNull();
  });

  it('requeues a proven pre-dispatch funding race without changing logical identity', async () => {
    const f = fundingFixture();
    const store = new OxigraphStore();
    await stageKnowledgeAssetShareSnapshot({ store });
    const execute = vi.fn(async () => { throw new Error('insufficient funds for gas * price + value'); });
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      walletEligibility: f.funding, fundingRecoveryPolicy: 'proof-first', knowledgeAssetVmPublishHandler: { execute },
    });
    const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const original = await publisher.getStatus(id);
    const result = await publisher.processNext('a');
    expect(result?.status).toBe('accepted');
    expect(result?.jobId).toBe(id);
    expect(result?.request).toEqual(original?.request);
    expect(result?.timestamps.acceptedAt).toBe(original?.timestamps.acceptedAt);
    expect(await publisher.processNext('a')).toBeNull();
    expect((await publisher.claimNext('b'))?.jobId).toBe(id);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('preserves and holds an inherited hash when a later pre-dispatch attempt lacks funds', async () => {
    const f = fundingFixture();
    const store = new OxigraphStore();
    await stageKnowledgeAssetShareSnapshot({ store });
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      walletEligibility: f.funding, fundingRecoveryPolicy: 'proof-first',
    });
    const request = kaVmPublishRequest();
    const id = await publisher.enqueueKnowledgeAssetVmPublish(request);
    const claim = await publisher.claimNext('a');
    if (!claim) throw new Error('Expected claim');
    await publisher.openClaimSession(claim).update('validated', { validation: KA_VM_VALIDATION });
    const current = await publisher.getStatus(id);
    if (!current || current.status !== 'validated') throw new Error('Expected validated job');
    const inherited = { ...current, recovery: {
      action: 'reset_to_accepted' as const, recoveredFromStatus: 'broadcast' as const,
      txHashChecked: KA_VM_EXECUTOR_TX_HASH, walletIdChecked: 'a', nonceChecked: 4, operationKind: 'create' as const,
    } };
    await store.deleteByPattern({ subject: jobSubject(id), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(serializeJob(inherited, DEFAULT_CONTROL_GRAPH_URI));
    const failed = await publisher.openClaimSession(claim).recordExecutionFailure(
      'broadcast', new Error('insufficient funds'), { neverDispatched: true },
    );
    expect(failed.status).toBe('failed');
    expect(failed.recovery?.txHashChecked).toBe(KA_VM_EXECUTOR_TX_HASH);
    expect(isHeldForChainProof(failed)).toBe(true);
    expect((await publisher.retryDetailed()).blockedPendingRecovery).toBe(1);
    await expect(publisher.enqueueKnowledgeAssetVmPublish(request)).rejects.toThrow(LiftJobPendingChainProofError);
  });

  it.each([false, true])('raw execution uses the same explicit funding disposition (WAL recorded: %s)', async (recorded) => {
    const f = fundingFixture();
    const store = new OxigraphStore();
    await stageKnowledgeAssetShareSnapshot({ store });
    const id = await seedLegacyRawLiftTestJob(store, {
      swmId: 'swm-1', namespace: 'default', contextGraphId: 'music-social', shareOperationId: 'share-op-1',
      roots: [], contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: KA_VM_KA_UAL,
      assertionVersion: '1', publicTripleCount: 2, privateTripleCount: 0, scope: 'full',
      transitionType: 'CREATE', authority: { type: 'owner', proofRef: 'proof:owner:1' },
    });
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      walletEligibility: f.funding, fundingRecoveryPolicy: 'proof-first',
      publishExecutor: async ({ publishOptions }) => {
        if (recorded) await publishOptions.onBeforeBroadcast!({ txHash: KA_VM_EXECUTOR_TX_HASH, nonce: 7, operationKind: 'create' });
        throw new Error('insufficient funds');
      },
    });
    const job = await publisher.processNext('a');
    expect(job?.jobId).toBe(id);
    expect(job?.status).toBe(recorded ? 'broadcast' : 'accepted');
    if (recorded) expect(job?.broadcast?.txHash).toBe(KA_VM_EXECUTOR_TX_HASH);
  });

  it.each(['insufficient funds', 'timeout', 'nonce too low', 'already known'])(
    'retains signed history and original wallet after post-WAL %s', async (message) => {
      const f = fundingFixture();
      const store = new OxigraphStore();
      await stageKnowledgeAssetShareSnapshot({ store });
      const publisher = new TripleStoreAsyncLiftPublisher(store, {
        walletEligibility: f.funding, fundingRecoveryPolicy: 'proof-first',
        knowledgeAssetVmPublishHandler: { execute: async ({ publishOptions }) => {
          await publishOptions.onBeforeBroadcast!({ txHash: KA_VM_EXECUTOR_TX_HASH, nonce: 7, operationKind: 'create' });
          throw new Error(message);
        } },
      });
      const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const result = await publisher.processNext('a');
      expect(result?.status).toBe('broadcast');
      expect(result?.broadcast).toMatchObject({ txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'a', nonce: 7 });
      expect((await publisher.getStatus(id))?.claim?.walletId).toBe('a');
      const waiting = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
        name: 'waiting', shareOperationId: 'waiting-op', intentKey: `sha256:${'cd'.repeat(32)}`,
      }));
      f.advance(30_001);
      expect(await publisher.claimNext('a')).toBeNull();
      expect((await publisher.getStatus(waiting))?.status).toBe('accepted');
      const fresh = fundingFixture();
      const restarted = new TripleStoreAsyncLiftPublisher(store, { walletEligibility: fresh.funding, fundingRecoveryPolicy: 'proof-first' });
      await restarted.recover();
      expect((await restarted.getStatus(id))?.broadcast?.txHash).toBe(KA_VM_EXECUTOR_TX_HASH);
      expect(await restarted.claimNext('a')).toBeNull();
      expect((await restarted.claimNext('b'))?.jobId).toBe(waiting);
    },
  );
});
