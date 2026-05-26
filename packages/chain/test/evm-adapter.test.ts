import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  spawnHardhatEnv,
  killHardhat,
  makeAdapterConfig,
  HARDHAT_KEYS,
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
    const kav10 = await adapter.getContract('KnowledgeAssetsV10');
    expect(await kav10.name()).toBe('KnowledgeAssetsV10');

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

  it('verifyPublisherOwnsRange("v9") resolves KnowledgeAssetsStorage after init', async () => {
    // OT-RFC-40 §7.5: explicit `"v9"` tag routes to the V9 KAS
    // publisher-range API. A freshly-deployed V9 KAS has no
    // pre-reserved ranges for any address, so this returns false.
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n, 'v9');
    expect(owns).toBe(false);
  }, 30_000);

  it('verifyPublisherOwnsRange (default tag) defers to V10 ACK auth → returns true', async () => {
    // OT-RFC-40 §7.5: the V10 default storage does NOT pre-reserve
    // publisher ranges; ownership is verified at the ACK-signature
    // layer. The method returns true so V10 publishes on Hubs without
    // a V9 KAS deployment aren't silently rejected — the bug PR-5
    // calls out by name. Pre-RFC, this returned false unconditionally
    // when V9 KAS was empty.
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    const ownsDefault = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n);
    expect(ownsDefault).toBe(true);
    const ownsExplicitDefault = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n, '');
    expect(ownsExplicitDefault).toBe(true);
  }, 30_000);

  it('verifyPublisherOwnsRange returns false for an unknown storage tag', async () => {
    // Conservative failure mode for a UAL minted under a tag the
    // receiver's registry doesn't recognise (e.g. a V11 storage that
    // the daemon hasn't refreshed against yet). RFC §7.5 — operators
    // see the rejection and can refresh the registry.
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n, 'nonexistent-tag');
    expect(owns).toBe(false);
  }, 30_000);
});
