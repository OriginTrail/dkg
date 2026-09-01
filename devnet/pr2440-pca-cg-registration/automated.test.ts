/**
 * Issue #2440 — live PCA-covered Context Graph auto-registration.
 *
 * Preconditions:
 *   pnpm run build
 *   DEVNET_ENABLE_PUBLISHER=1 DEVNET_PUBLISHER_WALLET_INDEX=1 ./scripts/devnet.sh start 6
 */
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectDevnet } from '../_bootstrap/harness.js';
import {
  drainLivePcaPublisherInitializationCleanups,
  LivePcaPublisherFixture,
  retryLivePcaPublisherInitializationCleanup,
  type FixtureAcceptedBroadcastCheckpoint,
  type FixtureInitializationCheckpoint,
  type RegistrationEvidence,
  type WaivedRegistrationEvidence,
} from './live-pca-publisher-fixture.js';

const lower = (value: string): string => value.toLowerCase();

async function expectWalletBFixtureOwnedBalanceInvariant(
  before: { native: bigint; trac: bigint },
): Promise<void> {
  const after = await LivePcaPublisherFixture.captureWalletBBalances();
  expect(after.trac).toBe(before.trac);
  // Native gas belongs to the running publisher daemon. RandomSampling and
  // other canonical maintenance may spend it concurrently with fixture setup
  // or cleanup; the fixture boundary guarantees only that the wallet remains
  // funded and that fixture transactions are never signed by wallet B.
  expect(after.native).toBeGreaterThan(0n);
}

async function settleInitializationCleanup(initializationError: object): Promise<void> {
  let cleanupError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await retryLivePcaPublisherInitializationCleanup(initializationError);
      return;
    } catch (error) {
      cleanupError = error;
      if (attempt < 3) await delay(1_000);
    }
  }

  try {
    Object.defineProperty(initializationError, 'initializationCleanupError', {
      configurable: true,
      value: cleanupError,
    });
  } catch {
    // A frozen injected error still remains the authoritative thrown value.
  }
  throw initializationError;
}

async function createLiveFixture(
  options: Parameters<typeof LivePcaPublisherFixture.create>[0] = {},
): Promise<LivePcaPublisherFixture> {
  try {
    return await LivePcaPublisherFixture.create(options);
  } catch (error) {
    if (typeof error === 'object' && error !== null) {
      await settleInitializationCleanup(error);
    }
    throw error;
  }
}

async function expectInitializationCleanup(
  checkpoint: FixtureInitializationCheckpoint,
  retainedPcaCount: bigint,
  expectsKnownPcaAccountId = retainedPcaCount > 0n,
): Promise<void> {
  const before = await LivePcaPublisherFixture.captureMutableState();
  const walletBBalancesBefore = await LivePcaPublisherFixture.captureWalletBBalances();
  expect(walletBBalancesBefore.native).toBeGreaterThan(0n);
  expect(walletBBalancesBefore.trac).toBeGreaterThan(0n);
  const supplyBefore = await LivePcaPublisherFixture.capturePcaTotalSupply();
  const initializationError = new Error(`injected ${checkpoint} failure`);
  let fixtureDir = '';
  let fixtureId = '';
  let pcaAccountId = 0n;

  try {
    await expect(createLiveFixture({
      initializationFault: {
        checkpoint,
        error: initializationError,
        onReached: (context) => {
          ({ fixtureDir, fixtureId, pcaAccountId } = context);
        },
      },
    })).rejects.toBe(initializationError);
  } finally {
    await settleInitializationCleanup(initializationError);
  }

  expect(fixtureDir).not.toBe('');
  expect(fixtureId).not.toBe('');
  expect(existsSync(fixtureDir)).toBe(false);
  expect(await LivePcaPublisherFixture.captureMutableState()).toEqual(before);
  await expectWalletBFixtureOwnedBalanceInvariant(walletBBalancesBefore);
  expect(await LivePcaPublisherFixture.capturePcaTotalSupply()).toBe(
    supplyBefore + retainedPcaCount,
  );
  if (expectsKnownPcaAccountId) expect(pcaAccountId).toBeGreaterThan(0n);
}

async function expectCanonicalPcaOwner(accountId: bigint): Promise<void> {
  const state = await detectDevnet(6);
  expect(state).not.toBeNull();
  const hub = new ethers.Contract(
    state!.addrs.Hub,
    ['function owner() view returns (address)'],
    state!.provider,
  );
  expect(lower(await state!.nft.ownerOf(accountId))).toBe(lower(await hub.owner()));
}

