/**
 * #3591 — funding-aware claims and the retry after a top-up, through a real publisher.
 *
 * A wallet the chain refuses for funds takes no further claims. The refused job is proven
 * ineffective (the node turned its transaction away before the mempool), so the publisher retries
 * it by itself, and a wallet that can pay claims it; while none can, it waits as `accepted`. A job
 * whose transaction may have been sent keeps its wallet and its hold throughout, across a restart.
 */
import { describe, expect, it } from 'vitest';
import { NO_FUNDED_PUBLISHER_WALLET_CODE } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { QuorumUnmetError, TripleStoreAsyncLiftPublisher, type AsyncLiftPublisherConfig } from '../src/index.js';
import { isHeldForChainProof } from '../src/async-lift-retry-disposition.js';
import type { PersistedFailedJob } from '../src/async-lift-publisher-utils.js';
import { WALLET_FUNDING_COOLDOWN_BASE_MS } from '../src/async-lift-wallet-funding.js';
import { KA_VM_EXECUTOR_TX_HASH, kaVmPublishRequest, stageKnowledgeAssetShareSnapshot } from '../../../scripts/testing/ka-vm-publish.js';
import { completeResult } from './_helpers/journal-completion.js';

/** What a publication costs unless a test prices it otherwise; the node states it when it refuses. */
const COST = 2_047n;
const RETRY_MS = 10;

function fixture(store = new OxigraphStore()) {
  const clock = { now: 1_000 };
  const balances = new Map<string, bigint>();
  /** Publication costs by request name. */
  const costs = new Map<string, bigint>();
  /** What each wallet's Publishing Conviction Account can still cover. */
  const coverage = new Map<string, bigint>();
  /** Wallets with no TRAC of their own: the adapter finds them unfundable before signing unless an account covers them. */
  const tracShort = new Set<string>();
  /** Wallets that reached the executor, in order: a claim that was never made never signs. */
  const signed: string[] = [];
  /** Errors the next executions throw before signing anything. */
  const beforeSigning: unknown[] = [];
  /** Wallets whose next send is ambiguous: the write-ahead is recorded, then the RPC times out. */
  const ambiguous = new Set<string>();
  let refusedTx = 0;
  let ids = 0;
  const handler: NonNullable<AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler']> = {
    execute: async ({ walletId, request, publishOptions }) => {
      signed.push(walletId);
      const early = beforeSigning.shift();
      if (early !== undefined) throw early;
      if (tracShort.has(walletId) && (coverage.get(walletId) ?? 0n) === 0n) {
        throw Object.assign(new Error('No operational wallet has enough funds to publish'), { code: NO_FUNDED_PUBLISHER_WALLET_CODE });
      }
      const cost = costs.get(request.name) ?? COST;
      const covered = (balances.get(walletId) ?? 0n) >= cost;
      const txHash = covered ? KA_VM_EXECUTOR_TX_HASH : (`0x${(++refusedTx).toString(16).padStart(64, 'a')}` as `0x${string}`);
      await publishOptions.onBeforeBroadcast?.({ txHash, operationKind: 'create' });
      if (ambiguous.delete(walletId)) throw new Error('ETIMEDOUT: request timed out');
      // The node turns away what the wallet cannot pay for, before the mempool, and says why.
      if (!covered) {
        throw new Error(`insufficient funds for gas * price + value: address 0x00000000000000000000000000000000000000a1 have ${balances.get(walletId) ?? 0n} want ${cost}`);
      }
      await publishOptions.onBroadcastAccepted?.({ txHash, operationKind: 'create' });
      return completeResult();
    },
  };
  return {
    store,
    clock,
    signed,
    beforeSigning,
    ambiguous,
    tracShort,
    fund: (walletId: string, wei: bigint) => { balances.set(walletId, wei); },
    cover: (walletId: string, wei: bigint) => { coverage.set(walletId, wei); },
    price: (name: string, wei: bigint) => { costs.set(name, wei); },
    publisher: () => new TripleStoreAsyncLiftPublisher(store, {
      now: () => clock.now,
      idGenerator: () => `job-${++ids}`,
      retryBackoffBaseMs: RETRY_MS,
      retryBackoffMaxMs: RETRY_MS,
      retryJitterRatio: 0,
      knowledgeAssetVmPublishHandler: handler,
      walletBalanceReader: async (walletId) => ({
        native: balances.get(walletId) ?? 0n,
        trac: tracShort.has(walletId) ? 0n : null,
        pca: coverage.get(walletId) ?? 0n,
      }),
    }),
  };
}

