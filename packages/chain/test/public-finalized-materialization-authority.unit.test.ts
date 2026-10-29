import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { resolvePublicFinalizedMaterializationAuthority } from '../src/public-finalized-materialization-authority.js';
import {
  ContextGraphLiveAuthorityUnsupportedError,
  type ContextGraphLiveAuthorityReadOptions,
} from '../src/chain-adapter.js';

const ROOT = new Uint8Array(32).fill(7);
const AUTHOR = `0x${'11'.repeat(20)}`;
const PUBLISHER = `0x${'22'.repeat(20)}`;
const KAS_ADDRESS = `0x${'33'.repeat(20)}`;
const BLOCK_HASH = `0x${'44'.repeat(32)}`;

function authorityChain() {
  const chain = new MockChainAdapter();
  chain.isContextGraphActiveOnChain = vi.fn(async () => true);
  chain.getContextGraphAccessPolicy = vi.fn(async () => 0);
  chain.getMerkleRootCount = vi.fn(async () => 1n);
  chain.getLatestMerkleRoot = vi.fn(async () => ROOT);
  chain.getLatestMerkleRootAuthor = vi.fn(async () => AUTHOR);
  (chain as any).knowledgeAssetVersionSnapshotIsCurrent = vi.fn(async () => true);
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

  it('reuses one operation-scoped finalized snapshot while keeping live public gates', async () => {
    const chain = authorityChain();
    const active = vi.mocked(chain.isContextGraphActiveOnChain!);
    const access = vi.mocked(chain.getContextGraphAccessPolicy!);
    const rootCount = vi.mocked(chain.getMerkleRootCount!);
    const latestRoot = vi.mocked(chain.getLatestMerkleRoot!);
    const latestAuthor = vi.mocked(chain.getLatestMerkleRootAuthor!);

    await expect(resolvePublicFinalizedMaterializationAuthority({
      chain,
      onChainContextGraphId: '298',
      kaId: 42n,
      assertionVersion: '1',
      merkleRoot: ROOT,
      versionBlock: 321,
      versionSnapshot: {
        latestRoot: ROOT,
        rootCount: 1n,
        latestAuthor: AUTHOR,
        latestPublisher: PUBLISHER,
        blockNumber: 321,
        blockHash: BLOCK_HASH,
        knowledgeAssetStorageAddress: KAS_ADDRESS,
        knowledgeAssetStorageGeneration: 1,
      },
    })).resolves.toEqual({ kind: 'resolved', authorAddress: AUTHOR });

    expect(active).toHaveBeenCalledOnce();
    expect(access).toHaveBeenCalledOnce();
    expect(rootCount).not.toHaveBeenCalled();
    expect(latestRoot).not.toHaveBeenCalled();
    expect(latestAuthor).not.toHaveBeenCalled();
    expect((chain as any).knowledgeAssetVersionSnapshotIsCurrent).toHaveBeenCalledOnce();
  });

  it.each([
    ['assertion-version-mismatch', { rootCount: 2n }],
    ['latest-root-mismatch', { latestRoot: new Uint8Array(32).fill(8) }],
    ['invalid-input', { blockNumber: 322 }],
    ['invalid-input', { latestPublisher: ethers.ZeroAddress }],
  ] as const)(
    'fails closed with %s when operation snapshot evidence is mutated',
    async (reason, mutation) => {
      const chain = authorityChain();
      const versionSnapshot = Object.assign({
        latestRoot: ROOT,
        rootCount: 1n,
        latestAuthor: AUTHOR,
        latestPublisher: PUBLISHER,
        blockNumber: 321,
        blockHash: BLOCK_HASH,
        knowledgeAssetStorageAddress: KAS_ADDRESS,
        knowledgeAssetStorageGeneration: 1,
      }, mutation);
      await expect(resolvePublicFinalizedMaterializationAuthority({
        chain,
        onChainContextGraphId: '298',
        kaId: 42n,
        assertionVersion: '1',
        merkleRoot: ROOT,
        versionBlock: 321,
        versionSnapshot,
      })).resolves.toEqual({ kind: 'unavailable', reason });
    },
  );

  it('does not let a coherent version snapshot bypass the live liveness gate', async () => {
    const chain = authorityChain();
    chain.isContextGraphActiveOnChain = vi.fn(async () => false);

    await expect(resolvePublicFinalizedMaterializationAuthority({
      chain,
      onChainContextGraphId: '298',
      kaId: 42n,
      assertionVersion: '1',
      merkleRoot: ROOT,
      versionBlock: 321,
      versionSnapshot: {
        latestRoot: ROOT,
        rootCount: 1n,
        latestAuthor: AUTHOR,
        latestPublisher: PUBLISHER,
        blockNumber: 321,
        blockHash: BLOCK_HASH,
        knowledgeAssetStorageAddress: KAS_ADDRESS,
        knowledgeAssetStorageGeneration: 1,
      },
    })).resolves.toEqual({ kind: 'unavailable', reason: 'inactive-context-graph' });
  });

  it('falls back to the unchanged live reads when the snapshot lease is stale', async () => {
    const chain = authorityChain();
    (chain as any).knowledgeAssetVersionSnapshotIsCurrent = vi.fn(async () => false);

    await expect(resolvePublicFinalizedMaterializationAuthority({
      chain,
      onChainContextGraphId: '298',
      kaId: 42n,
      assertionVersion: '1',
      merkleRoot: ROOT,
      versionBlock: 321,
      versionSnapshot: {
        latestRoot: ROOT,
        rootCount: 1n,
        latestAuthor: AUTHOR,
        latestPublisher: PUBLISHER,
        blockNumber: 321,
        blockHash: BLOCK_HASH,
        knowledgeAssetStorageAddress: KAS_ADDRESS,
        knowledgeAssetStorageGeneration: 1,
      },
    })).resolves.toEqual({ kind: 'resolved', authorAddress: AUTHOR });

    expect(chain.getMerkleRootCount).toHaveBeenCalledTimes(2);
    expect(chain.getLatestMerkleRoot).toHaveBeenCalledOnce();
    expect(chain.getLatestMerkleRootAuthor).toHaveBeenCalledOnce();
  });

  it('treats a non-abort validator error as an optimization miss', async () => {
    const chain = authorityChain();
    (chain as any).knowledgeAssetVersionSnapshotIsCurrent = vi.fn(async () => {
      throw new Error('header temporarily unavailable');
    });
    await expect(resolvePublicFinalizedMaterializationAuthority({
      chain,
      onChainContextGraphId: '298',
      kaId: 42n,
      assertionVersion: '1',
      merkleRoot: ROOT,
      versionBlock: 321,
      versionSnapshot: {
        latestRoot: ROOT,
        rootCount: 1n,
        latestAuthor: AUTHOR,
        latestPublisher: PUBLISHER,
        blockNumber: 321,
        blockHash: BLOCK_HASH,
        knowledgeAssetStorageAddress: KAS_ADDRESS,
        knowledgeAssetStorageGeneration: 1,
      },
    })).resolves.toEqual({ kind: 'resolved', authorAddress: AUTHOR });
    expect(chain.getMerkleRootCount).toHaveBeenCalledTimes(2);
  });

  it('validates the lease only after awaited live CG gates and rejects a version advanced meanwhile', async () => {
    const chain = authorityChain();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    chain.isContextGraphActiveOnChain = vi.fn(async () => {
      await gate;
      return true;
    });
    chain.getContextGraphAccessPolicy = vi.fn(async () => {
      await gate;
      return 0;
    });
    const currentness = vi.fn(async () => false);
    (chain as any).knowledgeAssetVersionSnapshotIsCurrent = currentness;
    chain.getMerkleRootCount = vi.fn(async () => 2n);
    chain.getLatestMerkleRoot = vi.fn(async () => new Uint8Array(32).fill(8));

    const pending = resolvePublicFinalizedMaterializationAuthority({
      chain,
      onChainContextGraphId: '298',
      kaId: 42n,
      assertionVersion: '1',
      merkleRoot: ROOT,
      versionBlock: 321,
      versionSnapshot: {
        latestRoot: ROOT,
        rootCount: 1n,
        latestAuthor: AUTHOR,
        latestPublisher: PUBLISHER,
        blockNumber: 321,
        blockHash: BLOCK_HASH,
        knowledgeAssetStorageAddress: KAS_ADDRESS,
        knowledgeAssetStorageGeneration: 1,
      },
    });
    await Promise.resolve();
    expect(currentness).not.toHaveBeenCalled();
    release();

    await expect(pending).resolves.toEqual({
      kind: 'unavailable',
      reason: 'assertion-version-mismatch',
    });
    expect(currentness).toHaveBeenCalledOnce();
  });

  it('propagates lifecycle abort during lease validation instead of falling back', async () => {
    const chain = authorityChain();
    const controller = new AbortController();
    (chain as any).knowledgeAssetVersionSnapshotIsCurrent = vi.fn(async () => {
      controller.abort();
      throw controller.signal.reason;
    });

    await expect(resolvePublicFinalizedMaterializationAuthority({
      chain,
      onChainContextGraphId: '298',
      kaId: 42n,
      assertionVersion: '1',
      merkleRoot: ROOT,
      versionBlock: 321,
      versionSnapshot: {
        latestRoot: ROOT,
        rootCount: 1n,
        latestAuthor: AUTHOR,
        latestPublisher: PUBLISHER,
        blockNumber: 321,
        blockHash: BLOCK_HASH,
        knowledgeAssetStorageAddress: KAS_ADDRESS,
        knowledgeAssetStorageGeneration: 1,
      },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(chain.getMerkleRootCount).not.toHaveBeenCalled();
  });

  describe('one-read public gate', () => {
    /** `authorityChain()` plus the single tuple read the gate now prefers. */
    function oneReadChain(
      authority: { active: boolean; accessPolicy: number } | null = {
        active: true, accessPolicy: 0,
      },
    ) {
      const chain = authorityChain();
      (chain as any).getContextGraphLiveAuthority = vi.fn(async () => (
        authority === null ? null : { ...authority, participantAgents: [] }
      ));
      return chain;
    }

    /**
     * `authorityChain()` with the one-read genuinely ABSENT. `MockChainAdapter`
     * defines it on its prototype, composed from the very point reads stubbed
     * above, so the bare `authorityChain()` takes the one-read branch and only
     * looks like the point-read path. An own `undefined` shadows the prototype
     * method, which is how an adapter without the optional method reads here.
     */
    function noOneReadChain() {
      const chain = authorityChain();
      (chain as { getContextGraphLiveAuthority?: unknown }).getContextGraphLiveAuthority = undefined;
      expect(chain.getContextGraphLiveAuthority).toBeUndefined();
      return chain;
    }

    it('answers active and accessPolicy from one read, not two', async () => {
      const chain = oneReadChain();

      await expect(resolve(chain)).resolves.toEqual({
        kind: 'resolved', authorAddress: AUTHOR,
      });

      expect((chain as any).getContextGraphLiveAuthority).toHaveBeenCalledTimes(1);
      // The whole point: the pair that could straddle a block is not issued.
      expect(chain.isContextGraphActiveOnChain).not.toHaveBeenCalled();
      expect(chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
    });

    it('treats a proven-nonexistent id exactly as an inactive graph', async () => {
      // The adapter contract: `null` is terminal, never retried, and reaches
      // the same verdict the liveness probe would have.
      await expect(resolve(oneReadChain(null))).resolves.toEqual({
        kind: 'unavailable', reason: 'inactive-context-graph',
      });
    });

    it.each([
      ['inactive-context-graph', { active: false, accessPolicy: 0 }],
      ['non-public-context-graph', { active: true, accessPolicy: 1 }],
    ])('refuses with %s from the one read', async (reason, authority) => {
      await expect(resolve(oneReadChain(authority as any))).resolves.toEqual({
        kind: 'unavailable', reason,
      });
    });

    it('falls back to the two point reads on a deterministic failure', async () => {
      const chain = oneReadChain();
      (chain as any).getContextGraphLiveAuthority = vi.fn(async () => {
        throw new ContextGraphLiveAuthorityUnsupportedError('tuple did not decode');
      });

      await expect(resolve(chain)).resolves.toEqual({
        kind: 'resolved', authorAddress: AUTHOR,
      });

      expect(chain.isContextGraphActiveOnChain).toHaveBeenCalledTimes(1);
      expect(chain.getContextGraphAccessPolicy).toHaveBeenCalledTimes(1);
    });

    it('falls back on a same-named error from another module realm', async () => {
      // A rebuilt realm carries a structurally identical class that fails
      // `instanceof`, which is why the name is checked too.
      const chain = oneReadChain();
      (chain as any).getContextGraphLiveAuthority = vi.fn(async () => {
        const error = new Error('tuple did not decode');
        error.name = 'ContextGraphLiveAuthorityUnsupportedError';
        throw error;
      });

      await expect(resolve(chain)).resolves.toEqual({
        kind: 'resolved', authorAddress: AUTHOR,
      });
      expect(chain.isContextGraphActiveOnChain).toHaveBeenCalledTimes(1);
    });

    it('does NOT fall back on a transient failure', async () => {
      // Retrying provider trouble as two more requests turns a bad minute
      // into extra load. The transport owns its own retry.
      const chain = oneReadChain();
      (chain as any).getContextGraphLiveAuthority = vi.fn(async () => {
        throw new Error('endpoint timed out');
      });

      await expect(resolve(chain)).resolves.toMatchObject({
        kind: 'unavailable', reason: 'chain-read-failed',
      });
      expect(chain.isContextGraphActiveOnChain).not.toHaveBeenCalled();
      expect(chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
    });

    it('keeps the two point reads when the adapter has no one-read', async () => {
      const chain = noOneReadChain();

      await expect(resolve(chain)).resolves.toEqual({
        kind: 'resolved', authorAddress: AUTHOR,
      });
      expect(chain.isContextGraphActiveOnChain).toHaveBeenCalledTimes(1);
      expect(chain.getContextGraphAccessPolicy).toHaveBeenCalledTimes(1);
    });

    it('hands the caller signal to the one-read, so an aborted caller can leave it', async () => {
      // The one-read is shared in flight and a waiter's own signal is its only
      // way out. The stub stands in for that: it waits on the signal it was
      // given, and fails the read at once when it was given none.
      const controller = new AbortController();
      const chain = oneReadChain();
      const oneRead = vi.fn((_id: bigint, options?: ContextGraphLiveAuthorityReadOptions) => (
        new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          if (signal === undefined) {
            reject(new Error('one-read issued without the caller signal'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      ));
      (chain as { getContextGraphLiveAuthority?: unknown }).getContextGraphLiveAuthority = oneRead;

      let settled = false;
      const pending = resolvePublicFinalizedMaterializationAuthority({
        chain,
        onChainContextGraphId: '298',
        kaId: 42n,
        assertionVersion: '1',
        merkleRoot: ROOT,
        signal: controller.signal,
      }).finally(() => { settled = true; });

      expect(oneRead).toHaveBeenCalledOnce();
      expect(oneRead.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
      // Still waiting on the read: nothing but the caller's abort ends it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      // An abort is not a deterministic failure, so no fallback reads follow.
      expect(chain.isContextGraphActiveOnChain).not.toHaveBeenCalled();
      expect(chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
    });

    it('hands the caller signal to the fallback point reads as well', async () => {
      const controller = new AbortController();
      const chain = noOneReadChain();

      await expect(resolvePublicFinalizedMaterializationAuthority({
        chain,
        onChainContextGraphId: '298',
        kaId: 42n,
        assertionVersion: '1',
        merkleRoot: ROOT,
        signal: controller.signal,
      })).resolves.toEqual({ kind: 'resolved', authorAddress: AUTHOR });

      expect(chain.isContextGraphActiveOnChain)
        .toHaveBeenCalledWith(298n, { signal: controller.signal });
      expect(chain.getContextGraphAccessPolicy)
        .toHaveBeenCalledWith(298n, { signal: controller.signal });
    });
  });
});
