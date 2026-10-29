import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { AsyncLiftWalletFunding, TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot, KA_VM_EXECUTOR_TX_HASH } from '../../../scripts/testing/ka-vm-publish.js';

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
      walletEligibility: f.funding, knowledgeAssetVmPublishHandler: { execute },
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

  it.each(['insufficient funds', 'timeout', 'nonce too low', 'already known'])(
    'retains signed history and original wallet after post-WAL %s', async (message) => {
      const f = fundingFixture();
      const store = new OxigraphStore();
      await stageKnowledgeAssetShareSnapshot({ store });
      const publisher = new TripleStoreAsyncLiftPublisher(store, {
        walletEligibility: f.funding,
        knowledgeAssetVmPublishHandler: { execute: async ({ publishOptions }) => {
          await publishOptions.onBeforeBroadcast!({ txHash: KA_VM_EXECUTOR_TX_HASH, nonce: 7, operationKind: 'create' });
          throw new Error(message);
        } },
      });
      const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const result = await publisher.processNext('a');
      expect(result?.status).toBe('broadcast');
      expect(result?.broadcast).toMatchObject({ txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'a', nonce: 7 });
      expect(await publisher.claimNext('b')).toBeNull();
      expect((await publisher.getStatus(id))?.claim?.walletId).toBe('a');
      const restarted = new TripleStoreAsyncLiftPublisher(store, { walletEligibility: f.funding });
      await restarted.recover();
      expect((await restarted.getStatus(id))?.broadcast?.txHash).toBe(KA_VM_EXECUTOR_TX_HASH);
      expect(await restarted.claimNext('a')).toBeNull();
    },
  );
});
