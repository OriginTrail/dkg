// SPDX-License-Identifier: Apache-2.0

/**
 * GH#2270 PR #2300 — the guarantees of {@link ChainAdapter.readKnowledgeAssetVersionSnapshot},
 * tested where they are PRODUCED.
 *
 * Recovery asks this one question: is a recovered transaction still the current version? Getting
 * that wrong in the permissive direction stamps an old transaction's provenance over newer state,
 * so the view it answers with must be both COHERENT (every fact from one endpoint at one pinned
 * block) and CURRENT (the most advanced endpoint, not merely the first that replies). Consumers
 * that inject an already-good view cannot see either guarantee break; these drive the adapter.
 */

import { describe, expect, it } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';

const KA_ID = 7n;
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function minimalConfig(finalityConfirmations = 1) {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    finalityConfirmations,
  } as never;
}

type Script = {
  /** The endpoint's current head height, or null when it cannot serve one. */
  blockNumber: number | null;
  /** When true, this endpoint fails chain-id validation (a wrong-chain RPC). */
  wrongChain?: boolean;
  /** When true, this endpoint never settles — the stalled-RPC case cancellation exists for. */
  stall?: boolean;
  /** Fail the first N head reads with `code` before serving `blockNumber` (transient-blip cases). */
  headFailures?: { count: number; code: string };
  /** Override the canonical hash at the scripted head; null models a missing hash. */
  blockHash?: string | null;
  latestRoot: string | null;
  rootCount: bigint;
  author?: string | null;
  publisher?: string | null;
};

const AUTHOR = `0x${'11'.repeat(20)}`;
const PUBLISHER = `0x${'22'.repeat(20)}`;
const KAS_ADDRESS = `0x${'33'.repeat(20)}`;

function hashForBlock(blockNumber: number): string {
  return `0x${blockNumber.toString(16).padStart(64, '0')}`;
}

function adapterOver(
  scripts: Script[],
  opts: { storageDeployed?: boolean; finalityConfirmations?: number } = {},
) {
  const reads: Array<{ provider: number; call: string; blockTag: unknown }> = [];
  const providers = scripts.map((script, index) => ({
    __index: index,
    __script: script,
    async getNetwork() {
      return { chainId: script.wrongChain ? 999n : 31337n };
    },
    async getBlock(tag: 'latest' | number) {
      if (script.stall) return new Promise(() => {}) as never;
      if (tag === 'latest' && script.headFailures && script.headFailures.count > 0) {
        script.headFailures.count -= 1;
        throw Object.assign(new Error('scripted head-read failure'), { code: script.headFailures.code });
      }
      const headBlockNumber = script.blockNumber;
      if (headBlockNumber === null) throw Object.assign(new Error('no head view'), { code: 'NETWORK_ERROR' });
      const number = tag === 'latest' ? headBlockNumber : tag;
      return {
        number,
        hash: tag === 'latest' && script.blockHash !== undefined
          ? script.blockHash
          : hashForBlock(number),
      };
    },
  }));

  const validated: number[] = [];
  const a: any = new EVMChainAdapter(minimalConfig(opts.finalityConfirmations));
  a.ensureConfiguredStaticChainIdValidated = async (provider: (typeof providers)[number]) => {
    // r17 (3814893080) — faithful to production: under the supported `staticNetwork: false`
    // mode this validator returns early WITHOUT comparing anything, so the harness must not
    // fabricate a rejection here. A wrong-chain endpoint may only be rejected by the explicit
    // per-endpoint comparison in the snapshot read itself.
    validated.push(provider.__index);
    return 31337n;
  };
  a.initialized = true;
  a.init = async () => {};
  const storage = { target: KAS_ADDRESS };
  a.contracts = { knowledgeAssetStorage: opts.storageDeployed === false ? undefined : storage };
  a.providers = providers;
  a.rebindContract = (_c: unknown, provider: (typeof providers)[number]) => {
    const record = (call: string, overrides: { blockTag?: unknown }) =>
      reads.push({ provider: provider.__index, call, blockTag: overrides?.blockTag });
    return {
      async getLatestMerkleRoot(_kaId: bigint, o: { blockTag?: unknown }) {
        record('getLatestMerkleRoot', o);
        return provider.__script.latestRoot;
      },
      async getKnowledgeAssetUpdateContext(_kaId: bigint, o: { blockTag?: unknown }) {
        record('getKnowledgeAssetUpdateContext', o);
        return { merkleRootsCount: provider.__script.rootCount };
      },
      async getLatestMerkleRootAuthor(_kaId: bigint, o: { blockTag?: unknown }) {
        record('getLatestMerkleRootAuthor', o);
        return provider.__script.author === undefined ? AUTHOR : provider.__script.author;
      },
      async getLatestMerkleRootPublisher(_kaId: bigint, o: { blockTag?: unknown }) {
        record('getLatestMerkleRootPublisher', o);
        return provider.__script.publisher === undefined ? PUBLISHER : provider.__script.publisher;
      },
    };
  };
  return { adapter: a, reads, validated, providers, storage };
}

