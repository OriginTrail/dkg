/**
 * EVMChainAdapter — Hub rotation self-refresh (E2E against Hardhat).
 *
 * This file exercises the structural fix for the post-rotation
 * stale-address bug that bricked `RandomSampling` writes from running
 * daemons whenever the Hub rotated to a new RS deployment. The fix
 * lives in `evm-adapter.ts` (`HubResolutionCache` for RS+RSS, plus a
 * Hub event listener and a `withHubStaleRetry` wrapper); the unit
 * tests in `hub-resolution-cache.unit.test.ts` cover the cache
 * primitive in isolation. Here we drive a **real** Hardhat node with
 * a **real** `Hub.setContractAddress(...)` rotation and assert the
 * adapter picks up the new address through each of the three refresh
 * paths without restart:
 *
 *   1. TTL refresh    — cached address is replaced after `ttlMs` elapses
 *                       and the next adapter call re-resolves from Hub.
 *   2. Event listener — adapter's `Hub.ContractChanged`/`NewContract`
 *                       subscription invalidates the cache as soon as
 *                       the rotation is mined.
 *   3. Self-heal      — `withHubStaleRetry()` catches the exact revert
 *                       wording the prover sees in the wild
 *                       (`UnauthorizedAccess(Only Contracts in Hub)`),
 *                       drops the cache, and retries the call once.
 *
 * Plus two negative / belt-and-braces cases:
 *
 *   4. Errors that don't match the marker are NOT treated as stale —
 *      cache stays intact and the wrapper does not retry.
 *   5. Full happy path: after rotating away and back, a real public
 *      adapter read (`getActiveProofPeriodStatus`) succeeds against
 *      the freshly resolved contract — the visible "no daemon restart
 *      needed" property the PR is shipping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Wallet, Contract, ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import {
  spawnHardhatEnv,
  killHardhat,
  HARDHAT_KEYS,
  type HardhatContext,
} from './hardhat-harness.js';

// Minimal Hub surface we drive directly — re-registering RandomSampling
// is the action that fires `ContractChanged` (+ `NewContract`, per the
// Hub-extra E-7 double-emit) and is gated on `onlyOwnerOrMultiSigOwner`.
// HARDHAT_KEYS.DEPLOYER is the Hub owner because the deploy script runs
// as accounts[0].
const HUB_ABI = [
  'function getContractAddress(string) view returns (address)',
  'function setContractAddress(string, address) external',
  'event ContractChanged(string contractName, address newContractAddress)',
  'event NewContract(string contractName, address newContractAddress)',
];

let ctx: HardhatContext;

function makeAdapter(rpcUrl: string, hubAddress: string, refreshMs: number): EVMChainAdapter {
  const config: EVMAdapterConfig = {
    rpcUrl,
    privateKey: HARDHAT_KEYS.DEPLOYER,
    hubAddress,
    chainId: 'evm:31337',
    randomSamplingHubRefreshMs: refreshMs,
  };
  return new EVMChainAdapter(config);
}

/** Resolve `name` straight from the on-chain Hub (bypassing the adapter cache). */
async function readHubAddress(hubAddress: string, signer: Wallet, name: string): Promise<string> {
  const hub = new Contract(hubAddress, HUB_ABI, signer);
  return hub.getContractAddress(name);
}

/**
 * Mint a fresh, never-before-seen address for the rotation target.
 * `Hub._setContractAddress` rejects re-using any address already in
 * the contractSet (`AddressAlreadyInSet`), so we can't substitute
 * another Hub-registered contract; an EOA is fine because the Hub
 * skips the `IContractStatus.setStatus` callback when the new
 * address has no code.
 */
function freshAddress(): string {
  return ethers.Wallet.createRandom().address;
}

/** Re-register `name` to `newAddr` on-chain. Caller is expected to be the Hub owner. */
async function rotateHubContract(
  hubAddress: string,
  signer: Wallet,
  name: string,
  newAddr: string,
): Promise<void> {
  const hub = new Contract(hubAddress, HUB_ABI, signer);
  const tx = await hub.setContractAddress(name, newAddr);
  await tx.wait();
}