async function expectAcceptedBroadcastCleanup(
  checkpoint: FixtureAcceptedBroadcastCheckpoint,
  retainedPcaCount: bigint,
): Promise<void> {
  const before = await LivePcaPublisherFixture.captureMutableState();
  const supplyBefore = await LivePcaPublisherFixture.capturePcaTotalSupply();
  const acceptedError = new Error(`injected accepted ${checkpoint} response loss`);
  let transactionHash = '';
  let pcaOwnerAddress = '';

  await expect(createLiveFixture({
    acceptedBroadcastFault: {
      checkpoint,
      error: acceptedError,
      onAccepted: (context) => {
        transactionHash = context.transaction.hash;
        pcaOwnerAddress = context.pcaOwnerAddress;
      },
    },
  })).rejects.toBe(acceptedError);

  expect(transactionHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect(pcaOwnerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  const state = await detectDevnet(6);
  expect(state).not.toBeNull();
  const receipt = await state!.provider.getTransactionReceipt(transactionHash);
  expect(receipt?.status).toBe(1);
  expect(await state!.provider.getBalance(pcaOwnerAddress)).toBe(0n);
  expect(await LivePcaPublisherFixture.captureMutableState()).toEqual(before);
  expect(await LivePcaPublisherFixture.capturePcaTotalSupply()).toBe(
    supplyBefore + retainedPcaCount,
  );

  if (retainedPcaCount > 0n) {
    const pcaAddress = lower(await state!.nft.getAddress());
    const erc721 = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    ]);
    const accountIds = receipt!.logs.flatMap((log) => {
      if (lower(log.address) !== pcaAddress) return [];
      try {
        const parsed = erc721.parseLog(log);
        return parsed?.name === 'Transfer'
          && lower(String(parsed.args.from)) === lower(ethers.ZeroAddress)
          && lower(String(parsed.args.to)) === lower(pcaOwnerAddress)
          ? [BigInt(parsed.args.tokenId)]
          : [];
      } catch {
        return [];
      }
    });
    expect(accountIds).toHaveLength(1);
    await expectCanonicalPcaOwner(accountIds[0]!);
  }
}

async function expectDeferredInitializationCleanup(
  settle: 'drain' | 'retry',
): Promise<void> {
  const before = await LivePcaPublisherFixture.captureMutableState();
  const supplyBefore = await LivePcaPublisherFixture.capturePcaTotalSupply();
  const initializationError = new Error(`injected ${settle} initialization failure`);
  const cleanupError = new Error(`injected ${settle} cleanup failure`);
  let pcaAccountId = 0n;
  let fixtureDir = '';

  await expect(LivePcaPublisherFixture.create({
    initializationFault: {
      checkpoint: 'after-agent-registration',
      error: initializationError,
      onReached: (context) => {
        ({ pcaAccountId, fixtureDir } = context);
      },
    },
    cleanupFault: {
      checkpoint: 'pca-detachment',
      error: cleanupError,
      failures: 1,
    },
  })).rejects.toBe(initializationError);

  expect(pcaAccountId).toBeGreaterThan(0n);
  expect(existsSync(fixtureDir)).toBe(false);
  const pending = await LivePcaPublisherFixture.captureMutableState();
  expect(pending.walletBAgentAccountId).toBe(pcaAccountId);

  if (settle === 'retry') {
    await retryLivePcaPublisherInitializationCleanup(initializationError);
    await retryLivePcaPublisherInitializationCleanup(initializationError);
  } else {
    await drainLivePcaPublisherInitializationCleanups();
    await drainLivePcaPublisherInitializationCleanups();
    await retryLivePcaPublisherInitializationCleanup(initializationError);
  }

  expect(await LivePcaPublisherFixture.captureMutableState()).toEqual(before);
  expect(await LivePcaPublisherFixture.capturePcaTotalSupply()).toBe(supplyBefore + 1n);
  await expectCanonicalPcaOwner(pcaAccountId);
}

