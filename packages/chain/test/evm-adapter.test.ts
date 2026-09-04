import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  spawnHardhatEnv,
  killHardhat,
  makeAdapterConfig,
  HARDHAT_KEYS,
  createNodeProfile,
  type HardhatContext,
} from './hardhat-harness.js';

let ctx: HardhatContext;

describe('EVMChainAdapter integration', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8545);
  }, 60_000);

  afterAll(() => {
    killHardhat(ctx);
  });

  it('should connect and resolve V10 contracts from Hub', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));

    expect(adapter.chainType).toBe('evm');
    expect(adapter.chainId).toBe('evm:31337');

    // V8 `KnowledgeCollection` + `Staking` were archived in TB-1 (PRD §4.1)
    // — their Hub bindings no longer exist. Hub-resolve the V10 successors
    // instead to assert the adapter still talks to a fresh V10 deploy.
    // Greenfield (PR #815): the lifecycle contract's Hub key + `name()` were
    // renamed KnowledgeAssetsV10 → KnowledgeAssetsLifecycle.
    const kav10 = await adapter.getContract('KnowledgeAssetsLifecycle');
    expect(await kav10.name()).toBe('KnowledgeAssetsLifecycle');

    const stakingV10 = await adapter.getContract('StakingV10');
    expect(await stakingV10.name()).toBe('StakingV10');
  }, 30_000);

  it('should have correct signer address', () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const address = adapter.getSignerAddress();
    expect(address.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });

  it('getBlockNumber reads from the live Hardhat node (no contract init required)', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const bn = await adapter.getBlockNumber();
    expect(typeof bn).toBe('number');
    expect(bn).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('removes one participant agent from a live private context graph', async () => {
    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER),
    );
    const retained = new Wallet(HARDHAT_KEYS.EXTRA1).address;
    const removed = new Wallet(HARDHAT_KEYS.EXTRA2).address;
    const created = await adapter.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      participantAgents: [retained, removed],
    });

    expect(await adapter.getContextGraphParticipantAgents(created.contextGraphId))
      .toEqual(expect.arrayContaining([retained, removed]));
    const result = await adapter.removeContextGraphParticipantAgent(
      created.contextGraphId,
      removed,
    );

    expect(result.success).toBe(true);
    expect(await adapter.getContextGraphParticipantAgents(created.contextGraphId))
      .toEqual([retained]);
  }, 60_000);

  it('verifyPublisherOwnsRange resolves KnowledgeAssetsStorage after init', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n);
    expect(owns).toBe(false);
  }, 30_000);

  // verifyACKIdentity gates the off-chain ACKCollector pre-flight. Post RFC-001
  // the on-chain check inside `KnowledgeAssetsV10._verifyACKSignature` is
  // (`keyHasPurpose` && `shardingTableStorage.nodeExists`), and the off-chain
  // pre-flight must mirror that exactly. The harness stakes CORE + REC1..REC3
  // at `minimumStake` so all four are in the sharding table; any newly minted
  // profile with no stake must NOT pass the gate.
  describe('verifyACKIdentity (RFC-001 off-chain ↔ on-chain gate parity)', () => {
    it('accepts a staked-and-in-sharding-table operator key', async () => {
      const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
      const coreOpAddr = new Wallet(HARDHAT_KEYS.CORE_OP).address;
      const ok = await adapter.verifyACKIdentity(coreOpAddr, BigInt(ctx.coreProfileId));
      expect(ok).toBe(true);
      // Off-chain decision must agree with the on-chain ST gate that
      // KnowledgeAssetsV10 enforces at publish time.
      const inST = await adapter.isShardingTableMember!(BigInt(ctx.coreProfileId));
      expect(inST).toBe(true);
    }, 30_000);

    it('rejects a signer that is not a registered operational key for the identity', async () => {
      const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
      const stranger = ethers.Wallet.createRandom().address;
      const ok = await adapter.verifyACKIdentity(stranger, BigInt(ctx.coreProfileId));
      expect(ok).toBe(false);
    }, 30_000);

    it('rejects an operator whose identity is not in the sharding table (unstaked)', async () => {
      // Mint a fresh profile with the EXTRA1 wallet but DON'T stake it. Its
      // operational key is registered (so `keyHasPurpose` passes) but
      // `shardingTableStorage.nodeExists` returns false because the node
      // never crossed `minimumStake`. Pre-RFC-001 this method would have
      // accepted it as long as `getNodeStakeV10 > 0`; we assert the new
      // ST-membership gate keeps it locked out, matching the on-chain
      // contract that would revert the publish with
      // `"ACK signer not in sharding table"`.
      const newId = await createNodeProfile(
        ctx.provider, ctx.hubAddress,
        HARDHAT_KEYS.EXTRA1, HARDHAT_KEYS.EXTRA2, // op + admin keys (unique)
        'UnstakedProfile',
      );
      const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
      const opAddr = new Wallet(HARDHAT_KEYS.EXTRA1).address;
      const ok = await adapter.verifyACKIdentity(opAddr, BigInt(newId));
      expect(ok).toBe(false);
      // Confirm the on-chain ST gate is in the same state.
      const inST = await adapter.isShardingTableMember!(BigInt(newId));
      expect(inST).toBe(false);
    }, 60_000);
  });
});
