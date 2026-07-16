/**
 * EVMChainAdapter — Hub rotation self-refresh (E2E against Hardhat).
 *
 * This file exercises the structural fix for the post-rotation
 * stale-address bug that bricked `RandomSampling` writes from running
 * daemons whenever the Hub rotated to a new RS deployment. The fix
 * lives in `evm-adapter.ts` (`HubResolutionCache` for RS+RSS, plus a
 * low-cadence Hub rotation poller and a `withHubStaleRetry` wrapper); the unit
 * tests in `hub-resolution-cache.unit.test.ts` cover the cache
 * primitive in isolation. Here we drive a **real** Hardhat node with
 * a **real** `Hub.setContractAddress(...)` rotation and assert the
 * adapter picks up the new address through each of the three refresh
 * paths without restart:
 *
 *   1. TTL refresh    — cached address is replaced after `ttlMs` elapses
 *                       and the next adapter call re-resolves from Hub.
 *   2. Hub poller     — adapter's Hub contract/storage rotation scan
 *                       invalidates the cache after the rotation is mined.
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
  'function getAssetStorageAddress(string) view returns (address)',
  'function setContractAddress(string, address) external',
  'function setAssetStorageAddress(string, address) external',
  'event ContractChanged(string contractName, address newContractAddress)',
  'event NewContract(string contractName, address newContractAddress)',
  'event AssetStorageChanged(string contractName, address newContractAddress)',
  'event NewAssetStorage(string contractName, address newContractAddress)',
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

/** Resolve asset-storage `name` straight from the on-chain Hub. */
async function readHubAssetStorageAddress(
  hubAddress: string,
  signer: Wallet,
  name: string,
): Promise<string> {
  const hub = new Contract(hubAddress, HUB_ABI, signer);
  return hub.getAssetStorageAddress(name);
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

/** Re-register an asset-storage binding to `newAddr` on-chain. */
async function rotateHubAssetStorage(
  hubAddress: string,
  signer: Wallet,
  name: string,
  newAddr: string,
): Promise<void> {
  const hub = new Contract(hubAddress, HUB_ABI, signer);
  const tx = await hub.setAssetStorageAddress(name, newAddr);
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

/** Drive the adapter's bound Hub rotation poller once. */
async function pollHubRotations(adapter: EVMChainAdapter): Promise<void> {
  await (adapter as any).hubRotationPoller.pollOnce();
}

/**
 * Let the adapter's Hub rotation poller consume any historical
 * `ContractChanged` / `NewContract` events that a previous test in
 * the same Hardhat session may have left behind. ethers v6 subscribes
 * its polling filter with fromBlock=latest, but in practice the
 * computed `latest` can include the most-recent rotation tx — so a
 * brand-new adapter can fire its first poller callback against an
 * event it never directly caused.
 *
 * This mirrors production behaviour: a daemon that boots immediately
 * after a Hub rotation will catch the rotation it didn't observe
 * to. The "drain" step here just ensures the test snapshots are
 * taken AFTER that catch-up, so steady-state assertions hold.
 */
async function drainHistoricalRotationEvents(adapter: EVMChainAdapter): Promise<void> {
  await pollHubRotations(adapter);
  if (!(adapter as any).initialized) {
    await (adapter as any).init();
  }
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

      // Isolate the TTL path from the Hub poller path by not driving the
      // poller during this test; production cadence is far longer than 300 ms.

      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, ctx.provider);
      const replacementAddr = freshAddress();

      try {
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSampling', replacementAddr);

        // Sanity: without driving the Hub poller, immediate inspection still
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
    'Hub rotation poller: rotating RandomSamplingStorage ALSO invalidates the pair cache (coupled refresh)',
    async () => {
      // RS and RSS are deliberately treated as a coupled unit because
      // RS.initialize() snapshots its RSS address. If the poller
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

        await pollHubRotations(adapter);
        expect((adapter as any).randomSamplingPairCache.peek()).toBeNull();
      } finally {
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSamplingStorage', realRssAddr);
      }
    },
    60_000,
  );

  it(
    'Hub rotation poller: invalidation also flips isRandomSamplingReady() to false until next getRandomSampling()',
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

        await pollHubRotations(adapter);
        expect(adapter.isRandomSamplingReady()).toBe(false);

        await (adapter as any).getRandomSampling();
        expect(adapter.isRandomSamplingReady()).toBe(true);
      } finally {
        await rotateHubContract(ctx.hubAddress, deployer, 'RandomSampling', realRsAddr);
      }
    },
    60_000,
  );

  it(
    'Hub rotation poller: ContractChanged invalidates the RandomSampling cache',
    async () => {
      // High TTL (10 min) far exceeds the test's lifetime, so the only
      // path that can plausibly re-resolve within this test window is
      // the Hub rotation poller driven by the test.
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);

      // Keep the adapter provider fast for direct reads; Hub invalidation is
      // driven explicitly through the adapter-owned poller.
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

        await pollHubRotations(adapter);
        expect((adapter as any).randomSamplingPairCache.peek()).toBeNull();

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

      await pollHubRotations(adapter);
      expect((adapter as any).randomSamplingPairCache.peek()).toBeNull();

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

  // ===================================================================
  // Generic boot-bound contract rotation (rc.12 PR
  // `feat/chain-hub-rotation-auto-recovery`). Mirrors the RS-specific
  // cases above but exercises the table-driven path in
  // `startHubRotationListener` + the `withHubStaleRetryAny` wrapper
  // that backs `pcaWrite` and any future write-side caller. The
  // contract under test is `Identity` — it's always deployed, always
  // boot-bound, and listed in `BOUND_CONTRACT_INVALIDATORS`; the
  // poller should treat it identically to any other entry in the
  // map.
  // ===================================================================

  it(
    'Hub rotation poller (generic): rotating Identity preserves live handle and re-arms init()',
    async () => {
      // High TTL — only the Hub rotation poller can flip the field within
      // the test window. (RS cache has its own TTL; the generic path
      // doesn't use one — only poller + write-side retry.)
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);
      (adapter as any).provider.pollingInterval = 250;

      await (adapter as any).init();
      const identityBefore: Contract = (adapter as any).contracts.identity;
      expect(identityBefore).toBeDefined();
      const identityAddrBefore: string = await identityBefore.getAddress();

      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, ctx.provider);
      const replacementAddr = freshAddress();

      try {
        await rotateHubContract(ctx.hubAddress, deployer, 'Identity', replacementAddr);

        await pollHubRotations(adapter);
        expect((adapter as any).contracts.identity).toBe(identityBefore);
        expect((adapter as any).initialized).toBe(false);

        // Next init() re-resolves from the live Hub and binds the new address.
        await (adapter as any).init();
        const identityAfter: Contract = (adapter as any).contracts.identity;
        expect(identityAfter).toBeDefined();
        const identityAddrAfter: string = await identityAfter.getAddress();
        expect(identityAddrAfter.toLowerCase()).toBe(replacementAddr.toLowerCase());
        expect(identityAddrAfter.toLowerCase()).not.toBe(identityAddrBefore.toLowerCase());
      } finally {
        await rotateHubContract(ctx.hubAddress, deployer, 'Identity', identityAddrBefore);
      }
    },
    60_000,
  );

  it(
    'Hub rotation poller (generic): boot-bound rotation clears publish preflight cache before TTL',
    async () => {
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);
      (adapter as any).provider.pollingInterval = 250;

      await (adapter as any).init();
      await drainHistoricalRotationEvents(adapter);

      const kav10Before = await adapter.getKnowledgeAssetsLifecycleAddress();
      const kav10HandleBefore: Contract = (adapter as any).contracts.knowledgeAssetsLifecycle;
      expect((adapter as any).cachedKav10Address?.value.toLowerCase()).toBe(
        kav10Before.toLowerCase(),
      );

      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, ctx.provider);
      const replacementAddr = freshAddress();

      try {
        // Greenfield (PR #815): the lifecycle contract is registered under
        // the Hub key KnowledgeAssetsLifecycle (was KnowledgeAssetsV10), which
        // is what getKnowledgeAssetsLifecycleAddress() resolves. Rotate that key.
        await rotateHubContract(ctx.hubAddress, deployer, 'KnowledgeAssetsLifecycle', replacementAddr);

        await pollHubRotations(adapter);
        expect((adapter as any).contracts.knowledgeAssetsLifecycle).toBe(kav10HandleBefore);
        expect((adapter as any).cachedKav10Address).toBeUndefined();
        expect((adapter as any).cachedMinRequiredSignatures).toBeUndefined();
        expect((adapter as any).initialized).toBe(false);

        const kav10After = await adapter.getKnowledgeAssetsLifecycleAddress();
        expect(kav10After.toLowerCase()).toBe(replacementAddr.toLowerCase());
      } finally {
        await rotateHubContract(ctx.hubAddress, deployer, 'KnowledgeAssetsLifecycle', kav10Before);
      }
    },
    60_000,
  );

  it(
    'Hub rotation poller (asset storage): rotating ContextGraphStorage preserves live handle and re-arms init()',
    async () => {
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);
      (adapter as any).provider.pollingInterval = 250;

      await (adapter as any).init();
      await drainHistoricalRotationEvents(adapter);

      const storageBefore: Contract = (adapter as any).contracts.contextGraphStorage;
      expect(storageBefore).toBeDefined();
      const storageAddrBefore: string = await storageBefore.getAddress();

      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, ctx.provider);
      const hubAddrBefore = await readHubAssetStorageAddress(
        ctx.hubAddress,
        deployer,
        'ContextGraphStorage',
      );
      expect(hubAddrBefore.toLowerCase()).toBe(storageAddrBefore.toLowerCase());
      const replacementAddr = freshAddress();

      try {
        await rotateHubAssetStorage(
          ctx.hubAddress,
          deployer,
          'ContextGraphStorage',
          replacementAddr,
        );

        await pollHubRotations(adapter);
        expect((adapter as any).contracts.contextGraphStorage).toBe(storageBefore);
        expect((adapter as any).initialized).toBe(false);

        await (adapter as any).init();
        const storageAfter: Contract = (adapter as any).contracts.contextGraphStorage;
        expect(storageAfter).toBeDefined();
        const storageAddrAfter: string = await storageAfter.getAddress();
        expect(storageAddrAfter.toLowerCase()).toBe(replacementAddr.toLowerCase());
        expect(storageAddrAfter.toLowerCase()).not.toBe(storageAddrBefore.toLowerCase());
      } finally {
        await rotateHubAssetStorage(
          ctx.hubAddress,
          deployer,
          'ContextGraphStorage',
          storageAddrBefore,
        );
      }
    },
    60_000,
  );

  it(
    'Hub rotation poller (generic): rotating an unknown contract name is ignored — no fields touched',
    async () => {
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);
      (adapter as any).provider.pollingInterval = 250;

      await (adapter as any).init();
      await drainHistoricalRotationEvents(adapter);

      const identityBefore: Contract = (adapter as any).contracts.identity;
      expect(identityBefore).toBeDefined();
      expect((adapter as any).initialized).toBe(true);

      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, ctx.provider);
      // Use a name NOT in BOUND_CONTRACT_INVALIDATORS. Hub.setContractAddress
      // accepts arbitrary strings and emits `NewContract` for first
      // registrations — exactly the noise we need to confirm the poller
      // safely allowlists.
      const unknownName = `RC12TestUnknown-${Date.now()}`;
      await rotateHubContract(ctx.hubAddress, deployer, unknownName, freshAddress());

      await pollHubRotations(adapter);

      expect((adapter as any).contracts.identity).toBe(identityBefore);
      expect((adapter as any).initialized).toBe(true);
    },
    30_000,
  );

  it(
    'withHubStaleRetryAny: marker error invalidates ALL boot-bound contracts, re-inits, and retries once',
    async () => {
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);
      (adapter as any).provider.pollingInterval = 250;
      await (adapter as any).init();
      await drainHistoricalRotationEvents(adapter);

      const identityBefore: Contract = (adapter as any).contracts.identity;
      expect(identityBefore).toBeDefined();
      const identityAddrBefore: string = await identityBefore.getAddress();
      await adapter.getKnowledgeAssetsLifecycleAddress();
      await adapter.getMinimumRequiredSignatures();
      expect((adapter as any).cachedKav10Address).toBeDefined();
      expect((adapter as any).cachedMinRequiredSignatures).toBeDefined();

      let calls = 0;
      let identityDuringRetry: Contract | undefined;
      const result = await (adapter as any).withHubStaleRetryAny(async () => {
        calls += 1;
        if (calls === 1) {
          // Snapshot what the retry path produced — invalidated then
          // re-resolved. Capturing it inside the closure proves the
          // wrapper called init() between the throw and the retry.
          throw new Error(
            'execution reverted (unknown custom error): UnauthorizedAccess(Only Contracts in Hub)',
          );
        }
        identityDuringRetry = (adapter as any).contracts.identity;
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(calls).toBe(2);
      // After self-heal: a fresh Identity handle is bound (same on-chain
      // address since we didn't rotate, but a distinct ethers.Contract
      // instance because resolveContract() built a new one) and the
      // adapter is initialised again.
      expect(identityDuringRetry).toBeDefined();
      expect(identityDuringRetry).not.toBe(identityBefore);
      const identityAddrAfter: string = await identityDuringRetry!.getAddress();
      expect(identityAddrAfter.toLowerCase()).toBe(identityAddrBefore.toLowerCase());
      expect((adapter as any).initialized).toBe(true);
      expect((adapter as any).cachedKav10Address).toBeUndefined();
      expect((adapter as any).cachedMinRequiredSignatures).toBeUndefined();
    },
    30_000,
  );

  it(
    'withHubStaleRetryAny: unrelated revert messages do NOT invalidate bindings and do NOT retry',
    async () => {
      const adapter = makeAdapter(ctx.rpcUrl, ctx.hubAddress, 600_000);
      (adapter as any).provider.pollingInterval = 250;
      await (adapter as any).init();
      await drainHistoricalRotationEvents(adapter);

      const identityBefore: Contract = (adapter as any).contracts.identity;
      expect(identityBefore).toBeDefined();

      let calls = 0;
      let caught: Error | null = null;
      try {
        await (adapter as any).withHubStaleRetryAny(async () => {
          calls += 1;
          throw new Error('execution reverted: ProfileDoesntExist(0)');
        });
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/ProfileDoesntExist/);
      expect(calls).toBe(1);

      // Same handle reference — wrapper didn't touch the cache.
      expect((adapter as any).contracts.identity).toBe(identityBefore);
      expect((adapter as any).initialized).toBe(true);
    },
    30_000,
  );
});
