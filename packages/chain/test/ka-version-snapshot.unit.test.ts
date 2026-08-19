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

function minimalConfig() {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
  } as never;
}

type Script = {
  /** The endpoint's FINALIZED height, or null when it cannot serve one. */
  blockNumber: number | null;
  /** When true, this endpoint fails chain-id validation (a wrong-chain RPC). */
  wrongChain?: boolean;
  latestRoot: string | null;
  rootCount: bigint;
  author?: string | null;
  publisher?: string | null;
};

const AUTHOR = `0x${'11'.repeat(20)}`;
const PUBLISHER = `0x${'22'.repeat(20)}`;

function adapterOver(scripts: Script[], opts: { storageDeployed?: boolean } = {}) {
  const reads: Array<{ provider: number; call: string; blockTag: unknown }> = [];
  const providers = scripts.map((script, index) => ({
    __index: index,
    __script: script,
    // r13 — the view is pinned to the FINALIZED block, because it drives a durable decision.
    async getBlock(tag: string) {
      if (tag !== 'finalized') throw new Error(`expected the finalized tag, got ${tag}`);
      if (script.blockNumber === null) throw Object.assign(new Error('no finalized view'), { code: 'NETWORK_ERROR' });
      return { number: script.blockNumber, hash: `0x${'99'.repeat(32)}` };
    },
  }));

  const validated: number[] = [];
  const a: any = new EVMChainAdapter(minimalConfig());
  a.ensureConfiguredStaticChainIdValidated = async (provider: (typeof providers)[number]) => {
    validated.push(provider.__index);
    if (provider.__script.wrongChain) throw new Error('configured static chainId mismatch');
    return 31337n;
  };
  a.initialized = true;
  a.init = async () => {};
  a.contracts = { knowledgeAssetStorage: opts.storageDeployed === false ? undefined : {} };
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
  return { adapter: a, reads, validated };
}

describe('EVMChainAdapter.readKnowledgeAssetVersionSnapshot [GH#2270 PR#2300]', () => {
  it('takes every fact for an endpoint at ONE pinned block', async () => {
    const { adapter, reads } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);

    const view = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);

    expect(view).toEqual({
      latestRoot: `0x${'aa'.repeat(32)}`,
      rootCount: 3n,
      latestAuthor: AUTHOR,
      latestPublisher: PUBLISHER,
      blockNumber: 500,
    });
    // Coherence: every read pinned to the SAME height. Re-reading the head between calls, or
    // dropping a blockTag, lets the view straddle two blocks — which is how a stale root ends up
    // beside a newer count.
    expect(reads.every((r) => r.blockTag === 500)).toBe(true);
    expect(reads.every((r) => r.provider === 0)).toBe(true);
    expect(reads).toHaveLength(4);
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
    // 3814317260 — the fan-out skipped the chain-id validation every normal adapter read performs,
    // so an accidentally configured RPC for another chain could answer with an ABI-compatible view
    // and WIN the poll by reporting a higher finalized block. Recovery would then materialize that
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
});
