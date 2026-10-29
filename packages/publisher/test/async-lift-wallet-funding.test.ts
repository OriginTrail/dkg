import { describe, expect, it, vi } from 'vitest';
import { InsufficientPublisherFundsError, PublisherGasFundingError } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { AsyncLiftRunner, AsyncLiftWalletFunding, LiftJobPendingChainProofError, TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot, KA_VM_EXECUTOR_TX_HASH, KA_VM_VALIDATION, KA_VM_KA_UAL } from '../../../scripts/testing/ka-vm-publish.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import { DEFAULT_CONTROL_GRAPH_URI, jobSubject, serializeJob } from '../src/async-lift-control-plane.js';
import { completeResult, gate } from './_helpers/journal-completion.js';
import { isHeldForChainProof } from '../src/async-lift-retry-disposition.js';

function fundingFixture() {
  let now = Date.now();
  const balances = new Map([['a', 10n], ['b', 10n]]);
  const readers = new Map([...balances.keys()].map((id) => [id, vi.fn(async () => ({
    observedAt: now, balanceWei: balances.get(id)!, requiredWei: 2n, gasLimit: 1n, feePerGasWei: 2n,
  }))]));
  const funding = new AsyncLiftWalletFunding(readers, () => now);
  return { funding, balances, readers, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('async publisher gas eligibility (#3591)', () => {
  it('refreshes an eligible later wallet after an earlier preparation exceeds observation freshness', async () => {
    vi.useFakeTimers();
    const store = new OxigraphStore();
    await stageKnowledgeAssetShareSnapshot({ store });
    const used: string[] = [];
    const readB = vi.fn(async () => ({ observedAt: Date.now(), balanceWei: 10n, requiredWei: 2n, gasLimit: 1n, feePerGasWei: 2n }));
    const funding = new AsyncLiftWalletFunding(new Map([
      ['a', async () => {
        const observedAt = Date.now(); await new Promise((resolve) => setTimeout(resolve, 6000));
        return { observedAt, balanceWei: 0n, requiredWei: 2n, gasLimit: 1n, feePerGasWei: 2n };
      }], ['b', readB],
    ]));
    const publisher = new TripleStoreAsyncLiftPublisher(store, { walletEligibility: funding,
      knowledgeAssetVmPublishHandler: { execute: async ({ walletId }) => {
        used.push(walletId); throw new Error('End the claim-only fixture before signing');
      } },
    });
    const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const runner = new AsyncLiftRunner({ publisher, walletIds: ['a', 'b'] });
    try {
      await runner.start(); await vi.advanceTimersByTimeAsync(6100);
      expect(used).toEqual(['b']);
      expect(readB.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect((await publisher.getStatus(id))?.claim?.walletId).toBe('b');
    } finally {
      const stopping = runner.stop(); await vi.advanceTimersByTimeAsync(6000); await stopping;
      vi.useRealTimers(); await store.close();
    }
  });

  it('coalesces lightweight availability reads and suppresses funding RPCs on an empty queue', async () => {
    const f = fundingFixture(), store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store, { walletEligibility: f.funding });
    const query = vi.spyOn(store, 'query');
    const prepare = () => Promise.all(['a', 'b', 'a', 'b', 'a', 'b'].map((id) => publisher.claimScheduling.prepare(id)));
    expect(await prepare()).toEqual([null, null, null, null, null, null]);
    expect(f.readers.get('a')).not.toHaveBeenCalled(); expect(f.readers.get('b')).not.toHaveBeenCalled();
    expect(query.mock.calls.filter(([, options]) => options?.source === 'publisher.asyncLift.hasRunnableWork')).toHaveLength(1);
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest()); query.mockClear();
    const attempts = await prepare();
    expect(attempts.every((attempt) => attempt !== null)).toBe(true);
    expect(query.mock.calls.filter(([, options]) => options?.source === 'publisher.asyncLift.hasRunnableWork')).toHaveLength(1);
    expect(query.mock.calls.some(([sparql]) => sparql.includes('SELECT ?payload'))).toBe(false);
    await store.close();
  });

  it('availability detects due retry work but leaves promotion to the canonical claim path', async () => {
    const f = fundingFixture(), store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      walletEligibility: f.funding, now: f.now, retryBackoffBaseMs: 10, retryBackoffMaxMs: 10, retryJitterRatio: 0,
    });
    const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claim = await publisher.claimNext('a');
    if (!claim) throw new Error('Expected original claim');
    await publisher.openClaimSession(claim).recordExecutionFailure('claimed',
      Object.assign(new Error('Corrupt workspace head'), { code: 'KA_WORKSPACE_HEAD_CORRUPT' }));
    expect(await publisher.claimScheduling.prepare('b')).toBeNull();
    f.advance(11);
    const prepared = await publisher.claimScheduling.prepare('b');
    expect(prepared).not.toBeNull();
    expect((await publisher.getStatus(id))?.status).toBe('failed');
    expect((await publisher.claimNext('b'))?.jobId).toBe(id);
    await store.close();
  });
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
            throw new Error('insufficient funds for gas * price + value');
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
  it('leaves a job-specific TRAC shortfall failed so a later affordable job completes', async () => {
    const f = fundingFixture(), store = new OxigraphStore();
    await stageKnowledgeAssetShareSnapshot({ store });
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      walletEligibility: f.funding, fundingRecoveryPolicy: 'proof-first', now: f.now,
      knowledgeAssetVmPublishHandler: { execute: async ({ request, publishOptions }) => {
        if (request.name === 'expensive') throw new InsufficientPublisherFundsError('No funded publisher wallet', [
          { address: 'a', nativeWei: 10n ** 18n, tracWei: 5n },
        ], { cause: Object.assign(new Error('ERC20InsufficientBalance'), { code: 'CALL_EXCEPTION' }) });
        await publishOptions.onBeforeBroadcast!({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
        return completeResult();
      } },
    });
    try {
      const expensive = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'expensive' }));
      f.advance(1);
      const affordable = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'affordable' }));
      const failed = await publisher.processNext('a');
      expect(failed?.jobId).toBe(expensive);
      expect(failed?.status).toBe('failed');
      expect(failed?.failure?.code).toBe('insufficient_funds');
      expect(f.funding.isEligible('a')).toBe(true);
      f.advance(30_001);
      const completed = await publisher.processNext('a');
      expect(completed?.jobId).toBe(affordable);
      expect(completed?.status).toBe('finalized');
      expect((await publisher.getStatus(expensive))?.status).toBe('failed');
    } finally { await store.close(); }
  });

  it('does not persist claim ownership if funding expires during candidate selection', async () => {
    const f = fundingFixture(), store = new OxigraphStore(), selection = gate();
    const publisher = new TripleStoreAsyncLiftPublisher(store, { walletEligibility: f.funding, now: f.now });
    const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const query = store.query.bind(store);
    let hold = true;
    vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      if (hold && options?.source === 'publisher.asyncLift.claimCandidates') { hold = false; await selection.wait(); }
      return query(sparql, options);
    });
    const claiming = publisher.claimNext('a');
    try {
      await selection.reached; f.advance(5_001); selection.release();
      expect(await claiming).toBeNull();
      expect((await publisher.getStatus(id))?.status).toBe('accepted');
      expect(await query('ASK WHERE { GRAPH <urn:dkg:publisher:wallet-locks> { ?s ?p ?o } }'))
        .toEqual({ type: 'boolean', value: false });
      expect((await publisher.claimNext('a'))?.jobId).toBe(id);
    } finally { selection.release(); await claiming; await store.close(); }
  });

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

  it.each([
    ['RPC insufficient-funds error', () => new Error('insufficient funds for gas * price + value')],
    ['selector native-floor error without a cause', () => new InsufficientPublisherFundsError('No funded publisher wallet', [], { nativeGasShortfall: true })],
    ['wrapped native RPC error', () => new InsufficientPublisherFundsError('No funded publisher wallet', [], {
      cause: Object.assign(new Error('insufficient funds for gas * price + value'), { code: 'INSUFFICIENT_FUNDS' }),
    })],
    ['native prepared-cost guard', () => new PublisherGasFundingError({
      observedAt: Date.now(), balanceWei: 0n, requiredWei: 2n, gasLimit: 1n, feePerGasWei: 2n,
    })],
  ] as const)('requeues a proven pre-dispatch funding race without changing logical identity: %s', async (_, error) => {
    const f = fundingFixture();
    const store = new OxigraphStore();
    await stageKnowledgeAssetShareSnapshot({ store });
    const execute = vi.fn(async () => { throw error(); });
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
    expect(f.funding.snapshot().find(s => s.walletId === 'a')?.reason).toBe('funding-cooldown');
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
        throw new Error('insufficient funds for gas * price + value');
      },
    });
    const job = await publisher.processNext('a');
    expect(job?.jobId).toBe(id);
    expect(job?.status).toBe(recorded ? 'broadcast' : 'accepted');
    if (recorded) expect(job?.broadcast?.txHash).toBe(KA_VM_EXECUTOR_TX_HASH);
  });

  it.each(['insufficient funds', 'timeout', 'nonce too low', 'already known',
    new InsufficientPublisherFundsError('No funded publisher wallet', [], { cause: Object.assign(new Error('insufficient funds for gas'), { code: 'INSUFFICIENT_FUNDS' }) }),
  ])(
    'retains signed history and original wallet after post-WAL %s', async (message) => {
      const f = fundingFixture();
      const store = new OxigraphStore();
      await stageKnowledgeAssetShareSnapshot({ store });
      const publisher = new TripleStoreAsyncLiftPublisher(store, {
        walletEligibility: f.funding, fundingRecoveryPolicy: 'proof-first',
        knowledgeAssetVmPublishHandler: { execute: async ({ publishOptions }) => {
          await publishOptions.onBeforeBroadcast!({ txHash: KA_VM_EXECUTOR_TX_HASH, nonce: 7, operationKind: 'create' });
          throw typeof message === 'string' ? new Error(message) : message;
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
