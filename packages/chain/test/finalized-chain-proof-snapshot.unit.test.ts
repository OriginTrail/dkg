/**
 * GH#2270 PR-3 r4 — `readFinalizedChainProofSnapshot`: the release-by-absence pair must be
 * observed at ONE finalized block on ONE provider.
 *
 * The defect class this closes: read separately, the nonce proof and the identity proof can be
 * served by different endpoints at different heights. A fresh endpoint says the nonce is consumed;
 * a lagging one has not seen the replacement's mint and says the identity is absent. Each answer
 * is true of ITS block, but their conjunction — "consumed and unminted" — was never true of any
 * single chain state, and it is exactly the conjunction that authorises a resend. These rows pin
 * the mechanics that make the splice impossible: both state reads carry the SAME pinned block
 * number, the pin comes from the SAME provider that serves the reads, and a fallback endpoint's
 * snapshot is that endpoint's own consistent pair rather than a mix.
 */
import { describe, expect, it } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { MockChainAdapter } from '../src/mock-adapter.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const KA_ID = 42n;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;

// Hardhat's well-known throwaway dev keys, as in evm-adapter.unit.test.ts — never a real secret.
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

type ProviderScript = {
  finalized: { number: number; hash: string } | null | Error;
  nonceAt: (address: string, blockTag: unknown) => Promise<number>;
  ownerAt?: (kaId: bigint, overrides: { blockTag?: unknown }) => Promise<string>;
};

/**
 * An adapter whose failover loop is a plain ordered walk over scripted providers — enough to
 * observe which provider served the snapshot and which blockTag each read carried, which is what
 * every row here is about.
 */
