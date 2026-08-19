// SPDX-License-Identifier: Apache-2.0

/**
 * GH#2270 PR #2300 r9 (3812794297) — the coherence guarantee of
 * {@link ChainAdapter.readKnowledgeAssetVersionSnapshot}, tested where it is PRODUCED.
 *
 * Recovery decides whether a recovered update is still current from the latest root and the root
 * count together. Read from endpoints at different heights, a fresh root beside a lagging count
 * says "current" about an old transaction in an A -> B -> A history — so the whole point of this
 * method is that both facts come from ONE provider at ONE pinned block. Tests that inject an
 * already-coherent pair cannot see that guarantee break; these drive the adapter itself.
 */

import { describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';

const KA_ID = 7n;

/** Anvil's well-known deterministic test key, as used by the sibling snapshot suite. */
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
  blockNumber: number | null;
  latestRoot: string | null;
  rootCount: bigint | null;
};

/** Ordered providers with the production empty-result policy modelled (see readProviderRetryingNull). */
function adapterOver(scripts: Script[], opts: { storageDeployed?: boolean } = {}) {
  const reads: Array<{ provider: number; call: string; blockTag: unknown }> = [];
  const providers = scripts.map((script, index) => ({
    __index: index,
    __script: script,
    async getBlockNumber() {
      if (script.blockNumber === null) throw Object.assign(new Error('no head'), { code: 'NETWORK_ERROR' });
      return script.blockNumber;
    },
  }));

  const a: any = new EVMChainAdapter(minimalConfig());
  a.initialized = true;
  a.init = async () => {};
  a.contracts = {
    knowledgeAssetStorage: opts.storageDeployed === false ? undefined : {},
  };
  a.rebindContract = (_c: unknown, provider: (typeof providers)[number]) => ({
    async getLatestMerkleRoot(_kaId: bigint, overrides: { blockTag?: unknown }) {
      reads.push({ provider: provider.__index, call: 'getLatestMerkleRoot', blockTag: overrides?.blockTag });
      if (provider.__script.latestRoot === null) return null;
      return provider.__script.latestRoot;
    },
    async getKnowledgeAssetUpdateContext(_kaId: bigint, overrides: { blockTag?: unknown }) {
      reads.push({ provider: provider.__index, call: 'getKnowledgeAssetUpdateContext', blockTag: overrides?.blockTag });
      return { merkleRootsCount: provider.__script.rootCount ?? 0n };
    },
  });
  const readOpts: Array<{ skipPreferred?: boolean }> = [];
  a.readProviderRetryingNull = async (
    _label: string,
    fn: (p: unknown) => Promise<unknown>,
    opts?: { skipPreferred?: boolean },
  ) => {
    readOpts.push(opts ?? {});
    let sawEmpty = false;
    for (const provider of providers) {
      try {
        const value = await fn(provider);
        if (value == null) { sawEmpty = true; continue; }
        return value;
      } catch {
        sawEmpty = true;
      }
    }
    return sawEmpty ? null : undefined;
  };
  return { adapter: a, reads, readOpts };
}

describe('EVMChainAdapter.readKnowledgeAssetVersionSnapshot [GH#2270 PR#2300 r9]', () => {
  it('reads the root AND the count from ONE provider at ONE pinned block', async () => {
    const { adapter, reads } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);

    const snapshot = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);

    expect(snapshot).toEqual({ latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n, blockNumber: 500 });
    // The coherence guarantee: same endpoint, same pinned height, for both facts. A regression that
    // drops the blockTag (or re-reads the head between calls) lets the pair straddle two blocks.
    expect(reads).toEqual([
      { provider: 0, call: 'getLatestMerkleRoot', blockTag: 500 },
      { provider: 0, call: 'getKnowledgeAssetUpdateContext', blockTag: 500 },
    ]);
  });

  it('asks for a TIP read, so endpoint stickiness cannot serve a stale-but-coherent pair [r10]', async () => {
    // 3812960544 — coherence is not currency. A preferred endpoint stuck at the first update
    // returns a perfectly coherent {root: A, count: 1} while the chain is at A -> B -> A with
    // count 3, and recovery would then read an old transaction as current. This is a
    // current-state question, so the read must skip endpoint preference.
    const { adapter, readOpts } = adapterOver([
      { blockNumber: 500, latestRoot: `0x${'aa'.repeat(32)}`, rootCount: 3n },
    ]);

    await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);

    expect(readOpts[0]?.skipPreferred).toBe(true);
  });

  it('fails the WHOLE pair over to the next endpoint rather than splicing', async () => {
    const { adapter, reads } = adapterOver([
      { blockNumber: null, latestRoot: null, rootCount: null },
      { blockNumber: 900, latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n },
    ]);

    const snapshot = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);

    expect(snapshot).toEqual({ latestRoot: `0x${'bb'.repeat(32)}`, rootCount: 5n, blockNumber: 900 });
    // Nothing was taken from the failed endpoint, so the returned pair cannot mix two views.
    expect(reads.every((r) => r.provider === 1)).toBe(true);
    expect(reads.map((r) => r.blockTag)).toEqual([900, 900]);
  });

  it('answers null when no endpoint can produce the pair, never a partial one', async () => {
    const { adapter } = adapterOver([
      { blockNumber: null, latestRoot: null, rootCount: null },
      { blockNumber: null, latestRoot: null, rootCount: null },
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