function expectPcaWaivedOpenRegistration(
  fixture: LivePcaPublisherFixture,
  registration: RegistrationEvidence,
  observed: WaivedRegistrationEvidence,
  waivedCountBefore: bigint,
): void {
  const { contextGraphId, receipt, created } = registration;
  expect(receipt.status).toBe(1);
  expect(lower(receipt.to!)).toBe(lower(fixture.contextGraphsAddress));
  expect(lower(receipt.from)).toBe(lower(fixture.walletB.address));

  expect(lower(created.args.owner)).toBe(lower(fixture.walletB.address));
  expect(Number(created.args.accessPolicy)).toBe(0);
  expect(Number(created.args.publishPolicy)).toBe(1);
  expect(lower(created.args.publishAuthority)).toBe(lower(ethers.ZeroAddress));
  expect(BigInt(created.args.publishAuthorityAccountId)).toBe(0n);

  expect(observed.facadeWaivers, 'facade waiver event').toHaveLength(1);
  expect(observed.storageWaivers, 'storage waiver event').toHaveLength(1);
  expect(observed.deposits, 'waived registration deposit events').toHaveLength(0);
  expect(BigInt(observed.facadeWaivers[0]!.args.contextGraphId)).toBe(contextGraphId);
  expect(BigInt(observed.facadeWaivers[0]!.args.accountId)).toBe(fixture.pcaAccountId);
  expect(lower(observed.facadeWaivers[0]!.args.creator)).toBe(lower(fixture.walletB.address));
  expect(BigInt(observed.storageWaivers[0]!.args.accountId)).toBe(fixture.pcaAccountId);
  expect(lower(observed.storageWaivers[0]!.args.creator)).toBe(lower(fixture.walletB.address));
  expect(BigInt(observed.storageWaivers[0]!.args.newWaivedCount)).toBe(waivedCountBefore + 1n);
  expect(observed.registrationDeposit).toBeGreaterThan(0n);
  expect(BigInt(observed.storageWaivers[0]!.args.quota)).toBe(
    observed.accountCommitment / observed.registrationDeposit,
  );
  expect(observed.waivedCountAfter).toBe(waivedCountBefore + 1n);

  expect(lower(observed.storedOwner)).toBe(lower(fixture.walletB.address));
  expect(observed.storedPublishPolicy).toBe(1);
  expect(lower(observed.storedPublishAuthority)).toBe(lower(ethers.ZeroAddress));
  expect(observed.storedPublishAuthorityAccountId).toBe(0n);
  expect(observed.registrationEscrow).toBe(0n);
  expect(observed.walletAAllowance).toBe(fixture.initialWalletAContextGraphsAllowance);
  expect(observed.walletBAllowance).toBe(0n);
  expect(
    observed.tokenTransfers.filter((transfer) => {
      const from = lower(String(transfer.args.from));
      return from === lower(fixture.walletA.address) || from === lower(fixture.walletB.address);
    }),
    'operational-wallet transfers in the registration receipt',
  ).toHaveLength(0);
  expect(observed.walletAApprovals, 'wallet A registration approvals').toHaveLength(0);
  expect(observed.walletBApprovals, 'wallet B registration approvals').toHaveLength(0);
}

function fixtureOwnedMutableState(
  state: Awaited<ReturnType<typeof LivePcaPublisherFixture.captureMutableState>>,
): Omit<typeof state, 'walletABalance' | 'walletBBalance'> {
  const { walletABalance: _walletABalance, walletBBalance: _walletBBalance, ...owned } = state;
  return owned;
}

