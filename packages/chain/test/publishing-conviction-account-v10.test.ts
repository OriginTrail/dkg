/**
 * V10 Publishing Conviction NFT — chain-adapter write+read lifecycle
 * against a real Hardhat node (issue #519 / TB-0001).
 *
 * Covers the seven V10 `DKGPublishingConvictionNFT` adapter methods:
 * create / topUp / registerAgent / deregisterAgent / isAgent / settle /
 * getAccountInfo, plus the owner-gating invariant (non-owner writes must
 * surface the on-chain revert, never be swallowed).
 *
 * Conventions mirror chain-lifecycle-extra.test.ts: real EVMChainAdapter
 * over the shared Hardhat node, one snapshot per test for isolation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from './evm-test-context.js';
import { mintTokens } from './hardhat-harness.js';

const COMMITTED = ethers.parseEther('10000');

let fileSnapshotId: string;
let testSnapshotId: string;

async function fundedOwner(key: string = HARDHAT_KEYS.CORE_OP) {
  const adapter = createEVMAdapter(key);
  await mintTokens(
    createProvider(),
    getSharedContext().hubAddress,
    HARDHAT_KEYS.DEPLOYER,
    adapter.getSignerAddress(),
    COMMITTED * 4n,
  );
  return adapter;
}

describe('V10 Publishing Conviction NFT — chain-adapter lifecycle', () => {
  beforeAll(async () => { fileSnapshotId = await takeSnapshot(); }, 120_000);
  afterAll(async () => { await revertSnapshot(fileSnapshotId); });
  beforeEach(async () => { testSnapshotId = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(testSnapshotId); });

  it('createPublishingConvictionAccount mints the NFT to the signer and returns accountId + txHash', async () => {
    const owner = await fundedOwner();

    const res = await owner.createPublishingConvictionAccount(COMMITTED);
    expect(res.success).toBe(true);
    expect(res.accountId).toBeGreaterThan(0n);
    expect(res.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(res.blockNumber).toBeGreaterThan(0);

    const onChainOwner = await owner.getPublishingConvictionAccountOwner(res.accountId);
    expect(onChainOwner.toLowerCase()).toBe(owner.getSignerAddress().toLowerCase());

    const info = await owner.getPublishingConvictionAccountInfo(res.accountId);
    expect(info).not.toBeNull();
    expect(info!.owner.toLowerCase()).toBe(owner.getSignerAddress().toLowerCase());
    expect(info!.committedTRAC).toBe(COMMITTED);
    expect(info!.agentCount).toBe(0);
  });

  it('registerPublishingConvictionAgent then isPublishingConvictionAgent returns true and the reverse map resolves', async () => {
    const owner = await fundedOwner();
    const { accountId } = await owner.createPublishingConvictionAccount(COMMITTED);

    const agent = ethers.Wallet.createRandom().address;
    expect(await owner.isPublishingConvictionAgent(accountId, agent)).toBe(false);

    const reg = await owner.registerPublishingConvictionAgent(accountId, agent);
    expect(reg.success).toBe(true);

    expect(await owner.isPublishingConvictionAgent(accountId, agent)).toBe(true);
    expect(await owner.getConvictionAgentAccountId(agent)).toBe(accountId);

    const info = await owner.getPublishingConvictionAccountInfo(accountId);
    expect(info!.agentCount).toBe(1);

    const dereg = await owner.deregisterPublishingConvictionAgent(accountId, agent);
    expect(dereg.success).toBe(true);
    expect(await owner.isPublishingConvictionAgent(accountId, agent)).toBe(false);
    expect(await owner.getConvictionAgentAccountId(agent)).toBe(0n);
  });

  it('clearPublishingConvictionAgents bulk-removes every agent (owner-gated, via the logic contract)', async () => {
    const owner = await fundedOwner();
    const { accountId } = await owner.createPublishingConvictionAccount(COMMITTED);

    const agent1 = ethers.Wallet.createRandom().address;
    const agent2 = ethers.Wallet.createRandom().address;
    await owner.registerPublishingConvictionAgent(accountId, agent1);
    await owner.registerPublishingConvictionAgent(accountId, agent2);
    expect((await owner.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(2);

    const cleared = await owner.clearPublishingConvictionAgents(accountId);
    expect(cleared.success).toBe(true);

    expect(await owner.isPublishingConvictionAgent(accountId, agent1)).toBe(false);
    expect(await owner.isPublishingConvictionAgent(accountId, agent2)).toBe(false);
    expect(await owner.getConvictionAgentAccountId(agent1)).toBe(0n);
    expect((await owner.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(0);
  });

  it('registerPublishingConvictionAgents bulk-adds multiple agents in one tx (owner-gated, via the logic contract)', async () => {
    const owner = await fundedOwner();
    const { accountId } = await owner.createPublishingConvictionAccount(COMMITTED);

    const agent1 = ethers.Wallet.createRandom().address;
    const agent2 = ethers.Wallet.createRandom().address;
    const agent3 = ethers.Wallet.createRandom().address;

    const res = await owner.registerPublishingConvictionAgents(accountId, [agent1, agent2, agent3]);
    expect(res.success).toBe(true);

    expect(await owner.isPublishingConvictionAgent(accountId, agent1)).toBe(true);
    expect(await owner.isPublishingConvictionAgent(accountId, agent2)).toBe(true);
    expect(await owner.isPublishingConvictionAgent(accountId, agent3)).toBe(true);
    expect(await owner.getConvictionAgentAccountId(agent2)).toBe(accountId);
    expect((await owner.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(3);
  });

  it('getConvictionAgentAccountId strict mode: healthy reads resolve normally; undeployed NFT surfaces (PcaUnavailableError) instead of fail-safe 0n', async () => {
    const owner = await fundedOwner();
    const { accountId } = await owner.createPublishingConvictionAccount(COMMITTED);
    const wallet = ethers.Wallet.createRandom().address;
    await owner.registerPublishingConvictionAgent(accountId, wallet);

    // Healthy read: strict returns the same on-chain truth as the fail-safe path.
    expect(await owner.getConvictionAgentAccountId(wallet, { strict: true })).toBe(accountId);
    expect(await owner.getConvictionAgentAccountId(ethers.Wallet.createRandom().address, { strict: true })).toBe(0n);

    // Undeployed NFT: the discovery (strict) path SURFACES it so the daemon can
    // answer 503 — never a 0n a UI would read as "registered nowhere". init() is
    // idempotent (`if (this.initialized) return`), so clearing the cached
    // binding after init holds for the next call.
    (owner as any).contracts.dkgPublishingConvictionNFT = undefined;
    await expect(owner.getConvictionAgentAccountId(wallet, { strict: true }))
      .rejects.toMatchObject({ code: 'PCA_UNAVAILABLE' });
    // The funded-wallet-selector fail-safe path still returns 0n for the same state.
    expect(await owner.getConvictionAgentAccountId(wallet)).toBe(0n);
  });

  it('getPublishingConvictionAccountInfo extended returns primaryNode + current-epoch allowance from chain; default omits', async () => {
    const owner = await fundedOwner();
    // A non-zero primaryNode proves the adapter reads accounts() index [9] (not
    // a neighbouring slot). coreProfileId is a registered sharding-table node.
    const primaryNode = BigInt(getSharedContext().coreProfileId);
    const { accountId } = await owner.createPublishingConvictionAccount(COMMITTED, primaryNode);

    const base = (await owner.getPublishingConvictionAccountInfo(accountId))!;
    expect(base.primaryNode).toBeUndefined();
    expect(base.remainingAllowance).toBeUndefined();
    expect(base.currentEpoch).toBeUndefined();

    const ext = (await owner.getPublishingConvictionAccountInfo(accountId, { extended: true }))!;
    expect(ext.primaryNode).toBe(primaryNode);
    expect(typeof ext.lastPrimaryNodeChangeEpoch).toBe('number');
    expect(typeof ext.currentEpoch).toBe('number');
    expect(ext.currentEpoch!).toBeGreaterThan(0);
    expect(ext.remainingAllowance!).toBeGreaterThan(0n);
  });

  it('getPublishingConvictionAccountInfo extended is FAIL-SOFT: an extended-read throw leaves the core account intact', async () => {
    const owner = await fundedOwner();
    const { accountId } = await owner.createPublishingConvictionAccount(COMMITTED);

    // Force the extended enrichment reads (accounts / Chronos / remaining
    // allowance) to throw, while getAccountInfo (the core read) still succeeds.
    const realRead = (owner as any).readContract.bind(owner);
    (owner as any).readContract = async (contract: unknown, label: string, method: string, ...args: unknown[]) => {
      if (method === 'accounts' || method === 'getCurrentEpoch' || method === 'getRemainingAllowance') {
        const e: any = new Error('simulated extended-read failure');
        e.code = 'CALL_EXCEPTION';
        throw e;
      }
      return realRead(contract, label, method, ...args);
    };

    const info = await owner.getPublishingConvictionAccountInfo(accountId, { extended: true });
    // Core account is returned intact (NOT nulled) — the extended block is a
    // nested try that swallows the throw and leaves the extended fields unset.
    expect(info).not.toBeNull();
    expect(info!.committedTRAC).toBe(COMMITTED);
    expect(info!.owner.toLowerCase()).toBe(owner.getSignerAddress().toLowerCase());
    expect(info!.primaryNode).toBeUndefined();
    expect(info!.lastPrimaryNodeChangeEpoch).toBeUndefined();
    expect(info!.currentEpoch).toBeUndefined();
    expect(info!.remainingAllowance).toBeUndefined();
  });

  it('getPublishingConvictionAgents enumerates registered agents (checksummed) and reflects deregistration', async () => {
    const owner = await fundedOwner();
    const { accountId } = await owner.createPublishingConvictionAccount(COMMITTED);
    expect(await owner.getPublishingConvictionAgents(accountId)).toEqual([]);

    const a1 = ethers.Wallet.createRandom().address;
    const a2 = ethers.Wallet.createRandom().address;
    // Register a1 in lowercased form to prove normalization is input-agnostic.
    await owner.registerPublishingConvictionAgent(accountId, a1.toLowerCase());
    await owner.registerPublishingConvictionAgent(accountId, a2);

    const agents = await owner.getPublishingConvictionAgents(accountId);
    expect(agents).toHaveLength(2);
    expect(agents).toEqual(expect.arrayContaining([ethers.getAddress(a1), ethers.getAddress(a2)]));
    // EIP-55 checksummed (the on-chain address[] view), regardless of input case.
    for (const a of agents) expect(a).toBe(ethers.getAddress(a));

    await owner.deregisterPublishingConvictionAgent(accountId, a1);
    expect(await owner.getPublishingConvictionAgents(accountId)).toEqual([ethers.getAddress(a2)]);
  });

  it('getPublishingConvictionAgents returns [] for a nonexistent account', async () => {
    const owner = await fundedOwner();
    expect(await owner.getPublishingConvictionAgents(999999n)).toEqual([]);
  });

  it('owner topUpPublishingConvictionAccount + settlePublishingConvictionAccount succeed and topUpBuffer updates', async () => {
    const owner = await fundedOwner();
    const { accountId } = await owner.createPublishingConvictionAccount(COMMITTED);

    const top = await owner.topUpPublishingConvictionAccount(accountId, COMMITTED);
    expect(top.success).toBe(true);
    const info = await owner.getPublishingConvictionAccountInfo(accountId);
    expect(info!.topUpBuffer).toBe(COMMITTED);

    const settled = await owner.settlePublishingConvictionAccount(accountId);
    expect(settled.success).toBe(true);
  });

  it('non-owner topUp / registerPublishingConvictionAgent propagate the on-chain owner revert (not swallowed)', async () => {
    const owner = await fundedOwner(HARDHAT_KEYS.CORE_OP);
    const { accountId } = await owner.createPublishingConvictionAccount(COMMITTED);

    const stranger = await fundedOwner(HARDHAT_KEYS.PUBLISHER);
    expect(stranger.getSignerAddress().toLowerCase())
      .not.toBe(owner.getSignerAddress().toLowerCase());

    await expect(stranger.topUpPublishingConvictionAccount(accountId, COMMITTED)).rejects.toThrow();
    await expect(
      stranger.registerPublishingConvictionAgent(accountId, ethers.Wallet.createRandom().address),
    ).rejects.toThrow();

    // The owner revert must not have mutated state.
    const info = await owner.getPublishingConvictionAccountInfo(accountId);
    expect(info!.topUpBuffer).toBe(0n);
    expect(info!.agentCount).toBe(0);
  });

  it('existing V10 read methods are preserved and the dead V9 cache slot is gone', async () => {
    const owner = await fundedOwner();
    const { accountId } = await owner.createPublishingConvictionAccount(COMMITTED);

    // getConvictionAccountLockDurationEpochs reads the protocol-wide
    // ParametersStorage.publishingConvictionEpochs snapshot (default 12).
    expect(await owner.getConvictionAccountLockDurationEpochs(accountId)).toBe(12);
    expect((await owner.getPublishingConvictionAccountOwner(accountId)).toLowerCase())
      .toBe(owner.getSignerAddress().toLowerCase());

    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'evm-adapter.ts'), 'utf8');
    expect(src).not.toMatch(/\bpublishingConvictionAccount\b/);
    expect(src).not.toMatch(/resolveContract\(\s*'PublishingConvictionAccount'\s*\)/);
  });
});
