// SPDX-License-Identifier: Apache-2.0

/**
 * GH#2270 PR #2300 — the guarantees of {@link ChainAdapter.readKnowledgeAssetVersionSnapshot},
 * tested where they are PRODUCED.
 *
 * Recovery asks this one question: is a recovered transaction still the current version? Getting
 * that wrong in the permissive direction stamps an old transaction's provenance over newer state,
 * so every fact must come from one endpoint at one pinned block. Configured RPCs are ordered
 * authorities: use the primary's complete view, then fall back in order only when it cannot
 * answer. Consumers that inject an already-good view cannot see either guarantee break; these
 * drive the adapter and record every endpoint read, including reads that yield no tuple.
 */

import { describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { RPC_READ_STALL_TIMEOUT_MS } from '../src/evm-adapter-constants.js';
import { withRpcRequestContext } from '../src/rpc-request-transport.js';
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';

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
  /** Fail a numeric block-pinned contract call without making chain/head reads fail. */
  pinnedFailures?: { call: string; count: number; code: string };
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
  const attempts: Array<{ provider: number; call: string; blockTag?: unknown }> = [];
  const providers = scripts.map((script, index) => ({
    __index: index,
    __script: script,
    async getNetwork() {
      attempts.push({ provider: index, call: 'getNetwork' });
      return { chainId: script.wrongChain ? 999n : 31337n };
    },
    async getBlock(tag: 'latest' | number) {
      attempts.push({ provider: index, call: 'getBlock', blockTag: tag });
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
    const record = (call: string, overrides: { blockTag?: unknown }) => {
      const read = { provider: provider.__index, call, blockTag: overrides?.blockTag };
      reads.push(read);
      attempts.push(read);
      const failure = provider.__script.pinnedFailures;
      if (failure?.call === call && failure.count > 0) {
        failure.count -= 1;
        throw Object.assign(new Error('RPC27 Unknown state for numeric block-pinned eth_call'), {
          code: failure.code,
        });
      }
    };
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
  return { adapter: a, reads, attempts, validated, providers, storage };
}

function snapshotAt(blockNumber = 500) {
  return {
    knowledgeAssetId: KA_ID,
    latestRoot: `0x${'aa'.repeat(32)}`,
    rootCount: 3n,
    latestAuthor: AUTHOR,
    latestPublisher: PUBLISHER,
    blockNumber,
    blockHash: hashForBlock(blockNumber),
    knowledgeAssetStorageAddress: KAS_ADDRESS,
    knowledgeAssetStorageGeneration: 0,
  };
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

  it('uses the primary complete snapshot without reading higher or disagreeing fallbacks', async () => {
    const { adapter, attempts, validated } = adapterOver([
      { blockNumber: 100, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 1n },
      { blockNumber: 103, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 3n },
      { blockNumber: 100, blockHash: `0x${'99'.repeat(32)}`, latestRoot: null, rootCount: 9n },
    ]);

    const view = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);

    expect(view).toMatchObject({ blockNumber: 100, rootCount: 1n, latestRoot: `0x${'aa'.repeat(32)}` });
    expect(validated).toEqual([0]);
    expect(attempts).toHaveLength(6);
    expect(attempts.every((attempt) => attempt.provider === 0)).toBe(true);
  });

  it('a healthy primary completes with a configured fallback that rejects pinned eth_call', async () => {
    const { adapter, attempts, providers } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      {
        blockNumber: 900,
        latestRoot: `0x${'bb'.repeat(32)}`,
        rootCount: 5n,
        pinnedFailures: { call: 'getLatestMerkleRoot', count: 1, code: 'CALL_EXCEPTION' },
      },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toMatchObject(snapshotAt());
    expect(attempts.every((attempt) => attempt.provider === 0)).toBe(true);
    expect(providers[1]!.__script.pinnedFailures!.count).toBe(1);
  });

  it('uses fallback1 after the primary fails and never asks fallback2', async () => {
    const { adapter, attempts, validated } = adapterOver([
      { blockNumber: null, latestRoot: null, rootCount: 0n },
      { blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n },
      { blockNumber: 999, latestRoot: `0x${'cc'.repeat(32)}`, rootCount: 6n },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toMatchObject({
      blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n,
    });
    expect(validated).toEqual([0, 0, 1]);
    expect(attempts.map((attempt) => attempt.provider)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  });

  it('uses fallback2 only after primary and fallback1 each fail', async () => {
    const { adapter, attempts, validated, reads } = adapterOver([
      { blockNumber: 1_000, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 9n, wrongChain: true },
      { blockNumber: 999, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 8n, author: null },
      { blockNumber: 900, latestRoot: `0x${'cc'.repeat(32)}`, rootCount: 5n },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toMatchObject({
      blockNumber: 900, latestRoot: `0x${'cc'.repeat(32)}`, rootCount: 5n,
    });
    expect(validated).toEqual([0, 1, 2]);
    expect(attempts.map((attempt) => attempt.provider)).toEqual([0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(reads.filter((read) => read.provider === 0)).toEqual([]);
    expect(reads.filter((read) => read.provider === 2)).toHaveLength(4);
    expect(reads.filter((read) => read.provider === 2).every((read) => read.blockTag === 900)).toBe(true);
  });

  it('a missing canonical hash disqualifies its endpoint', async () => {
    const root = `0x${'aa'.repeat(32)}`;
    const missing = adapterOver([
      { blockNumber: 500, blockHash: null, latestRoot: root, rootCount: 3n },
    ]).adapter;
    await expect(missing.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();

    const { adapter, reads } = adapterOver([
      { blockNumber: 999, blockHash: null, latestRoot: root, rootCount: 9n },
      { blockNumber: 500, latestRoot: root, rootCount: 3n },
    ]);
    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toMatchObject(snapshotAt());
    expect(reads.every((read) => read.provider === 1 && read.blockTag === 500)).toBe(true);
    expect(reads).toHaveLength(4);
  });

  it('retries a transient primary blip once before asking any fallback', async () => {
    const { adapter, attempts, providers } = adapterOver([
      {
        blockNumber: 500,
        latestRoot: `0x${'aa'.repeat(32)}`,
        rootCount: 3n,
        headFailures: { count: 1, code: 'SERVER_ERROR' },
      },
      { blockNumber: 502, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 4n },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toMatchObject(snapshotAt());
    expect(attempts.filter((attempt) => attempt.call === 'getBlock')).toEqual([
      { provider: 0, call: 'getBlock', blockTag: 'latest' },
      { provider: 0, call: 'getBlock', blockTag: 'latest' },
    ]);
    expect(attempts.every((attempt) => attempt.provider === 0)).toBe(true);
    expect(providers[0]!.__script.headFailures!.count).toBe(0);
  });

  it.each([
    'getKnowledgeAssetUpdateContext',
    'getLatestMerkleRootAuthor',
    'getLatestMerkleRootPublisher',
  ] as const)('local capacity from %s wins over an earlier rejected tuple slot', async (capacityGetter) => {
    const { adapter, attempts, reads } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      { blockNumber: 502, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 4n },
    ]);
    const originalRebind = (adapter as any).rebindContract;
    (adapter as any).rebindContract = (...args: unknown[]) => {
      const bound = originalRebind(...args);
      if ((args[1] as { __index: number }).__index !== 0) return bound;
      const readRoot = bound.getLatestMerkleRoot;
      bound.getLatestMerkleRoot = async (...readArgs: unknown[]) => {
        await readRoot(...readArgs);
        throw Object.assign(new Error('unusable pinned root'), { code: 'CALL_EXCEPTION' });
      };
      const readCapacityGetter = bound[capacityGetter];
      bound[capacityGetter] = async (...readArgs: unknown[]) => {
        await readCapacityGetter(...readArgs);
        throw new RpcRequestGovernorQueueFullError(1);
      };
      return bound;
    };

    // The complete settled tuple contains local admission pressure even though
    // slot zero fails deterministically. Falling back cannot create capacity;
    // preserve that original local verdict instead of the first array slot.
    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();
    expect(attempts.every((attempt) => attempt.provider === 0)).toBe(true);
    expect(attempts.filter((attempt) => attempt.call === 'getNetwork')).toEqual([
      { provider: 0, call: 'getNetwork' },
    ]);
    expect(attempts.filter((attempt) => attempt.call === 'getBlock')).toEqual([
      { provider: 0, call: 'getBlock', blockTag: 'latest' },
    ]);
    expect(reads).toHaveLength(4);
    expect(reads.every((read) => read.provider === 0 && read.blockTag === 500)).toBe(true);
    expect(reads.map((read) => read.call).sort()).toEqual([
      'getLatestMerkleRoot', 'getKnowledgeAssetUpdateContext',
      'getLatestMerkleRootAuthor', 'getLatestMerkleRootPublisher',
    ].sort());
  });

  it('a deterministic pinned eth_call failure falls back without retrying or mixing the tuple', async () => {
    const fallbackAuthor = `0x${'44'.repeat(20)}`;
    const fallbackPublisher = `0x${'55'.repeat(20)}`;
    const { adapter, attempts, reads, providers } = adapterOver([
      {
        blockNumber: 999,
        latestRoot: `0x${'aa'.repeat(32)}`,
        rootCount: 9n,
        pinnedFailures: { call: 'getKnowledgeAssetUpdateContext', count: 1, code: 'CALL_EXCEPTION' },
      },
      {
        blockNumber: 900,
        latestRoot: `0x${'bb'.repeat(32)}`,
        rootCount: 5n,
        author: fallbackAuthor,
        publisher: fallbackPublisher,
      },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toMatchObject({
      latestRoot: `0x${'bb'.repeat(32)}`,
      rootCount: 5n,
      latestAuthor: fallbackAuthor,
      latestPublisher: fallbackPublisher,
      blockNumber: 900,
      blockHash: hashForBlock(900),
    });
    expect(providers[0]!.__script.pinnedFailures!.count).toBe(0);
    expect(attempts.filter((attempt) => attempt.call === 'getBlock')).toEqual([
      { provider: 0, call: 'getBlock', blockTag: 'latest' },
      { provider: 1, call: 'getBlock', blockTag: 'latest' },
    ]);
    expect(reads.filter((read) => read.provider === 0)).toHaveLength(4);
    expect(reads.filter((read) => read.provider === 1)).toHaveLength(4);
    expect(reads.every((read) => read.blockTag === (read.provider === 0 ? 999 : 900))).toBe(true);
  });

  it('two transient primary failures exhaust its one retry before fallback1', async () => {
    const { adapter, attempts } = adapterOver([
      {
        blockNumber: 999,
        latestRoot: `0x${'aa'.repeat(32)}`,
        rootCount: 9n,
        headFailures: { count: 2, code: 'SERVER_ERROR' },
      },
      { blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toMatchObject({
      blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n,
    });
    expect(attempts.map((attempt) => attempt.provider)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  });

  it('a missing attribution disqualifies its endpoint without returning a partial view', async () => {
    const { adapter, reads } = adapterOver([
      { blockNumber: 999, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 9n, author: null },
      { blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toMatchObject({
      blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n,
      latestAuthor: AUTHOR, latestPublisher: PUBLISHER,
    });
    expect(reads.filter((read) => read.provider === 1)).toHaveLength(4);
    expect(reads.filter((read) => read.provider === 1).every((read) => read.blockTag === 900)).toBe(true);
  });

  it('a wrong-chain primary cannot contribute a view and falls back before reading its head', async () => {
    const { adapter, attempts, validated } = adapterOver([
      { blockNumber: 5_000, latestRoot: `0x${'ff'.repeat(32)}`, rootCount: 99n, wrongChain: true },
      { blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n },
    ]);

    await expect(adapter.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toMatchObject({
      blockNumber: 900, rootCount: 5n,
    });
    expect(validated).toEqual([0, 1]);
    expect(attempts.filter((attempt) => attempt.provider === 0)).toEqual([
      { provider: 0, call: 'getNetwork' },
    ]);
  });

  it('a healthy primary completes without waiting for a stalled unused fallback', async () => {
    const { adapter, attempts } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      { blockNumber: 500, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n, stall: true },
    ]);
    const controller = new AbortController();
    let result: unknown;
    vi.useFakeTimers();
    const pending = adapter.readKnowledgeAssetVersionSnapshot(KA_ID, { signal: controller.signal })
      .then((view: unknown) => { result = view; });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject(snapshotAt());
      expect(attempts.every((attempt) => attempt.provider === 0)).toBe(true);
    } finally {
      controller.abort();
      await pending;
      vi.useRealTimers();
    }
  });

  it('a stalled primary reaches fallback1 within the endpoint cap and is not retried later', async () => {
    const { adapter, attempts } = adapterOver([
      { blockNumber: 999, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 9n, stall: true },
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      { blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n },
    ]);
    const controller = new AbortController();
    let result: unknown;
    vi.useFakeTimers();
    const pending = adapter.readKnowledgeAssetVersionSnapshot(KA_ID, { signal: controller.signal })
      .then((view: unknown) => { result = view; });
    try {
      await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS + 1);
      expect(result).toMatchObject(snapshotAt());
      expect(attempts.map((attempt) => attempt.provider)).toEqual([0, 0, 1, 1, 1, 1, 1, 1]);
      await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS + 250);
      expect(attempts.filter((attempt) => attempt.provider === 0)).toEqual([
        { provider: 0, call: 'getNetwork' },
        { provider: 0, call: 'getBlock', blockTag: 'latest' },
      ]);
    } finally {
      controller.abort();
      await pending;
      vi.useRealTimers();
    }
  });

  it('an abort after the primary starts completes the snapshot without asking fallback1', async () => {
    const { adapter, attempts, providers } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n, stall: true },
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const getBlock = providers[0]!.getBlock.bind(providers[0]);
    providers[0]!.getBlock = async (tag: 'latest' | number) => {
      started();
      return getBlock(tag);
    };
    const controller = new AbortController();

    const pending = adapter.readKnowledgeAssetVersionSnapshot(KA_ID, { signal: controller.signal });
    await entered;
    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(attempts.every((attempt) => attempt.provider === 0)).toBe(true);
  });

  it('an inherited already-aborted request starts no snapshot endpoint reads', async () => {
    const { adapter, attempts, validated } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);

    await expect(withRpcRequestContext(
      { signal: AbortSignal.abort() },
      () => adapter.readKnowledgeAssetVersionSnapshot(KA_ID),
    )).resolves.toBeNull();
    expect(attempts).toEqual([]);
    expect(validated).toEqual([]);
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

  it('currentness accepts a primary header despite a broken unused fallback', async () => {
    const { adapter, attempts, reads } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      { blockNumber: null, latestRoot: null, rootCount: 0n },
    ]);

    await expect(adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshotAt())).resolves.toBe(true);
    expect(attempts).toEqual([
      { provider: 0, call: 'getNetwork' },
      { provider: 0, call: 'getBlock', blockTag: 'latest' },
    ]);
    expect(reads).toEqual([]);
  });

  it.each([
    { label: 'a newer primary height', blockNumber: 501, blockHash: hashForBlock(501) },
    { label: 'a different primary hash', blockNumber: 500, blockHash: `0x${'99'.repeat(32)}` },
  ])('currentness stops at $label instead of looking for a matching fallback', async (primary) => {
    const { adapter, attempts } = adapterOver([
      { ...primary, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);

    await expect(adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshotAt())).resolves.toBe(false);
    expect(attempts).toEqual([
      { provider: 0, call: 'getNetwork' },
      { provider: 0, call: 'getBlock', blockTag: 'latest' },
    ]);
  });

  it('currentness uses fallback1 only after the primary cannot supply a header', async () => {
    const { adapter, attempts, reads } = adapterOver([
      { blockNumber: null, latestRoot: null, rootCount: 0n },
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      { blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n },
    ]);

    await expect(adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshotAt())).resolves.toBe(true);
    expect(attempts.map((attempt) => attempt.provider)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(reads).toEqual([]);
  });

  it('currentness uses fallback2 after wrong-chain and missing-hash headers', async () => {
    const { adapter, attempts } = adapterOver([
      { blockNumber: 500, latestRoot: null, rootCount: 0n, wrongChain: true },
      { blockNumber: 500, blockHash: null, latestRoot: null, rootCount: 0n },
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);

    await expect(adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshotAt())).resolves.toBe(true);
    expect(attempts).toEqual([
      { provider: 0, call: 'getNetwork' },
      { provider: 1, call: 'getNetwork' },
      { provider: 1, call: 'getBlock', blockTag: 'latest' },
      { provider: 2, call: 'getNetwork' },
      { provider: 2, call: 'getBlock', blockTag: 'latest' },
    ]);
  });

  it('currentness validates the header at the configured confirmation depth', async () => {
    const { adapter, attempts, reads } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ], { finalityConfirmations: 3 });

    await expect(adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshotAt(498))).resolves.toBe(true);
    expect(attempts).toEqual([
      { provider: 0, call: 'getNetwork' },
      { provider: 0, call: 'getBlock', blockTag: 'latest' },
      { provider: 0, call: 'getBlock', blockTag: 498 },
    ]);
    expect(reads).toEqual([]);
  });

  it('currentness is false when no endpoint can provide a usable header', async () => {
    const { adapter } = adapterOver([
      { blockNumber: 500, latestRoot: null, rootCount: 0n, wrongChain: true },
      { blockNumber: 500, blockHash: null, latestRoot: null, rootCount: 0n },
    ]);

    await expect(adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshotAt())).resolves.toBe(false);
  });

  it('currentness does not wait for a stalled unused fallback', async () => {
    const { adapter, attempts } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
      { blockNumber: 500, latestRoot: null, rootCount: 0n, stall: true },
    ]);
    const controller = new AbortController();
    let result: unknown;
    let failure: unknown;
    vi.useFakeTimers();
    const pending = adapter.knowledgeAssetVersionSnapshotIsCurrent(
      KA_ID, snapshotAt(), { signal: controller.signal },
    ).then((value: unknown) => { result = value; }, (error: unknown) => { failure = error; });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toBeUndefined();
      expect(result).toBe(true);
      expect(attempts.every((attempt) => attempt.provider === 0)).toBe(true);
    } finally {
      controller.abort();
      await pending;
      vi.useRealTimers();
    }
  });

  it('an inherited already-aborted request propagates from currentness without endpoint reads', async () => {
    const { adapter, attempts } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);

    await expect(withRpcRequestContext(
      { signal: AbortSignal.abort() },
      () => adapter.knowledgeAssetVersionSnapshotIsCurrent(KA_ID, snapshotAt()),
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toEqual([]);
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
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const provider = (adapter as any).providers[0];
    const getBlock = provider.getBlock.bind(provider);
    provider.getBlock = async (tag: 'latest' | number) => {
      started();
      return getBlock(tag);
    };
    const controller = new AbortController();
    const pending = adapter.knowledgeAssetVersionSnapshotIsCurrent(
      KA_ID,
      snapshot!,
      { signal: controller.signal },
    );
    await entered;
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
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const originalRebind = (adapter as any).rebindContract;
    (adapter as any).rebindContract = (...args: unknown[]) => {
      const bound = originalRebind(...args);
      const original = bound.getLatestMerkleRoot;
      bound.getLatestMerkleRoot = async (...callArgs: unknown[]) => {
        started();
        await gate;
        return original(...callArgs);
      };
      return bound;
    };

    const pending = adapter.readKnowledgeAssetVersionSnapshot(KA_ID);
    await entered;
    (adapter as any).contracts.knowledgeAssetStorage = { target: KAS_ADDRESS };
    (adapter as any).knowledgeAssetStorageBindingGeneration += 1;
    release();

    await expect(pending).resolves.toBeNull();
    expect((adapter as any).contracts.knowledgeAssetStorage).not.toBe(storage);
  });
});