describe.sequential('issue #2440 — PCA-covered live CG registration', () => {
  afterAll(async () => {
    await drainLivePcaPublisherInitializationCleanups();
  }, 300_000);

  describe.sequential('targeted fixture lifecycle cleanup', () => {
    it('restores the dormant registration deposit after post-activation failure', async () => {
      await expectInitializationCleanup('after-registration-deposit', 0n, false);
    }, 300_000);

    it('detaches but retains a canonical PCA after a post-creation failure', async () => {
      await expectInitializationCleanup('after-pca-creation', 1n);
    }, 300_000);

    it('discovers and detaches a mined PCA when initialization fails before its ID is read', async () => {
      await expectInitializationCleanup('after-pca-mint-before-read', 1n, false);
    }, 300_000);

    it('detaches but retains a canonical PCA after a post-agent failure', async () => {
      await expectInitializationCleanup('after-agent-registration', 1n);
    }, 300_000);

    it('cleans PCA binding and temporary resources after a post-setup failure', async () => {
      await expectInitializationCleanup('after-wallet-state', 1n);
    }, 300_000);

    it('reconciles accepted PCA funding when its broadcast response is lost', async () => {
      await expectAcceptedBroadcastCleanup('pca-funding', 0n);
    }, 300_000);

    it('discovers an accepted PCA mint when its broadcast response is lost', async () => {
      await expectAcceptedBroadcastCleanup('pca-mint', 1n);
    }, 300_000);

    it('retries a retained initialization cleanup and then becomes a no-op', async () => {
      await expectDeferredInitializationCleanup('retry');
    }, 300_000);

    it('drains a retained initialization cleanup and then becomes a no-op', async () => {
      await expectDeferredInitializationCleanup('drain');
    }, 300_000);

    it('preserves a canonical operational-wallet effect through successful disposal', async () => {
      const baseline = await LivePcaPublisherFixture.captureMutableState();
      const supplyBefore = await LivePcaPublisherFixture.capturePcaTotalSupply();
      const local = await createLiveFixture();
      const fixtureDir = local.fixtureDirectory;
      const fixturePcaAccountId = local.pcaAccountId;
      let unrelated: Awaited<ReturnType<
        typeof local.submitUnrelatedOperationalWalletEffect
      >> | undefined;
      let disposed = false;
      try {
        unrelated = await local.submitUnrelatedOperationalWalletEffect();
        expect(await local.token.balanceOf(local.walletA.address)).toBe(
          baseline.walletABalance + unrelated.amount,
        );

        const walletBBalancesBeforeDispose =
          await LivePcaPublisherFixture.captureWalletBBalances();
        const firstDispose = local.dispose();
        const secondDispose = local.dispose();
        expect(secondDispose).toBe(firstDispose);
        await firstDispose;
        disposed = true;

        expect(existsSync(fixtureDir)).toBe(false);
        expect(await LivePcaPublisherFixture.capturePcaTotalSupply()).toBe(supplyBefore + 1n);
        await expectWalletBFixtureOwnedBalanceInvariant(walletBBalancesBeforeDispose);
        expect(lower(await local.pca.ownerOf(fixturePcaAccountId))).toBe(
          lower(local.ownerWallet.address),
        );
        expect(await local.pca.agentToAccountId(local.walletB.address)).toBe(0n);
        const current = await LivePcaPublisherFixture.captureMutableState();
        expect(current).toEqual({
          ...baseline,
          walletABalance: baseline.walletABalance + unrelated.amount,
        });

        const receipt = await local.state.provider.getTransactionReceipt(
          unrelated.transactionHash,
        );
        expect(receipt?.status).toBe(1);
        expect(receipt?.blockHash).toBe(unrelated.blockHash);
        const canonicalBlock = await local.state.provider.getBlock(unrelated.blockNumber);
        expect(canonicalBlock?.hash).toBe(unrelated.blockHash);
        expect(canonicalBlock?.transactions).toContain(unrelated.transactionHash);
      } finally {
        if (!disposed) await local.dispose();
      }
    }, 300_000);

    it('creates, disposes, and recreates a distinct canonical fixture locally', async () => {
      const baseline = await LivePcaPublisherFixture.captureMutableState();
      const first = await createLiveFixture();
      const firstFixtureId = first.fixtureId;
      const firstPcaAccountId = first.pcaAccountId;
      const walletBBalancesBeforeFirstDispose =
        await LivePcaPublisherFixture.captureWalletBBalances();
      await first.dispose();
      await expectWalletBFixtureOwnedBalanceInvariant(walletBBalancesBeforeFirstDispose);

      const recreated = await createLiveFixture();
      try {
        expect(recreated.fixtureId).not.toBe(firstFixtureId);
        expect(recreated.pcaAccountId).toBeGreaterThan(firstPcaAccountId);
        const flow = await recreated.createAndShareFlow('recreated');
        const waivedBefore = await recreated.waivedCount();
        const fromBlock = await recreated.blockNumber();
        const published = await recreated.publishSync(flow);
        expect(['confirmed', 'finalized']).toContain(published.status);
        const registration = await recreated.findRegistration(flow.contextGraphId, fromBlock);
        const observed = await recreated.collectWaivedRegistrationEvidence(
          registration,
          fromBlock,
        );
        expectPcaWaivedOpenRegistration(recreated, registration, observed, waivedBefore);
        expect(await recreated.waitForVmVisibility(flow)).toBeGreaterThan(0);
      } finally {
        const walletBBalancesBeforeRecreatedDispose =
          await LivePcaPublisherFixture.captureWalletBBalances();
        await recreated.dispose();
        await expectWalletBFixtureOwnedBalanceInvariant(
          walletBBalancesBeforeRecreatedDispose,
        );
      }
      expect(
        fixtureOwnedMutableState(await LivePcaPublisherFixture.captureMutableState()),
      ).toEqual(fixtureOwnedMutableState(baseline));
    }, 600_000);
  });

  describe.sequential('publisher registration behavior', () => {
    let fixture: LivePcaPublisherFixture;
    let baseline: Awaited<ReturnType<typeof LivePcaPublisherFixture.captureMutableState>>;
    let finalizedBroadcast: {
      jobId: string;
      transactionHash: string;
      blockHash: string;
      blockNumber: number;
    } | undefined;

    beforeAll(async () => {
      baseline = await LivePcaPublisherFixture.captureMutableState();
      fixture = await createLiveFixture();
    }, 300_000);

    afterAll(async () => {
      if (!fixture) return;
      const fixtureDir = fixture.fixtureDirectory;
      const walletBBalancesBeforeDispose =
        await LivePcaPublisherFixture.captureWalletBBalances();
      await fixture.dispose();

      expect(existsSync(fixtureDir)).toBe(false);
      await expectWalletBFixtureOwnedBalanceInvariant(walletBBalancesBeforeDispose);
      expect(
        fixtureOwnedMutableState(await LivePcaPublisherFixture.captureMutableState()),
      ).toEqual(fixtureOwnedMutableState(baseline));
      if (finalizedBroadcast) {
        const retainedJob = await fixture.readFinalizedPublisherJob(finalizedBroadcast.jobId);
        expect(retainedJob.broadcast.txHash).toBe(finalizedBroadcast.transactionHash);

        const retainedReceipt = await fixture.state.provider.getTransactionReceipt(
          finalizedBroadcast.transactionHash,
        );
        expect(retainedReceipt?.status).toBe(1);
        expect(retainedReceipt?.blockHash).toBe(finalizedBroadcast.blockHash);
        expect(retainedReceipt?.blockNumber).toBe(finalizedBroadcast.blockNumber);

        const retainedBlock = await fixture.state.provider.getBlock(finalizedBroadcast.blockNumber);
        expect(retainedBlock?.hash).toBe(finalizedBroadcast.blockHash);
        expect(retainedBlock?.transactions).toContain(finalizedBroadcast.transactionHash);
      }
    }, 300_000);

    it('sync VM first-publish auto-registers an open graph with exact PCA-covered wallet B', async () => {
      const flow = await fixture.createAndShareFlow('sync');
      const waivedBefore = await fixture.waivedCount();
      const fromBlock = await fixture.blockNumber();

      const published = await fixture.publishSync(flow);
      expect(['confirmed', 'finalized']).toContain(published.status);

      const registration = await fixture.findRegistration(flow.contextGraphId, fromBlock);
      const observed = await fixture.collectWaivedRegistrationEvidence(registration, fromBlock);
      expectPcaWaivedOpenRegistration(fixture, registration, observed, waivedBefore);
      expect(await fixture.waitForVmVisibility(flow)).toBeGreaterThan(0);
    }, 600_000);

    it('async VM first-publish retains selected wallet B through registration and broadcast', async () => {
      const flow = await fixture.createAndShareFlow('async');
      const waivedBefore = await fixture.waivedCount();
      const fromBlock = await fixture.blockNumber();

      const published = await fixture.publishAsync(flow);
      expect(published.acceptedStatus).toBe('accepted');
      expect(published.jobId).not.toBe('');
      expect(published.job.request.jobType).toBe('knowledge-asset-vm-publish');
      expect(published.job.request.knowledgeAssetVmPublish.contextGraphId).toBe(
        flow.contextGraphId,
      );
      expect(published.job.request.knowledgeAssetVmPublish.name).toBe(flow.name);
      expect(lower(published.job.claim.walletId)).toBe(lower(fixture.walletB.address));
      expect(lower(published.job.broadcast.walletId)).toBe(
        lower(fixture.walletB.address),
      );
      expect(published.job.broadcast.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

      const registration = await fixture.findRegistration(flow.contextGraphId, fromBlock);
      const observed = await fixture.collectWaivedRegistrationEvidence(registration, fromBlock);
      expectPcaWaivedOpenRegistration(fixture, registration, observed, waivedBefore);
      expect(lower(published.job.broadcast.walletId)).toBe(lower(registration.receipt.from));

      const broadcastReceipt = await fixture.findAsyncBroadcastReceipt(published.job);
      expect(broadcastReceipt.status).toBe(1);
      expect(lower(broadcastReceipt.from)).toBe(lower(fixture.walletB.address));
      expect(lower(broadcastReceipt.to!)).toBe(
        lower(fixture.knowledgeAssetsLifecycleAddress),
      );
      finalizedBroadcast = {
        jobId: published.jobId,
        transactionHash: published.job.broadcast.txHash,
        blockHash: broadcastReceipt.blockHash,
        blockNumber: broadcastReceipt.blockNumber,
      };
      expect(await fixture.waitForVmVisibility(flow)).toBeGreaterThan(0);
    }, 600_000);

  });
});
