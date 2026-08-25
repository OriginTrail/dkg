import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { resolvePublicFinalizedMaterializationAuthority } from '../src/public-finalized-materialization-authority.js';

const ROOT = new Uint8Array(32).fill(7);
const AUTHOR = `0x${'11'.repeat(20)}`;

function authorityChain() {
  const chain = new MockChainAdapter();
  chain.isContextGraphActiveOnChain = vi.fn(async () => true);
  chain.getContextGraphAccessPolicy = vi.fn(async () => 0);
  chain.getMerkleRootCount = vi.fn(async () => 1n);
  chain.getLatestMerkleRoot = vi.fn(async () => ROOT);
  chain.getLatestMerkleRootAuthor = vi.fn(async () => AUTHOR);
  return chain;
}

function resolve(chain = authorityChain()) {
  return resolvePublicFinalizedMaterializationAuthority({
    chain,
    onChainContextGraphId: '298',
    kaId: 42n,
    assertionVersion: '1',
    merkleRoot: ROOT,
  });
}

describe('public finalized materialization authority', () => {
  it('returns one typed authority after a coherent public-chain snapshot', async () => {
    await expect(resolve()).resolves.toEqual({
      kind: 'resolved',
      authorAddress: AUTHOR,
    });
  });

  it.each([
    ['inactive-context-graph', false, 0, 1n, ROOT],
    ['non-public-context-graph', true, 1, 1n, ROOT],
    ['assertion-version-mismatch', true, 0, 2n, ROOT],
    ['latest-root-mismatch', true, 0, 1n, new Uint8Array(32).fill(8)],
  ] as const)(
    'fails closed with %s',
    async (reason, active, accessPolicy, rootCount, latestRoot) => {
      const chain = authorityChain();
      chain.isContextGraphActiveOnChain = vi.fn(async () => active);
      chain.getContextGraphAccessPolicy = vi.fn(async () => accessPolicy);
      chain.getMerkleRootCount = vi.fn(async () => rootCount);
      chain.getLatestMerkleRoot = vi.fn(async () => latestRoot);

      await expect(resolve(chain)).resolves.toEqual({ kind: 'unavailable', reason });
    },
  );

  it('fails closed when the root count changes across the authority read', async () => {
    const chain = authorityChain();
    chain.getMerkleRootCount = vi.fn()
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(2n);

    await expect(resolve(chain)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'root-count-drift',
    });
  });

  it('retains authority when optional author attribution is unavailable', async () => {
    const chain = authorityChain();
    chain.getLatestMerkleRootAuthor = vi.fn(async () => {
      throw new Error('author RPC unavailable');
    });

    await expect(resolve(chain)).resolves.toEqual({
      kind: 'resolved',
      authorUnavailableReason: 'author RPC unavailable',
    });
  });
});