/** Let a balance reading the claim started land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function refuseOn(f: ReturnType<typeof fixture>, publisher: TripleStoreAsyncLiftPublisher, walletId: string, name: string) {
  const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name }));
  const refused = await publisher.processNext(walletId);
  expect(refused?.jobId).toBe(jobId);
  expect(refused?.status).toBe('failed');
  return { jobId, refused: refused as PersistedFailedJob };
}

describe('funding-aware claims and retry after a top-up (#3591)', () => {
  it('retries a refused job by itself, on a wallet that can pay, and the refused wallet claims nothing more', async () => {
    const f = fixture();
    f.fund('short', 1_907n);
    f.fund('funded', 10_000n);
    const publisher = f.publisher();
    await stageKnowledgeAssetShareSnapshot({ store: f.store });

    const { jobId, refused } = await refuseOn(f, publisher, 'short', 'refused');
    expect(refused.failure).toMatchObject({ code: 'insufficient_funds', retryable: true, resolution: 'reset_to_accepted' });
    // Proven ineffective: the refused transaction holds nothing, and the retry is scheduled.
    expect(refused.broadcast?.txHash).toBeDefined();
    expect(isHeldForChainProof(refused)).toBe(false);
    expect(refused.timestamps.nextRetryAt).toBe(f.clock.now + RETRY_MS);
    expect(publisher.describeConfiguredRetryState(refused)).toMatchObject({ autoRetryEligible: true, waitingReason: 'backoff' });

    f.clock.now += RETRY_MS;
    // The sweep reaccepts the due retry, but the refused wallet does not claim it.
    expect(await publisher.processNext('short')).toBeNull();
    const waiting = await publisher.getStatus(jobId);
    expect(waiting?.status).toBe('accepted');
    // The refused hash travels on, accounted for: the refusal proved it can never take effect.
    expect(waiting?.recovery).toMatchObject({ txHashChecked: refused.broadcast!.txHash, txHashAccounted: true });

    // Another wallet claims it at once: the refused wallet's stated cost was that wallet's own.
    const done = await publisher.processNext('funded');
    expect(done).toMatchObject({ jobId, status: 'finalized', claim: { walletId: 'funded' } });
    expect(f.signed).toEqual(['short', 'funded']);
  });

  it('keeps the retried job accepted while no wallet can pay, and proceeds after a top-up', async () => {
    const f = fixture();
    f.fund('short-a', 1_907n);
    f.fund('short-b', 1_000n);
    const publisher = f.publisher();
    await stageKnowledgeAssetShareSnapshot({ store: f.store });
    const { jobId } = await refuseOn(f, publisher, 'short-a', 'waiting');

    // The retry goes to the other wallet, which is refused as well.
    f.clock.now += RETRY_MS;
    expect(await publisher.processNext('short-a')).toBeNull();
    expect(await publisher.processNext('short-b')).toMatchObject({ jobId, status: 'failed', failure: { code: 'insufficient_funds' } });
    // Both are out now: the next retry waits as accepted, and neither wallet claims it.
    f.clock.now += RETRY_MS;
    expect(await publisher.processNext('short-a')).toBeNull();
    expect(await publisher.processNext('short-b')).toBeNull();
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    expect(f.signed).toEqual(['short-a', 'short-b']);

    // Topped up: after its cooldown the wallet reads its balance again and claims.
    f.fund('short-b', 5_000n);
    f.clock.now += WALLET_FUNDING_COOLDOWN_BASE_MS;
    expect(await publisher.processNext('short-b')).toBeNull();
    await settle();
    expect(await publisher.processNext('short-b')).toMatchObject({ jobId, status: 'finalized', claim: { walletId: 'short-b' } });
    expect(f.signed).toEqual(['short-a', 'short-b', 'short-b']);
  });

  it('lets a cheaper job proceed on a smaller wallet after an expensive job was refused', async () => {
    const f = fixture();
    f.fund('short', 1_907n);
    f.fund('small', 500n);
    f.price('cheap', 100n);
    const publisher = f.publisher();
    await stageKnowledgeAssetShareSnapshot({ store: f.store });
    await refuseOn(f, publisher, 'short', 'expensive');

    // The node stated 2047 for the expensive transaction. That is no minimum for other wallets.
    const cheap = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'cheap' }));
    expect(await publisher.processNext('small')).toMatchObject({ jobId: cheap, status: 'finalized', claim: { walletId: 'small' } });
    expect(f.signed).toEqual(['short', 'small']);
  });

  it('lets a wallet refused before signing back once a Publishing Conviction Account covers it, with no transfer to the wallet', async () => {
    const f = fixture();
    f.fund('agent', 10_000n);
    f.tracShort.add('agent');
    const publisher = f.publisher();
    await stageKnowledgeAssetShareSnapshot({ store: f.store });
    const { jobId, refused } = await refuseOn(f, publisher, 'agent', 'pca');
    // Refused before signing, with no stated cost: nothing was broadcast.
    expect(refused.failure.code).toBe('insufficient_funds');
    expect(refused.broadcast).toBeUndefined();

    f.clock.now += RETRY_MS;
    expect(await publisher.processNext('agent')).toBeNull();
    await settle();
    f.clock.now += WALLET_FUNDING_COOLDOWN_BASE_MS;
    expect(await publisher.processNext('agent')).toBeNull();
    await settle();
    expect(await publisher.processNext('agent')).toBeNull();
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');

    // The wallet is registered for a funded account: neither of its balances changes.
    f.cover('agent', 500n);
    f.clock.now += 2 * WALLET_FUNDING_COOLDOWN_BASE_MS;
    expect(await publisher.processNext('agent')).toBeNull();
    await settle();
    expect(await publisher.processNext('agent')).toMatchObject({ jobId, status: 'finalized', claim: { walletId: 'agent' } });
    expect(f.signed).toEqual(['agent', 'agent']);
  });

  it('after a top-up, the refused job proceeds while an ambiguous one keeps its wallet and its hold, across a restart', async () => {
    const f = fixture();
    f.fund('short', 1_907n);
    f.fund('sender', 10_000n);
    f.ambiguous.add('sender');
    const before = f.publisher();
    await stageKnowledgeAssetShareSnapshot({ store: f.store });

    const ambiguousJob = await before.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'ambiguous' }));
    expect(await before.processNext('sender')).toMatchObject({ jobId: ambiguousJob, status: 'broadcast' });
    const { jobId } = await refuseOn(f, before, 'short', 'refused');

    // Restart: a new publisher over the same store keeps nothing in memory. The retry schedule and
    // the hold are in the store.
    f.fund('short', 10_000n);
    f.clock.now += RETRY_MS;
    const after = f.publisher();
    const done = await after.processNext('short');
    expect(done).toMatchObject({ jobId, status: 'finalized', claim: { walletId: 'short' } });
    // The ambiguous job still owns its wallet and is still waiting for chain proof.
    expect(await after.processNext('sender')).toBeNull();
    expect(await after.getStatus(ambiguousJob)).toMatchObject({ status: 'broadcast', claim: { walletId: 'sender' } });
    expect(f.signed).toEqual(['sender', 'short', 'short']);
  });

  it('does not hold a re-run that fails before signing on the refused transaction', async () => {
    const f = fixture();
    f.fund('short', 1_907n);
    f.fund('funded', 10_000n);
    const publisher = f.publisher();
    await stageKnowledgeAssetShareSnapshot({ store: f.store });
    const { jobId } = await refuseOn(f, publisher, 'short', 'rerun');

    f.clock.now += RETRY_MS;
    expect(await publisher.processNext('short')).toBeNull();
    f.beforeSigning.push(new QuorumUnmetError({ collected: 2, required: 3, dialled: 2 }));
    const failed = await publisher.processNext('funded') as PersistedFailedJob;
    expect(failed).toMatchObject({ jobId, status: 'failed', failure: { code: 'quorum_unmet' } });
    expect(failed.broadcast).toBeUndefined();
    expect(isHeldForChainProof(failed)).toBe(false);
    expect(publisher.describeConfiguredRetryState(failed)).toMatchObject({ autoRetryEligible: true, waitingReason: 'backoff' });

    // Its own retry keeps the inherited hash accounted, so it can never be held on it later either.
    f.clock.now += RETRY_MS;
    expect(await publisher.processNext('short')).toBeNull();
    expect(await publisher.getStatus(jobId)).toMatchObject({
      status: 'accepted',
      recovery: { txHashChecked: failed.recovery!.txHashChecked, txHashAccounted: true },
    });
  });
});