/** Poll `predicate` every `intervalMs` until truthy or `timeoutMs` elapses. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

describe('EVMChainAdapter — Hub rotation self-refresh (E2E)', () => {
  beforeAll(async () => {
    // Unique port to avoid collision with the other Hardhat-backed
    // suites (8545 / 8546 / 8552 are taken; global setup uses 9545).
    ctx = await spawnHardhatEnv(8553);
  }, 120_000);

  afterAll(() => {
    killHardhat(ctx);
  });

  it(
    'TTL refresh: cached RandomSampling address is re-resolved after the TTL elapses',
    async () => {
      // 200 ms TTL keeps the test fast; production default is 5 min.
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 200);

      // Drive cache population through the public surface.
      await adapter.getActiveProofPeriodStatus!();
      const cachedBefore = (adapter as any).randomSamplingPairCache.peek() as
        | { rs: Contract; rss: Contract }
        | null;
      expect(cachedBefore).not.toBeNull();
      const addrA: string = await cachedBefore!.rs.getAddress();

      // Isolate the TTL path from the event-listener path so this test
      // doesn't trivially pass via event-driven invalidation.
      (adapter as any).contracts.hub.removeAllListeners();

      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, ctx.provider);
      const replacementAddr = freshAddress();

      try {
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSampling', replacementAddr);

        // Sanity: with the listener removed, immediate inspection still
        // shows the stale cached address — TTL hasn't fired yet.
        const peeked = (adapter as any).randomSamplingPairCache.peek() as
          | { rs: Contract; rss: Contract }
          | null;
        const stillCached = await peeked!.rs.getAddress();
        expect(stillCached.toLowerCase()).toBe(addrA.toLowerCase());

        // Wait past TTL; the next get() is forced to re-resolve.
        await new Promise((r) => setTimeout(r, 300));
        const { rs } = await (adapter as any).getRandomSampling();
        const addrB: string = await rs.getAddress();
        expect(addrB.toLowerCase()).toBe(replacementAddr.toLowerCase());
        expect(addrB.toLowerCase()).not.toBe(addrA.toLowerCase());
      } finally {
        // Restore real RS so subsequent tests in the file (and any
        // other suite reusing this Hub state) see the deployed RS.
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSampling', addrA);
      }
    },
    60_000,
  );

  it(
    'Hub event listener: rotating RandomSamplingStorage ALSO invalidates the pair cache (coupled refresh)',
    async () => {
      // RS and RSS are deliberately treated as a coupled unit because
      // RS.initialize() snapshots its RSS address. If the listener
      // only invalidated on a name match, a single-side rotation
      // (rare but possible) could leave the adapter holding a mixed
      // pair — the exact bug Codex flagged on round 1. This test
      // verifies that ROTATING ONLY RandomSamplingStorage still
      // invalidates the pair cache.
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);
      (adapter as any).provider.pollingInterval = 250;

      await adapter.getActiveProofPeriodStatus!();
      expect((adapter as any).randomSamplingPairCache.peek()).not.toBeNull();

      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, ctx.provider);
      const realRssAddr = await readHubAddress(ctx.hubAddress, deployer, 'RandomSamplingStorage');
      const replacementAddr = freshAddress();

      try {
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSamplingStorage', replacementAddr);

        const invalidated = await waitFor(
          () => (adapter as any).randomSamplingPairCache.peek() === null,
          15_000,
          100,
        );
        expect(invalidated).toBe(true);
      } finally {
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSamplingStorage', realRssAddr);
      }
    },
    60_000,
  );

  it(
    'Hub event listener: invalidation also flips isRandomSamplingReady() to false until next getRandomSampling()',
    async () => {
      // Codex N15 — invalidating only the pair cache without dropping
      // the side-channel `this.contracts.randomSampling[Storage]` handles
      // would leave `isRandomSamplingReady()` reporting `true` after a
      // Hub rotation (until the next `getRandomSampling()` re-populates
      // the handles). The prover would then poll the rotated-away
      // RandomSampling contract believing it's still good. This test
      // verifies the readiness probe correctly drops to `false` on
      // invalidation and recovers on the next resolve.
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);
      (adapter as any).provider.pollingInterval = 250;

      await adapter.getActiveProofPeriodStatus!();
      expect(adapter.isRandomSamplingReady()).toBe(true);

      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, ctx.provider);
      const realRsAddr = await readHubAddress(ctx.hubAddress, deployer, 'RandomSampling');
      const replacementAddr = freshAddress();

      try {
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSampling', replacementAddr);

        const becameNotReady = await waitFor(
          () => adapter.isRandomSamplingReady() === false,
          15_000,
          100,
        );
        expect(becameNotReady).toBe(true);

        await (adapter as any).getRandomSampling();
        expect(adapter.isRandomSamplingReady()).toBe(true);
      } finally {
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSampling', realRsAddr);
      }
    },
    60_000,
  );

  it(
    'Hub event listener: ContractChanged invalidates the RandomSampling cache',
    async () => {
      // High TTL (10 min) far exceeds the test's lifetime, so the only
      // path that can plausibly re-resolve within this test window is
      // the event listener installed in init().
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);

      // Drop the JsonRpcProvider polling interval (default 4 s) before
      // the listener is attached so this test resolves quickly.
      (adapter as any).provider.pollingInterval = 250;

      await adapter.getActiveProofPeriodStatus!();
      const peekedA = (adapter as any).randomSamplingPairCache.peek() as
        | { rs: Contract; rss: Contract }
        | null;
      const addrA: string = await peekedA!.rs.getAddress();

      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, ctx.provider);
      const replacementAddr = freshAddress();

      try {
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSampling', replacementAddr);

        // The listener should observe `ContractChanged('RandomSampling', ...)`
        // within a few polling cycles and call `cache.invalidate()`.
        const invalidated = await waitFor(
          () => (adapter as any).randomSamplingPairCache.peek() === null,
          15_000,
          100,
        );
        expect(invalidated).toBe(true);

        // Next get() resolves from the live Hub and reflects the new addr.
        const { rs } = await (adapter as any).getRandomSampling();
        const addrB: string = await rs.getAddress();
        expect(addrB.toLowerCase()).toBe(replacementAddr.toLowerCase());
      } finally {
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSampling', addrA);
      }
    },
    60_000,
  );

  it(
    'withHubStaleRetry: marker error invalidates the RS pair cache and retries the operation exactly once',
    async () => {
      // High TTL keeps the cache from "spontaneously" re-resolving
      // mid-test; the wrapper's invalidate() is the only signal we
      // care about here.
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);
      await adapter.getActiveProofPeriodStatus!();
      expect((adapter as any).randomSamplingPairCache.peek()).not.toBeNull();

      let calls = 0;
      const result = await (adapter as any).withHubStaleRetry(async () => {
        calls += 1;
        // Exact substring the prover sees in the wild — the chain
        // adapter wraps reverts and `enrichEvmError` appends the
        // decoded custom-error name to the message.
        if (calls === 1) {
          throw new Error(
            'execution reverted (unknown custom error): UnauthorizedAccess(Only Contracts in Hub)',
          );
        }
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(calls).toBe(2);
      // The pair cache was invalidated on the first throw — no
      // subsequent get() inside the wrapper, so it's still empty here.
      expect((adapter as any).randomSamplingPairCache.peek()).toBeNull();

      // A follow-up adapter call refills the pair from the live Hub.
      const { rs, rss } = await (adapter as any).getRandomSampling();
      expect(typeof (await rs.getAddress())).toBe('string');
      expect(typeof (await rss.getAddress())).toBe('string');
    },
    30_000,
  );

  it(
    'withHubStaleRetry: unrelated revert messages do NOT invalidate the cache and do NOT retry',
    async () => {
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);
      await adapter.getActiveProofPeriodStatus!();
      const cachedBefore = (adapter as any).randomSamplingPairCache.peek();
      expect(cachedBefore).not.toBeNull();

      let calls = 0;
      let caught: Error | null = null;
      try {
        await (adapter as any).withHubStaleRetry(async () => {
          calls += 1;
          // A "real" revert that has nothing to do with Hub registration.
          throw new Error('execution reverted: ProfileDoesntExist(0)');
        });
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/ProfileDoesntExist/);
      expect(calls).toBe(1);

      // Cache reference unchanged (same { rs, rss } object).
      expect((adapter as any).randomSamplingPairCache.peek()).toBe(cachedBefore);
    },
    30_000,
  );

  it(
    'happy path: after a Hub rotation, getActiveProofPeriodStatus succeeds against the new RS without restarting the adapter',
    async () => {
      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, ctx.provider);
      const realRsAddr = await readHubAddress(ctx.hubAddress, deployer, 'RandomSampling');

      // Live adapter that's been "running" against the real RS.
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 250);
      (adapter as any).provider.pollingInterval = 250;

      const before = await adapter.getActiveProofPeriodStatus!();
      expect(typeof before.activeProofPeriodStartBlock).toBe('bigint');
      const peekedBefore = (adapter as any).randomSamplingPairCache.peek() as
        | { rs: Contract; rss: Contract }
        | null;
      const cachedAddrBefore: string = await peekedBefore!.rs.getAddress();
      expect(cachedAddrBefore.toLowerCase()).toBe(realRsAddr.toLowerCase());

      // Rotate to a non-RS address — getActiveProofPeriodStatus would
      // fail against this. The adapter must NOT keep using it.
      const tempAddr = freshAddress();
      await rotateHubContract(ctx.hubAddress, deployer, 'RandomSampling', tempAddr);

      // Wait for invalidation (event listener path; TTL also covers it).
      const invalidatedFirst = await waitFor(
        () => (adapter as any).randomSamplingPairCache.peek() === null,
        15_000,
      );
      expect(invalidatedFirst).toBe(true);

      // Restore the real RS and let the adapter rediscover it.
      await rotateHubContract(ctx.hubAddress, deployer, 'RandomSampling', realRsAddr);

      // The most reliable signal that the adapter rebound to the live
      // RS is that a public read succeeds AND the cached address now
      // matches `realRsAddr`. This is the user-visible "no restart
      // needed after a Hub rotation" property.
      let after: Awaited<ReturnType<NonNullable<EVMChainAdapter['getActiveProofPeriodStatus']>>> | null = null;
      const recovered = await waitFor(async () => {
        try {
          after = await adapter.getActiveProofPeriodStatus!();
          const cached = (adapter as any).randomSamplingPairCache.peek() as
            | { rs: Contract; rss: Contract }
            | null;
          if (!cached) return false;
          const addr = await cached.rs.getAddress();
          return addr.toLowerCase() === realRsAddr.toLowerCase();
        } catch {
          return false;
        }
      }, 15_000, 200);

      expect(recovered).toBe(true);
      expect(after).not.toBeNull();
      expect(typeof after!.activeProofPeriodStartBlock).toBe('bigint');
    },
    90_000,
  );
});
