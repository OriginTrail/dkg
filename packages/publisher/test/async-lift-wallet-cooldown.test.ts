import { describe, expect, it, vi } from 'vitest';
import { InsufficientPublisherFundsError, PublisherGasFundingError } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { AsyncLiftRunner, AsyncLiftWalletCooldown, LiftJobPendingChainProofError, TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot, KA_VM_EXECUTOR_TX_HASH, KA_VM_VALIDATION, KA_VM_KA_UAL } from '../../../scripts/testing/ka-vm-publish.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import { DEFAULT_CONTROL_GRAPH_URI, jobSubject, serializeJob } from '../src/async-lift-control-plane.js';
import { completeResult, gate } from './_helpers/journal-completion.js';
import { isHeldForChainProof } from '../src/async-lift-retry-disposition.js';

function fundingFixture() {
  let now = Date.now();
  const funding = new AsyncLiftWalletCooldown(['a', 'b'], () => now);
  return { funding, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('async publisher actual-job funding and cooldown (#3591)', () => {
  it('allows configured wallets immediately, and expires only actual-failure cooldowns', async () => {
    const f = fundingFixture();
    expect(await f.funding.prepare('a')).toBe(true);
    expect(await f.funding.prepare('b')).toBe(true);
    expect(await f.funding.prepare('unknown')).toBe(false);
    f.funding.defer('a');
    expect(await f.funding.prepare('a')).toBe(false);
    expect(await f.funding.prepare('b')).toBe(true);
    f.advance(29_999); expect(await f.funding.prepare('a')).toBe(false);
    f.advance(1); expect(await f.funding.prepare('a')).toBe(true);
    // No observation, top-up notification or new enqueue is needed to permit a real-job attempt.
    f.advance(60_000); expect(await f.funding.prepare('a')).toBe(true);
  });

  it('never lets clock rollback or an earlier eligibility result bypass a newer cooldown', async () => {
    const f = fundingFixture();
    expect(await f.funding.prepare('a')).toBe(true);
    f.funding.defer('a'); f.advance(10_000); f.funding.defer('a');
    f.advance(-20_000); f.funding.defer('a');
    f.advance(40_000); expect(f.funding.isEligible('a')).toBe(false);
    f.advance(10_000); expect(f.funding.isEligible('a')).toBe(true);
  });

  it('coalesces queue existence checks without decoding payloads or requiring funding reads', async () => {
    const f = fundingFixture(), store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store, { walletEligibility: f.funding });
    try {
      const query = vi.spyOn(store, 'query');
      const prepare = () => Promise.all(['a', 'b', 'a', 'b'].map(id => publisher.claimScheduling.prepare(id)));
      expect(await prepare()).toEqual([null, null, null, null]);
      expect(query.mock.calls.filter(([, options]) => options?.source === 'publisher.asyncLift.hasRunnableWork')).toHaveLength(1);
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest()); query.mockClear();
      expect((await prepare()).every(attempt => attempt !== null)).toBe(true);
      expect(query.mock.calls.filter(([, options]) => options?.source === 'publisher.asyncLift.hasRunnableWork')).toHaveLength(1);
      expect(query.mock.calls.some(([sparql]) => sparql.includes('SELECT ?payload'))).toBe(false);
    } finally { await store.close(); }
  });

  it('rechecks a newer cooldown after preparation and before writing claim ownership', async () => {
    const f = fundingFixture(), store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store, { walletEligibility: f.funding });
    try {
      const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const prepared = await publisher.claimScheduling.prepare('a');
      expect(prepared).not.toBeNull(); f.funding.defer('a');
      expect(await prepared!.process(() => {})).toBeNull();
      expect((await publisher.getStatus(id))?.status).toBe('accepted');
      expect(await store.query('ASK WHERE { GRAPH <urn:dkg:publisher:wallet-locks> { ?s ?p ?o } }'))
        .toEqual({ type: 'boolean', value: false });
      expect((await publisher.claimNext('b'))?.jobId).toBe(id);
    } finally { await store.close(); }
  });

  it('refuses a claim when a newer cooldown arrives during canonical candidate selection', async () => {
    const f = fundingFixture(), store = new OxigraphStore(), selection = gate();
    const publisher = new TripleStoreAsyncLiftPublisher(store, { walletEligibility: f.funding });
    const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const query = store.query.bind(store); let hold = true;
    vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      if (hold && options?.source === 'publisher.asyncLift.claimCandidates') {
        hold = false; await selection.wait();
      }
      return query(sparql, options);
    });
    const claiming = publisher.claimNext('a');
    try {
      await selection.reached; f.funding.defer('a'); selection.release();
      expect(await claiming).toBeNull();
      expect((await publisher.getStatus(id))?.status).toBe('accepted');
      expect(await query('ASK WHERE { GRAPH <urn:dkg:publisher:wallet-locks> { ?s ?p ?o } }'))
        .toEqual({ type: 'boolean', value: false });
      expect((await publisher.claimNext('b'))?.jobId).toBe(id);
    } finally { selection.release(); await claiming; await store.close(); }
  });

  it('the real runner retries retained all-low work and observes replenishment without a wake', async () => {
    vi.useFakeTimers();
    const store = new OxigraphStore(); await stageKnowledgeAssetShareSnapshot({ store });
    let funded = false;
    const used: string[] = [];
    const funding = new AsyncLiftWalletCooldown(['a', 'b']);
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      walletEligibility: funding, fundingRecoveryPolicy: 'proof-first',
      knowledgeAssetVmPublishHandler: { execute: async ({ walletId, publishOptions }) => {
        used.push(walletId);
        if (!funded || walletId !== 'b') throw new PublisherGasFundingError({
          observedAt: Date.now(), balanceWei: 1n, requiredWei: 2n, gasLimit: 1n, feePerGasWei: 2n,
        });
        await publishOptions.onBeforeBroadcast!({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
        return completeResult();
      } },
    });
    const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const original = await publisher.getStatus(id);
    const runner = new AsyncLiftRunner({ publisher, walletIds: ['a', 'b'], pollIntervalMs: 100 });
    try {
      await runner.start(); await vi.advanceTimersByTimeAsync(1000);
      expect(used).toEqual(['a', 'b']);
      expect((await publisher.getStatus(id))?.status).toBe('accepted');
      await vi.advanceTimersByTimeAsync(28_000); expect(used).toEqual(['a', 'b']);
      funded = true;
      await vi.advanceTimersByTimeAsync(2000);
      const job = await publisher.getStatus(id);
      expect(job?.status).toBe('finalized'); expect(job?.jobId).toBe(id);
      expect(job?.request).toEqual(original?.request);
      expect(job?.timestamps.acceptedAt).toBe(original?.timestamps.acceptedAt);
      expect(job?.broadcast?.walletId).toBe('b');
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
    expect(f.funding.isEligible('a')).toBe(false);
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
