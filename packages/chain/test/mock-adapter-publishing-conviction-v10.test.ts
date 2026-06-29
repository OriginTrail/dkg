/**
 * MockChainAdapter V10 Publishing Conviction NFT parity (issue #519 /
 * TB-0002). The mock models an in-memory account map (incrementing id),
 * an agent → accountId reverse map and owner-gating so offline-mode
 * users hit the same owner-revert behaviour as the real chain.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '../src/mock-adapter.js';

const SIGNER = '0x1111111111111111111111111111111111111111';
const COMMITTED = ethers.parseEther('10000');

describe('MockChainAdapter — V10 conviction account create/read', () => {
  it('createPublishingConvictionAccount mints to the signer with an incrementing id', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);

    const a = await mock.createPublishingConvictionAccount(COMMITTED);
    expect(a.success).toBe(true);
    expect(a.accountId).toBe(1n);
    expect(a.hash).toMatch(/^0x[0-9a-fA-F]{64}/);

    const b = await mock.createPublishingConvictionAccount(COMMITTED);
    expect(b.accountId).toBe(2n);
  });

  it('getPublishingConvictionAccountInfo returns the V10 shape owned by the signer', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);

    const info = await mock.getPublishingConvictionAccountInfo(accountId);
    expect(info).not.toBeNull();
    expect(info!.owner.toLowerCase()).toBe(SIGNER.toLowerCase());
    expect(info!.committedTRAC).toBe(COMMITTED);
    expect(info!.topUpBuffer).toBe(0n);
    expect(info!.agentCount).toBe(0);

    expect(await mock.getPublishingConvictionAccountInfo(999n)).toBeNull();
  });

  it('getPublishingConvictionAccountInfo extended adds GAP-4/5 fields; default omits them', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);

    const base = (await mock.getPublishingConvictionAccountInfo(accountId))!;
    expect(base.primaryNode).toBeUndefined();
    expect(base.remainingAllowance).toBeUndefined();
    expect(base.currentEpoch).toBeUndefined();
    expect(base.lastPrimaryNodeChangeEpoch).toBeUndefined();

    const ext = (await mock.getPublishingConvictionAccountInfo(accountId, { extended: true }))!;
    expect(ext.primaryNode).toBe(0n); // mock doesn't model RFC-51 per-node allocation
    expect(ext.lastPrimaryNodeChangeEpoch).toBe(0);
    expect(typeof ext.currentEpoch).toBe('number');
    expect(ext.remainingAllowance).toBe(ext.baseEpochAllowance + ext.topUpBuffer);
  });

  it('lifecycle metadata is internally consistent: expiresAtEpoch = createdAtEpoch + lockDurationEpochs', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);

    const info = (await mock.getPublishingConvictionAccountInfo(accountId))!;
    const lock = await mock.getConvictionAccountLockDurationEpochs(accountId);
    expect(lock).toBe(12);
    expect(info.expiresAtEpoch).toBe(info.createdAtEpoch + lock);
    // Timestamps stay 0 (mock has no wall clock); settlement not modeled.
    expect(info.createdAtTimestamp).toBe(0);
    expect(info.expiresAtTimestamp).toBe(0);
    expect(info.lastSettledWindow).toBe(0);
    expect(info.fullySwept).toBe(false);

    // createdAtEpoch advances monotonically per account.
    const { accountId: second } = await mock.createPublishingConvictionAccount(COMMITTED);
    const info2 = (await mock.getPublishingConvictionAccountInfo(second))!;
    expect(info2.createdAtEpoch).toBeGreaterThan(info.createdAtEpoch);
  });
});

describe('MockChainAdapter — V10 conviction discount tier parity', () => {
  // Exact mirror of DKGPublishingConvictionNFT.getDiscountBps
  // (DKGPublishingConvictionNFT.sol L767-775). committedTRAC → bps.
  const TIERS: Array<[bigint, number]> = [
    [ethers.parseEther('24999'), 0], // sub-threshold → 0 bps
    [ethers.parseEther('25000'), 1000], // 10%
    [ethers.parseEther('50000'), 2000], // 20%
    [ethers.parseEther('100000'), 3000], // 30%
    [ethers.parseEther('250000'), 4000], // 40%
    [ethers.parseEther('500000'), 5000], // 50%
    [ethers.parseEther('1000000'), 7500], // top tier → 75%
  ];

  it.each(TIERS)(
    'committedTRAC %s yields discountBps %i (fixed at creation)',
    async (committedTRAC, expectedBps) => {
      const mock = new MockChainAdapter('mock:31337', SIGNER);
      const { accountId } = await mock.createPublishingConvictionAccount(committedTRAC);
      const info = (await mock.getPublishingConvictionAccountInfo(accountId))!;
      expect(info.discountBps).toBe(expectedBps);
    },
  );
});

describe('MockChainAdapter — V10 conviction agent register/deregister', () => {
  it('registers an agent, exposes it via isPublishingConvictionAgent + reverse map, then deregisters', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);
    const agent = ethers.Wallet.createRandom().address;

    expect(await mock.isPublishingConvictionAgent(accountId, agent)).toBe(false);

    const reg = await mock.registerPublishingConvictionAgent(accountId, agent);
    expect(reg.success).toBe(true);
    expect(await mock.isPublishingConvictionAgent(accountId, agent)).toBe(true);
    expect(await mock.getConvictionAgentAccountId(agent)).toBe(accountId);
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(1);

    const dereg = await mock.deregisterPublishingConvictionAgent(accountId, agent);
    expect(dereg.success).toBe(true);
    expect(await mock.isPublishingConvictionAgent(accountId, agent)).toBe(false);
    expect(await mock.getConvictionAgentAccountId(agent)).toBe(0n);
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(0);
  });

  it('rejects re-registering an already-registered agent (N28 parity)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);
    const agent = ethers.Wallet.createRandom().address;

    await mock.registerPublishingConvictionAgent(accountId, agent);
    await expect(mock.registerPublishingConvictionAgent(accountId, agent))
      .rejects.toThrow(/AgentAlreadyRegistered/);
  });

  it('getPublishingConvictionAgents enumerates checksummed addresses and returns [] for missing/empty (B3 parity)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    expect(await mock.getPublishingConvictionAgents(999n)).toEqual([]); // missing account

    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);
    expect(await mock.getPublishingConvictionAgents(accountId)).toEqual([]); // exists, no agents

    // Mock stores keys lowercased; register a LOWERCASE address and assert the
    // enumerator checksum-normalizes to match the on-chain address[] view.
    const checksummed = ethers.getAddress('0x' + 'ab'.repeat(20));
    await mock.registerPublishingConvictionAgent(accountId, checksummed.toLowerCase());
    const agents = await mock.getPublishingConvictionAgents(accountId);
    expect(agents).toEqual([checksummed]);
    expect(agents[0]).not.toBe(checksummed.toLowerCase()); // EIP-55, not lowercased
  });

  it('listPublishingConvictionAccountsForWallets — owned / agent / both, deduped + sorted (GAP-1 parity)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId: a1 } = await mock.createPublishingConvictionAccount(COMMITTED);
    const { accountId: a2 } = await mock.createPublishingConvictionAccount(COMMITTED);
    const w = ethers.Wallet.createRandom().address;
    await mock.registerPublishingConvictionAgent(a1, w);

    // SIGNER owns a1+a2, is an agent of neither → both 'owned'.
    const owned = await mock.listPublishingConvictionAccountsForWallets([SIGNER]);
    expect(owned.map((e) => e.relation)).toEqual(['owned', 'owned']);
    // w owns nothing, agent on a1 → 'agent'.
    expect(await mock.listPublishingConvictionAccountsForWallets([w])).toEqual([{ accountId: a1, relation: 'agent' }]);
    // Combined → a1 'both', a2 'owned', deduped + sorted asc.
    const combined = await mock.listPublishingConvictionAccountsForWallets([SIGNER, w]);
    const m = new Map(combined.map((e) => [e.accountId, e.relation]));
    expect(m.get(a1)).toBe('both');
    expect(m.get(a2)).toBe('owned');
    expect(combined).toHaveLength(2);
    expect(combined.map((e) => e.accountId)).toEqual([a1, a2]); // sorted asc (1n, 2n)
    // Unrelated wallet → [].
    expect(await mock.listPublishingConvictionAccountsForWallets([ethers.Wallet.createRandom().address])).toEqual([]);
  });

  it('listDesignatableNodes — fixture sharding table in hash-ring order (B-staked-nodes parity)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const nodes = await mock.listDesignatableNodes();
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.identityId)).toEqual([42n, 57n, 61n]); // order preserved (not sorted)
    for (const n of nodes) {
      expect(n.nodeId).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(typeof n.identityId).toBe('bigint');
      expect(n.stake).toBeGreaterThan(0n);
      expect(n.ask).toBeGreaterThan(0n);
    }
  });
});

describe('MockChainAdapter — V10 conviction topUp/settle', () => {
  it('topUpPublishingConvictionAccount accumulates the buffer and settle succeeds', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);

    const top = await mock.topUpPublishingConvictionAccount(accountId, COMMITTED);
    expect(top.success).toBe(true);
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.topUpBuffer).toBe(COMMITTED);

    await mock.topUpPublishingConvictionAccount(accountId, COMMITTED);
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.topUpBuffer).toBe(COMMITTED * 2n);

    const settled = await mock.settlePublishingConvictionAccount(accountId);
    expect(settled.success).toBe(true);
  });

  it('mock does NOT model settlement — lastSettledWindow/fullySwept are static stubs (verified on-chain instead)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);

    const before = (await mock.getPublishingConvictionAccountInfo(accountId))!;
    expect(before.lastSettledWindow).toBe(0);
    expect(before.fullySwept).toBe(false);

    // settle is a deliberate no-op; settlement fidelity is out of
    // mock-parity scope (evm-module hardhat + devnet smoke own it).
    await mock.settlePublishingConvictionAccount(accountId);

    const after = (await mock.getPublishingConvictionAccountInfo(accountId))!;
    expect(after.lastSettledWindow).toBe(0);
    expect(after.fullySwept).toBe(false);
  });
});

describe('MockChainAdapter — V10 owner-gating parity', () => {
  const STRANGER = '0x2222222222222222222222222222222222222222';

  it('rejects non-owner topUp/register/deregister with NotAccountOwner (revert not swallowed)', async () => {
    // Account owned by STRANGER; this mock's signer is SIGNER → not owner.
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const accountId = mock.seedConvictionAccount(STRANGER);
    const agent = ethers.Wallet.createRandom().address;

    await expect(mock.topUpPublishingConvictionAccount(accountId, COMMITTED))
      .rejects.toThrow(/NotAccountOwner/);
    await expect(mock.registerPublishingConvictionAgent(accountId, agent))
      .rejects.toThrow(/NotAccountOwner/);
    await expect(mock.deregisterPublishingConvictionAgent(accountId, agent))
      .rejects.toThrow(/NotAccountOwner/);

    // Rejected writes must not have mutated state.
    const info = await mock.getPublishingConvictionAccountInfo(accountId);
    expect(info!.topUpBuffer).toBe(0n);
    expect(info!.agentCount).toBe(0);
  });

  it('settle is permissionless (no owner gate, parity with the contract)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const accountId = mock.seedConvictionAccount(STRANGER);
    await expect(mock.settlePublishingConvictionAccount(accountId)).resolves.toMatchObject({ success: true });
  });

  it('deregistering an unregistered agent reverts AgentNotRegistered', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);
    await expect(
      mock.deregisterPublishingConvictionAgent(accountId, ethers.Wallet.createRandom().address),
    ).rejects.toThrow(/AgentNotRegistered/);
  });
});

describe('MockChainAdapter — V10 invalid-input parity with the contract', () => {
  const MAX_UINT96 = (1n << 96n) - 1n;

  it('createPublishingConvictionAccount rejects zero / negative / uint96-overflow committedTRAC', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    await expect(mock.createPublishingConvictionAccount(0n)).rejects.toThrow(/InvalidAmount/);
    await expect(mock.createPublishingConvictionAccount(-1n)).rejects.toThrow(/InvalidAmount/);
    await expect(mock.createPublishingConvictionAccount(MAX_UINT96 + 1n)).rejects.toThrow(/InvalidAmount/);
  });

  it('topUpPublishingConvictionAccount rejects zero / negative / uint96-overflow amount', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);
    await expect(mock.topUpPublishingConvictionAccount(accountId, 0n)).rejects.toThrow(/InvalidAmount/);
    await expect(mock.topUpPublishingConvictionAccount(accountId, -1n)).rejects.toThrow(/InvalidAmount/);
    await expect(mock.topUpPublishingConvictionAccount(accountId, MAX_UINT96 + 1n)).rejects.toThrow(/InvalidAmount/);
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.topUpBuffer).toBe(0n);
  });

  it('registerPublishingConvictionAgent rejects the zero address (ZeroAgentAddress)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);
    await expect(
      mock.registerPublishingConvictionAgent(accountId, ethers.ZeroAddress),
    ).rejects.toThrow(/ZeroAgentAddress/);
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(0);
  });

  it('getPublishingConvictionAccountInfo.baseEpochAllowance is committedTRAC / lockDurationEpochs', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);
    const info = (await mock.getPublishingConvictionAccountInfo(accountId))!;
    const lock = await mock.getConvictionAccountLockDurationEpochs(accountId);
    expect(lock).toBeGreaterThan(0);
    expect(info.baseEpochAllowance).toBe(COMMITTED / BigInt(lock));
    expect(info.baseEpochAllowance).toBeGreaterThan(0n);
  });
});

describe('MockChainAdapter — V10 conviction agent-cap parity', () => {
  // Mirrors DKGPublishingConvictionNFT default maxAgentsPerAccount
  // (DKGPublishingConvictionNFT.sol:208 — `if (maxAgentsPerAccount == 0) maxAgentsPerAccount = 100;`).
  const CAP = 100;
  // Deterministic distinct agent address from a 1-based index.
  const agentAt = (i: number) => ethers.getAddress('0x' + i.toString(16).padStart(40, '0'));

  it('allows exactly maxAgentsPerAccount registrations (the cap-th still succeeds)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);

    for (let i = 1; i <= CAP; i++) {
      const reg = await mock.registerPublishingConvictionAgent(accountId, agentAt(i));
      expect(reg.success).toBe(true);
    }
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(CAP);
  });

  it('rejects the agent beyond the cap with AgentCapReached and does not grow the set', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);

    for (let i = 1; i <= CAP; i++) {
      await mock.registerPublishingConvictionAgent(accountId, agentAt(i));
    }

    await expect(
      mock.registerPublishingConvictionAgent(accountId, agentAt(CAP + 1)),
    ).rejects.toThrow(/AgentCapReached/);
    // Rejected register must not have mutated state past the cap.
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(CAP);
    expect(await mock.getConvictionAgentAccountId(agentAt(CAP + 1))).toBe(0n);
  });

  it('applies the cap per-account (a full account A does not block account B)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId: a } = await mock.createPublishingConvictionAccount(COMMITTED);
    const { accountId: b } = await mock.createPublishingConvictionAccount(COMMITTED);

    for (let i = 1; i <= CAP; i++) {
      await mock.registerPublishingConvictionAgent(a, agentAt(i));
    }
    await expect(
      mock.registerPublishingConvictionAgent(a, agentAt(CAP + 1)),
    ).rejects.toThrow(/AgentCapReached/);

    // Account B is still empty → registering on it must succeed.
    const reg = await mock.registerPublishingConvictionAgent(b, agentAt(CAP + 1));
    expect(reg.success).toBe(true);
    expect((await mock.getPublishingConvictionAccountInfo(b))!.agentCount).toBe(1);
    expect(await mock.getConvictionAgentAccountId(agentAt(CAP + 1))).toBe(b);
  });
});
