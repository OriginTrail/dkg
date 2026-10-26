import { describe, expect, it, vi } from 'vitest';
import { createRpcTimeoutError, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { readHeldGraphScopedAssetChainStateWithinDeadline } from '../src/durable-recovery-authentication.js';
import { createRecoveryAuthority } from '../src/durable-recovery-authority.js';
import { readGraphScopedAssetChainState } from '../src/sync/requester/graph-scoped-materialization.js';

const UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/7';
const KA_ID = (0xefn << 96n) | 7n;
const ROOT = new Uint8Array(32).fill(0x5a);
const COPY = { ual: UAL, contextGraphId: 'held-chain-cg' };

function chain(overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  return {
    chainId: 'hardhat:31337',
    getLatestMerkleRoot: async () => ROOT,
    getMerkleRootCount: async () => 3n,
    getKAContextGraphId: async () => 9n,
    ...overrides,
  } as unknown as ChainAdapter;
}

describe('the chain views of a held graph-scoped asset', () => {
  it('reads the latest root, the root count and the binding authentication checks', async () => {
    const asked: bigint[] = [];
    const verifyBinding = vi.fn(async (id: string, onChainId: bigint) => id === COPY.contextGraphId && onChainId === 9n);
    const state = await readGraphScopedAssetChainState(chain({
      getLatestMerkleRoot: async (kaId: bigint) => { asked.push(kaId); return ROOT; },
    }), COPY, verifyBinding);

    expect(state).toEqual({ merkleRootHex: '5a'.repeat(32), assertionVersion: 3n, bound: true, onChainContextGraphId: '9' });
    expect(asked).toEqual([KA_ID]);
  });

  it('is unbound when the chain binds the asset nowhere or to another graph', async () => {
    const verifyBinding = vi.fn(async () => false);
    expect((await readGraphScopedAssetChainState(chain({ getKAContextGraphId: async () => 0n }), COPY, verifyBinding)).bound)
      .toBe(false);
    expect(verifyBinding).not.toHaveBeenCalled();
    expect((await readGraphScopedAssetChainState(chain(), COPY, verifyBinding)).bound).toBe(false);
    expect(verifyBinding).toHaveBeenCalledOnce();
  });

  it('refuses a chain without those views, and an asset of another chain', async () => {
    const verifyBinding = async () => true;
    await expect(readGraphScopedAssetChainState(chain({ chainId: 'none' }), COPY, verifyBinding))
      .rejects.toMatchObject({ code: 'VM_CHAIN_VERIFICATION_UNSUPPORTED' });
    await expect(readGraphScopedAssetChainState(chain({ getKAContextGraphId: undefined }), COPY, verifyBinding))
      .rejects.toMatchObject({ code: 'VM_CHAIN_VERIFICATION_UNSUPPORTED' });
    await expect(readGraphScopedAssetChainState(chain({ chainId: 'hardhat:1' }), COPY, verifyBinding))
      .rejects.toThrow('is not on local chain hardhat:1');
  });

  it('retries a transient read, and fails at the deadline', async () => {
    let reads = 0;
    const flaky = chain({
      getMerkleRootCount: async () => {
        reads += 1;
        if (reads === 1) throw createRpcTimeoutError('endpoint stalled');
        return 3n;
      },
    });
    await expect(readHeldGraphScopedAssetChainStateWithinDeadline({
      chain: flaky, copy: COPY, verifyContextGraphBinding: async () => true, deadline: Date.now() + 30_000,
    })).resolves.toMatchObject({ assertionVersion: 3n, bound: true, onChainContextGraphId: '9' });
    expect(reads).toBe(2);

    await expect(readHeldGraphScopedAssetChainStateWithinDeadline({
      chain: chain(), copy: COPY, verifyContextGraphBinding: async () => true, deadline: Date.now() - 1,
    })).rejects.toThrow('exceeded its context-graph deadline');
  });

  it('is read by the recovery authority with its memoised binding proof', async () => {
    const verifyContextGraphBinding = vi.fn(async () => true);
    const authority = createRecoveryAuthority({
      chain: chain(),
      verifyContextGraphBinding,
      resolveAuthority: async () => { throw new Error('not read'); },
      warn: () => {},
    });

    for (let read = 0; read < 2; read += 1) {
      await expect(authority.readHeldAssetChainState!(COPY, Date.now() + 30_000))
        .resolves.toEqual({ merkleRootHex: '5a'.repeat(32), assertionVersion: 3n, bound: true, onChainContextGraphId: '9' });
    }
    expect(verifyContextGraphBinding).toHaveBeenCalledOnce();
    expect(verifyContextGraphBinding.mock.calls[0]!.slice(0, 2)).toEqual([COPY.contextGraphId, '9']);
  });
});