function adapterOver(scripts: ProviderScript[], opts: { storageDeployed?: boolean } = {}) {
  const calls: Array<{ provider: number; read: string; blockTag: unknown }> = [];
  const providers = scripts.map((script, index) => ({
    async getBlock(tag: string) {
      if (tag !== 'finalized') throw new Error(`expected the finalized tag, got ${tag}`);
      if (script.finalized instanceof Error) throw script.finalized;
      return script.finalized;
    },
    async getTransactionCount(address: string, blockTag: unknown) {
      calls.push({ provider: index, read: 'nonce', blockTag });
      return script.nonceAt(address, blockTag);
    },
    __index: index,
    __script: script,
  }));

  const a: any = new EVMChainAdapter(minimalConfig());
  a.initialized = true;
  a.init = async () => {};
  a.contracts = {
    knowledgeAssetStorage: opts.storageDeployed === false ? undefined : {
      connect(provider: (typeof providers)[number]) {
        return {
          async ownerOf(kaId: bigint, overrides: { blockTag?: unknown }) {
            calls.push({ provider: provider.__index, read: 'ownerOf', blockTag: overrides?.blockTag });
            if (!provider.__script.ownerAt) throw new Error('no ownerAt scripted');
            return provider.__script.ownerAt(kaId, overrides);
          },
        };
      },
    },
  };
  // The real failover walks endpoints on transport failure; this stand-in preserves exactly the
  // property under test — one whole callback per provider, first success wins.
  a.readProvider = async (_label: string, fn: (p: unknown) => Promise<unknown>) => {
    let lastError: unknown;
    for (const provider of providers) {
      try {
        return await fn(provider);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  };
  return { adapter: a, calls };
}

function nonexistentTokenRevert(): Error {
  return Object.assign(new Error('execution reverted'), {
    code: 'CALL_EXCEPTION',
    reason: 'ERC721NonexistentToken(uint256)',
  });
}

describe('EVMChainAdapter.readFinalizedChainProofSnapshot [GH#2270 r4]', () => {
  it('returns the pinned pair: both reads carry the finalized block NUMBER, not a floating tag', async () => {
    const { adapter, calls } = adapterOver([{
      finalized: { number: 90, hash: BLOCK_HASH },
      nonceAt: async () => 7,
      ownerAt: async () => { throw nonexistentTokenRevert(); },
    }]);

    const snapshot = await adapter.readFinalizedChainProofSnapshot({ address: ADDRESS, kaId: KA_ID });

    expect(snapshot).toEqual({ blockNumber: 90, blockHash: BLOCK_HASH, accountNonce: 7, kaMinted: false });
    // The pin. A mutant that re-evaluates 'finalized' (or reads latest) for either state read
    // reintroduces the splice this capability exists to close.
    expect(calls).toEqual([
      { provider: 0, read: 'nonce', blockTag: 90 },
      { provider: 0, read: 'ownerOf', blockTag: 90 },
    ]);
  });

  it('answers kaMinted TRUE for a real owner at the pinned block', async () => {
    const { adapter } = adapterOver([{
      finalized: { number: 90, hash: BLOCK_HASH },
      nonceAt: async () => 7,
      ownerAt: async () => ADDRESS,
    }]);
    const snapshot = await adapter.readFinalizedChainProofSnapshot({ address: ADDRESS, kaId: KA_ID });
    expect(snapshot?.kaMinted).toBe(true);
  });

  it('answers kaMinted NULL — never false — for an ambiguous revert, keeping the pinned nonce', async () => {
    const { adapter } = adapterOver([{
      finalized: { number: 90, hash: BLOCK_HASH },
      nonceAt: async () => 7,
      ownerAt: async () => {
        throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', reason: 'Paused' });
      },
    }]);
    const snapshot = await adapter.readFinalizedChainProofSnapshot({ address: ADDRESS, kaId: KA_ID });
    expect(snapshot).toEqual({ blockNumber: 90, blockHash: BLOCK_HASH, accountNonce: 7, kaMinted: null });
  });

  it('answers kaMinted NULL when the storage contract is not deployed', async () => {
    const { adapter } = adapterOver(
      [{ finalized: { number: 90, hash: BLOCK_HASH }, nonceAt: async () => 7 }],
      { storageDeployed: false },
    );
    const snapshot = await adapter.readFinalizedChainProofSnapshot({ address: ADDRESS, kaId: KA_ID });
    expect(snapshot).toEqual({ blockNumber: 90, blockHash: BLOCK_HASH, accountNonce: 7, kaMinted: null });
  });

  it('omits kaMinted entirely when no kaId was asked about', async () => {
    const { adapter, calls } = adapterOver([{
      finalized: { number: 90, hash: BLOCK_HASH },
      nonceAt: async () => 7,
    }]);
    const snapshot = await adapter.readFinalizedChainProofSnapshot({ address: ADDRESS });
    expect(snapshot).toEqual({ blockNumber: 90, blockHash: BLOCK_HASH, accountNonce: 7 });
    expect(snapshot && 'kaMinted' in snapshot).toBe(false);
    expect(calls.filter((c) => c.read === 'ownerOf')).toHaveLength(0);
  });

  it('returns NULL when no endpoint can serve a finalized block identity', async () => {
    const { adapter } = adapterOver([
      { finalized: new Error('finalized tag unsupported'), nonceAt: async () => 0 },
      { finalized: null, nonceAt: async () => 0 },
    ]);
    await expect(adapter.readFinalizedChainProofSnapshot({ address: ADDRESS, kaId: KA_ID }))
      .resolves.toBeNull();
  });

  it('a lagging fallback endpoint produces ITS OWN consistent pair — never a splice', async () => {
    // The scenario the reviewer's 🔴 names. Endpoint 0 is fresh but dies mid-snapshot; endpoint 1
    // lags: its finalized block (80) predates both the replacement transaction that consumed the
    // nonce and the mint it performed. The whole callback fails over, so the snapshot is entirely
    // endpoint 1's: an UNCONSUMED nonce next to the unminted identity — a pair that holds. What
    // must never exist is endpoint 0's consumed nonce next to endpoint 1's unminted identity.
    const { adapter, calls } = adapterOver([
      {
        finalized: { number: 95, hash: `0x${'01'.repeat(32)}` },
        // Fresh endpoint: the nonce read dies (transport), so ITS snapshot never completes.
        nonceAt: async () => { throw Object.assign(new Error('socket hang up'), { code: 'NETWORK_ERROR' }); },
        ownerAt: async () => { throw nonexistentTokenRevert(); },
      },
      {
        finalized: { number: 80, hash: BLOCK_HASH },
        nonceAt: async (_address, blockTag) => {
          if (blockTag !== 80) throw new Error(`lagging endpoint read at ${String(blockTag)}, not its own pin`);
          return 5; // the signed slot is 5 — NOT yet consumed at this endpoint's finalized view
        },
        ownerAt: async () => { throw nonexistentTokenRevert(); },
      },
    ]);

    const snapshot = await adapter.readFinalizedChainProofSnapshot({ address: ADDRESS, kaId: KA_ID });

    expect(snapshot).toEqual({ blockNumber: 80, blockHash: BLOCK_HASH, accountNonce: 5, kaMinted: false });
    // Every read that produced the RESULT came from provider 1 at ITS pin.
    const resultReads = calls.filter((c) => c.provider === 1);
    expect(resultReads).toEqual([
      { provider: 1, read: 'nonce', blockTag: 80 },
      { provider: 1, read: 'ownerOf', blockTag: 80 },
    ]);
  });
});

describe('MockChainAdapter.readFinalizedChainProofSnapshot — parity [GH#2270 r4]', () => {
  it('answers NULL until a finalized nonce is declared, then the pair from the same seams', async () => {
    const mock = new MockChainAdapter('mock:31337', ADDRESS);
    await expect(mock.readFinalizedChainProofSnapshot({ address: ADDRESS, kaId: KA_ID })).resolves.toBeNull();

    mock.__setFinalizedAccountNonce(ADDRESS, 9);
    mock.__setKnowledgeAssetMinted(KA_ID);
    const snapshot = await mock.readFinalizedChainProofSnapshot({ address: ADDRESS, kaId: KA_ID });
    expect(snapshot?.accountNonce).toBe(9);
    expect(snapshot?.kaMinted).toBe(true);
    expect(typeof snapshot?.blockNumber).toBe('number');
    expect(snapshot?.blockHash).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('mirrors the fail-closed minted classification: an undeclarable id answers NULL', async () => {
    const mock = new MockChainAdapter('mock:31337', ADDRESS);
    mock.__setFinalizedAccountNonce(ADDRESS, 9);
    mock.__setKnowledgeAssetMintedUnknown(KA_ID);
    const snapshot = await mock.readFinalizedChainProofSnapshot({ address: ADDRESS, kaId: KA_ID });
    expect(snapshot?.kaMinted).toBeNull();
    expect(snapshot?.kaMinted).not.toBe(false);
  });

  it('omits kaMinted when no kaId was asked about', async () => {
    const mock = new MockChainAdapter('mock:31337', ADDRESS);
    mock.__setFinalizedAccountNonce(ADDRESS, 9);
    const snapshot = await mock.readFinalizedChainProofSnapshot({ address: ADDRESS });
    expect(snapshot && 'kaMinted' in snapshot).toBe(false);
  });
});