describe('EVMChainAdapter.readKnowledgeAssetVersionSnapshot [GH#2270 PR#2300]', () => {
  it('takes every fact for an endpoint at ONE pinned block', async () => {
    const { adapter, reads } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);

    const view = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);

    expect(view).toEqual({
      knowledgeAssetId: KA_ID,
      latestRoot: `0x${'aa'.repeat(32)}`,
      rootCount: 3n,
      latestAuthor: AUTHOR,
      latestPublisher: PUBLISHER,
      blockNumber: 500,
      blockHash: hashForBlock(500),
      knowledgeAssetStorageAddress: KAS_ADDRESS,
      knowledgeAssetStorageGeneration: 0,
    });
    // Coherence: every read pinned to the SAME height. Re-reading the head between calls, or
    // dropping a blockTag, lets the view straddle two blocks — which is how a stale root ends up
    // beside a newer count.
    expect(reads.every((r) => r.blockTag === 500)).toBe(true);
    expect(reads.every((r) => r.provider === 0)).toBe(true);
    expect(reads).toHaveLength(4);
  });

  it('uses the configured confirmation depth for the pinned block', async () => {
    const { adapter, reads } = adapterOver(
      [{ blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n }],
      { finalityConfirmations: 3 },
    );

    const view = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);

    expect(view?.blockNumber).toBe(498);
    expect(reads.every((read) => read.blockTag === 498)).toBe(true);
  });

  it('returns no snapshot before the chain has the configured confirmation depth', async () => {
    const { adapter, reads } = adapterOver(
      [{ blockNumber: 1, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n }],
      { finalityConfirmations: 3 },
    );

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();
    expect(reads).toEqual([]);
  });

  it('takes the MOST ADVANCED endpoint, not the first that answers [r11]', async () => {
    // A healthy endpoint can still be behind. First-success ordering would hand recovery a
    // perfectly coherent but stale view — {root A, count 1} while the chain is at A -> B -> A —
    // and an old transaction would read as current.
    const { adapter } = adapterOver([
      { blockNumber: 100, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 1n },
      { blockNumber: 103, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);

    const view = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);

    expect(view?.blockNumber).toBe(103);
    expect(view?.rootCount).toBe(3n);
  });

  it('an endpoint that cannot answer makes the whole poll inconclusive [r12]', async () => {
    // 3813506086 — taking the best of whoever answered does not establish currency: the endpoint
    // that failed is exactly the one that might have been ahead, so a stale-but-complete view
    // would win. Anything short of unanimity is "cannot establish", and the caller defers.
    const { adapter } = adapterOver([
      { blockNumber: null, latestRoot: null, rootCount: 0n },
      { blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();
  });

  it('rejects same-height provider disagreement and missing canonical hashes', async () => {
    const root = `0x${'aa'.repeat(32)}`;
    const disagreeing = adapterOver([
      { blockNumber: 500, blockHash: `0x${'01'.repeat(32)}`, latestRoot: root, rootCount: 3n },
      { blockNumber: 500, blockHash: `0x${'02'.repeat(32)}`, latestRoot: root, rootCount: 3n },
    ]).adapter;
    await expect(disagreeing.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();

    const missing = adapterOver([
      { blockNumber: 500, blockHash: null, latestRoot: root, rootCount: 3n },
    ]).adapter;
    await expect(missing.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();
  });

  it('a single transient blip on one endpoint does not void the unanimity poll', async () => {
    // The blip endpoint fails its first head read with a transient transport code and answers
    // normally on the in-place retry. Unanimity ("every configured endpoint reports a complete
    // view") is judged over the retried answer, so one flaky tick no longer costs the caller a
    // whole backoff cycle.
    const { adapter } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      {
        blockNumber: 502,
        latestRoot: `0x${'bb'.repeat(32)}`,
        rootCount: 4n,
        headFailures: { count: 1, code: 'SERVER_ERROR' },
      },
    ]);

    const view = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);

    expect(view).toMatchObject({ latestRoot: `0x${'bb'.repeat(32)}`, blockNumber: 502 });
  });

  it('a deterministic failure disqualifies its endpoint with NO retry — the poll stays inconclusive', async () => {
    // CALL_EXCEPTION is an ANSWER, not an outage: re-asking cannot change it, so the retry must
    // not apply. The endpoint would have answered on a second ask (the script only fails once) —
    // if this row ever sees a snapshot, the retry has started second-guessing deterministic
    // classifications.
    const { adapter } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      {
        blockNumber: 502,
        latestRoot: `0x${'bb'.repeat(32)}`,
        rootCount: 4n,
        headFailures: { count: 1, code: 'CALL_EXCEPTION' },
      },
    ]);

    expect(await adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).toBeNull();
  });

  it('a second consecutive transient failure still voids the poll — the retry budget is one', async () => {
    const { adapter } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      {
        blockNumber: 502,
        latestRoot: `0x${'bb'.repeat(32)}`,
        rootCount: 4n,
        headFailures: { count: 2, code: 'SERVER_ERROR' },
      },
    ]);

    expect(await adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).toBeNull();
  });

  it('a partial view is never returned — a missing attribution disqualifies its endpoint', async () => {
    const { adapter } = adapterOver([
      { blockNumber: 999, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 9n, author: null },
      { blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n },
    ]);

    // The incomplete endpoint is the MOST ADVANCED one — precisely the answer that would have
    // mattered — so the poll is inconclusive rather than settling for the endpoint behind it.
    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();
  });

  it('a WRONG-CHAIN endpoint cannot contribute a view, however far ahead it is [r15]', async () => {
    // 3814317260 / 3814893080 — the fan-out skipped the identity check every normal adapter read
    // performs, and the shared static-mode validator is a NO-OP under `staticNetwork: false`, so
    // the endpoint's chain id is now compared explicitly against the configured one.
    // so an accidentally configured RPC for another chain could answer with an ABI-compatible view
    // and WIN the poll by reporting a higher confirmation-depth block. Recovery would then materialize that
    // chain's root and attribution. It is now validated per endpoint before its view is eligible —
    // and because the poll must be unanimous, a wrong-chain endpoint makes the answer inconclusive
    // rather than silently handing the decision to the remaining one.
    const { adapter, validated } = adapterOver([
      { blockNumber: 5_000, latestRoot: `0x${'ff'.repeat(32)}`, rootCount: 99n, wrongChain: true },
      { blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();
    expect(validated).toContain(0);
  });

  it('an abort completes the snapshot read rather than waiting out a stalled endpoint [r16]', async () => {
    // 3814610248 — this poll gates durable recovery and fans out over every provider, so without a
    // cancellation row a regression could leave recovery waiting on one stalled RPC indefinitely
    // while every other snapshot row stayed green.
    const { adapter } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n, stall: true },
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);
    const controller = new AbortController();

    const pending = adapter.readKnowledgeAssetVersionSnapshot(KA_ID, { signal: controller.signal });
    controller.abort();

    await expect(pending).resolves.toBeNull();
  });

  it('answers null when no endpoint can produce a view', async () => {
    const { adapter } = adapterOver([
      { blockNumber: null, latestRoot: null, rootCount: 0n },
      { blockNumber: null, latestRoot: null, rootCount: 0n },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();
  });

  it('answers null when the storage contract is not deployed', async () => {
    const { adapter } = adapterOver(
      [{ blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n }],
      { storageDeployed: false },
    );

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();
  });

  it('validates a snapshot only while its finalized hash and exact KAS generation remain current', async () => {
    const script: Script = {
      blockNumber: 500,
      blockHash: `0x${'50'.repeat(32)}`,
      latestRoot: `0x${'aa'.repeat(32)}`,
      rootCount: 3n,
    };
    const { adapter } = adapterOver([script]);
    const snapshot = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);
    expect(snapshot).not.toBeNull();
    await expect(adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshot!))
      .resolves.toBe(true);
    await expect(adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID + 1n, snapshot!))
      .resolves.toBe(false);

    script.blockHash = `0x${'51'.repeat(32)}`;
    await expect(adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshot!))
      .resolves.toBe(false);

    script.blockHash = `0x${'50'.repeat(32)}`;
    (adapter as any).knowledgeAssetStorageBindingGeneration += 1;
    await expect(adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshot!))
      .resolves.toBe(false);
  });

  it('propagates abort while a currentness header read is stalled', async () => {
    const script: Script = {
      blockNumber: 500,
      latestRoot: `0x${'aa'.repeat(32)}`,
      rootCount: 3n,
    };
    const { adapter } = adapterOver([script]);
    const snapshot = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);
    expect(snapshot).not.toBeNull();
    script.stall = true;
    const controller = new AbortController();
    const pending = adapter.knowledgeAssetVersionSnapshotIsCurrent(
      KA_ID,
      snapshot!,
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a late currentness result after a same-address KAS object replacement', async () => {
    const script: Script = {
      blockNumber: 500,
      latestRoot: `0x${'aa'.repeat(32)}`,
      rootCount: 3n,
    };
    const { adapter, providers, storage } = adapterOver([script]);
    const snapshot = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);
    expect(snapshot).not.toBeNull();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const originalGetBlock = providers[0]!.getBlock.bind(providers[0]);
    providers[0]!.getBlock = async (tag: 'latest' | number) => {
      started();
      await gate;
      return originalGetBlock(tag);
    };

    const pending = adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshot!);
    await entered;
    (adapter as any).contracts.knowledgeAssetStorage = { target: KAS_ADDRESS };
    release();

    await expect(pending).resolves.toBe(false);
    expect((adapter as any).contracts.knowledgeAssetStorage).not.toBe(storage);
  });

  it('rejects a late snapshot when the KAS binding changes during its tuple reads', async () => {
    const { adapter, storage } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalRebind = (adapter as any).rebindContract;
    (adapter as any).rebindContract = (...args: unknown[]) => {
      const bound = originalRebind(...args);
      const original = bound.getLatestMerkleRoot;
      bound.getLatestMerkleRoot = async (...callArgs: unknown[]) => {
        await gate;
        return original(...callArgs);
      };
      return bound;
    };

    const pending = adapter.readKnowledgeAssetVersionSnapshot(KA_ID);
    await Promise.resolve();
    (adapter as any).contracts.knowledgeAssetStorage = { target: KAS_ADDRESS };
    (adapter as any).knowledgeAssetStorageBindingGeneration += 1;
    release();

    await expect(pending).resolves.toBeNull();
    expect((adapter as any).contracts.knowledgeAssetStorage).not.toBe(storage);
  });
});
