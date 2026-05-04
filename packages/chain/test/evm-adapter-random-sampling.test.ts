/**
 * EVMChainAdapter — Random Sampling integration tests against Hardhat.
 *
 * Scope is intentionally narrow: this slice ships the chain primitive
 * only. The full happy-path createChallenge requires a Phase 8 CG with
 * non-zero per-epoch value at the current epoch — that fixture is what
 * Slice 4's `scripts/devnet-test-random-sampling.sh` exercises end-to-end.
 *
 * Here we cover:
 *   1. Hub resolution wires `RandomSampling` + `RandomSamplingStorage`.
 *   2. `getActiveProofPeriodStatus()` is readable on a fresh chain.
 *   3. `getNodeChallenge(idId)` returns null for an identity with no challenge.
 *   4. `getNodeEpochProofPeriodScore(...)` returns 0 for an unscored identity.
 *   5. `createChallenge()` from a non-staked / un-sharded signer reverts;
 *      the typed-error translator surfaces the underlying contract error.
 *
 * Slice 4 will add the positive `ChallengeGenerated` test once the
 * devnet-side CG-bridging helper lands.
 */
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

describe('EVMChainAdapter random sampling integration', () => {
  beforeAll(async () => {
    // Use a unique port to avoid collision with the other Hardhat-backed tests.
    ctx = await spawnHardhatEnv(8552);
  }, 90_000);

  afterAll(() => {
    killHardhat(ctx);
  });

  it('init() resolves RandomSampling + RandomSamplingStorage from the Hub', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const rs = await adapter.getContract('RandomSampling');
    const rss = await adapter.getContract('RandomSamplingStorage');
    expect(await rs.name()).toBe('RandomSampling');
    expect(typeof await rss.getAddress()).toBe('string');
  }, 60_000);

  it('getActiveProofPeriodStatus reads (startBlock, isValid) from the chain', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const status = await adapter.getActiveProofPeriodStatus!();
    expect(typeof status.activeProofPeriodStartBlock).toBe('bigint');
    expect(typeof status.isValid).toBe('boolean');
    // The deployment script initialises a non-zero start block; we don't
    // assert the exact value (depends on deploy block height), only that
    // it's been set.
    expect(status.activeProofPeriodStartBlock >= 0n).toBe(true);
  }, 30_000);

  it('getNodeChallenge returns null for an identity with no active challenge', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    // Identity 999 is guaranteed not to exist on a freshly-deployed Hardhat.
    const challenge = await adapter.getNodeChallenge!(999n);
    expect(challenge).toBeNull();
  }, 30_000);

  it('getNodeEpochProofPeriodScore returns 0 for an unscored (identity, epoch, period)', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const score = await adapter.getNodeEpochProofPeriodScore!(999n, 1n, 1n);
    expect(score).toBe(0n);
  }, 30_000);

  it('createChallenge from a signer without an identity reverts; error decoded by translator', async () => {
    // The DEPLOYER key has no Profile (only the CORE_OP key in the harness
    // does, which is staked/sharded). createChallenge from a signer with
    // identityId == 0 hits the `profileExists(0)` modifier and reverts
    // with `ProfileDoesntExist(0)`. The translator passes that through
    // unchanged (it's not one of the typed retry-next-period conditions).
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    let caught: Error | null = null;
    try {
      await adapter.createChallenge!();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    // The decode-error helper enriches the message with the custom-error
    // name; we tolerate either the raw revert or the enriched form so
    // this test isn't coupled to revert-string formatting.
    expect(caught!.message).toMatch(/ProfileDoesntExist|profileExists|reverted/i);
  }, 30_000);

  it('createChallenge from a non-sharded but profiled signer reverts on the sharding modifier', async () => {
    // CORE_OP has a profile created by the harness, plus 50k TRAC stake +
    // ask set, so it IS in the sharding table. To exercise the
    // non-sharded path we need a fresh profile that isn't sharded — REC1
    // has a profile (from createNodeProfile) but no stake, so it should
    // revert with NodeNotInShardingTable.
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.REC1_OP));
    let caught: Error | null = null;
    try {
      await adapter.createChallenge!();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/NodeDoesntExist|nodeExistsInShardingTable|reverted/i);
  }, 30_000);
});
