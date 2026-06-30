/**
 * MockChainAdapter V10 Publishing Conviction NFT parity (issue #519 /
 * TB-0002). The mock models an in-memory account map (incrementing id),
 * an agent → accountId reverse map and owner-gating so offline-mode
 * users hit the same owner-revert behaviour as the real chain.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { toShardingTableNode } from '../src/evm-adapter-conviction.js';

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

  it('clearPublishingConvictionAgents bulk-removes every agent and frees the reverse map', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);
    const agent1 = ethers.Wallet.createRandom().address;
    const agent2 = ethers.Wallet.createRandom().address;
    await mock.registerPublishingConvictionAgent(accountId, agent1);
    await mock.registerPublishingConvictionAgent(accountId, agent2);
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(2);

    const cleared = await mock.clearPublishingConvictionAgents(accountId);
    expect(cleared.success).toBe(true);
    expect(await mock.isPublishingConvictionAgent(accountId, agent1)).toBe(false);
    expect(await mock.isPublishingConvictionAgent(accountId, agent2)).toBe(false);
    expect(await mock.getConvictionAgentAccountId(agent1)).toBe(0n);
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(0);
  });

  it('registerPublishingConvictionAgents bulk-adds all agents (all-or-nothing on a duplicate)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createPublishingConvictionAccount(COMMITTED);
    const a1 = ethers.Wallet.createRandom().address;
    const a2 = ethers.Wallet.createRandom().address;

    const res = await mock.registerPublishingConvictionAgents(accountId, [a1, a2]);
    expect(res.success).toBe(true);
    expect(await mock.isPublishingConvictionAgent(accountId, a1)).toBe(true);
    expect(await mock.isPublishingConvictionAgent(accountId, a2)).toBe(true);
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(2);

    // All-or-nothing: a batch containing an already-registered agent reverts and
    // adds none of its entries.
    const a3 = ethers.Wallet.createRandom().address;
    await expect(
      mock.registerPublishingConvictionAgents(accountId, [a3, a1]),
    ).rejects.toThrow(/AgentAlreadyRegistered/);
    expect(await mock.isPublishingConvictionAgent(accountId, a3)).toBe(false);
    expect((await mock.getPublishingConvictionAccountInfo(accountId))!.agentCount).toBe(2);
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

  it('listPublishingConvictionAccountsForWallets returns owned / agent / both, deduped and sorted', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId: a1 } = await mock.createPublishingConvictionAccount(COMMITTED);
    const { accountId: a2 } = await mock.createPublishingConvictionAccount(COMMITTED);
    const wallet = ethers.Wallet.createRandom().address;
    await mock.registerPublishingConvictionAgent(a1, wallet);

    const owned = await mock.listPublishingConvictionAccountsForWallets([SIGNER]);
    expect(owned.map((entry) => entry.relation)).toEqual(['owned', 'owned']);

    expect(await mock.listPublishingConvictionAccountsForWallets([wallet]))
      .toEqual([{ accountId: a1, relation: 'agent' }]);

    const combined = await mock.listPublishingConvictionAccountsForWallets([SIGNER, wallet]);
    const relations = new Map(combined.map((entry) => [entry.accountId, entry.relation]));
    expect(relations.get(a1)).toBe('both');
    expect(relations.get(a2)).toBe('owned');
    expect(combined).toHaveLength(2);
    expect(combined.map((entry) => entry.accountId)).toEqual([a1, a2]);
    expect(await mock.listPublishingConvictionAccountsForWallets([ethers.Wallet.createRandom().address])).toEqual([]);
  });

  it('listDesignatableNodes returns the fixture sharding table in hash-ring order', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const nodes = await mock.listDesignatableNodes();
    expect(nodes).toHaveLength(3);
    expect(nodes.map((node) => node.identityId)).toEqual([42n, 57n, 61n]);
    for (const node of nodes) {
      expect(node.nodeId).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(typeof node.identityId).toBe('bigint');
      expect(node.stake).toBeGreaterThan(0n);
      expect(node.ask).toBeGreaterThan(0n);
    }
  });

  it('getPublishingConvictionContracts returns checksummed nft/token plus chainId and rpcUrls', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const contracts = await mock.getPublishingConvictionContracts();
    expect(contracts.nft).toBe(ethers.getAddress(contracts.nft));
    expect(contracts.token).toBe(ethers.getAddress(contracts.token));
    expect(contracts.nft).not.toBe(contracts.token);
    expect(contracts.chainId).toBe('mock:31337');
    expect(Array.isArray(contracts.rpcUrls)).toBe(true);
  });

  it('toShardingTableNode normalizes named object and positional tuple shapes', () => {
    expect(toShardingTableNode({ nodeId: '0xab', identityId: 7n, ask: 1n, stake: 2n }))
      .toEqual({ nodeId: '0xab', identityId: 7n, ask: 1n, stake: 2n });
    expect(toShardingTableNode(['0xab', 7n, 1n, 2n]))
      .toEqual({ nodeId: '0xab', identityId: 7n, ask: 1n, stake: 2n });
    expect(toShardingTableNode(['0xcd', '9', 3, 4n]))
      .toEqual({ nodeId: '0xcd', identityId: 9n, ask: 3n, stake: 4n });
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
