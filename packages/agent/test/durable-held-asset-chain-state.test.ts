import { describe, expect, it, vi } from 'vitest';
import { createRpcTimeoutError, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { authenticateHeldGraphScopedAssetWithinDeadline } from '../src/durable-recovery-authentication.js';
import { createRecoveryAuthority } from '../src/durable-recovery-authority.js';
import { authenticateHeldGraphScopedDescriptor } from '../src/sync/requester/graph-scoped-materialization.js';
import type { GraphScopedDescriptor } from '../src/sync/durable-integrity.js';

const UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/7';
const KA_ID = (0xefn << 96n) | 7n;
const ROOT = new Uint8Array(32).fill(0x5a);
const COPY: GraphScopedDescriptor = { ual: UAL, contextGraphId: 'held-chain-cg', assertionVersion: '3',
  contentScopeVersion: '2', claimedRootHex: '5a'.repeat(32), assertionGraph: 'urn:assertion',
  publicTripleCount: 1, privateTripleCount: 0, metadataDigestHex: '00'.repeat(32) };

function chain(overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  return { chainId: 'hardhat:31337', getLatestMerkleRoot: async () => ROOT,
    getMerkleRootCount: async () => 3n, getKAContextGraphId: async () => 9n,
    ...overrides } as unknown as ChainAdapter;
}
const authenticate = (adapter: ChainAdapter, binding = '9', verify = async () => true) =>
  authenticateHeldGraphScopedDescriptor(adapter, COPY, binding, verify);

describe('authority-owned authentication of a held graph-scoped asset', () => {
  it('authenticates current chain evidence for the descriptor and required binding', async () => {
    const asked: bigint[] = [];
    const verifyBinding = vi.fn(async (id: string, onChainId: bigint) => id === COPY.contextGraphId && onChainId === 9n);
    expect(await authenticateHeldGraphScopedDescriptor(chain({
      getLatestMerkleRoot: async kaId => { asked.push(kaId); return ROOT; },
    }), COPY, '9', verifyBinding)).toEqual({ kind: 'match' });
    expect(asked).toEqual([KA_ID]);
    expect(verifyBinding).toHaveBeenCalledOnce();
  });

  it.each(['root', 'short-root', 'version', 'unbound', 'wrong-binding', 'wrong-local-binding'])(
    'refuses a held generation with %s evidence', async fault => {
      const adapter = chain({
        ...(fault === 'root' ? { getLatestMerkleRoot: async () => new Uint8Array(32) } : {}),
        ...(fault === 'short-root' ? { getLatestMerkleRoot: async () => new Uint8Array(1) } : {}),
        ...(fault === 'version' ? { getMerkleRootCount: async () => 4n } : {}),
        ...(fault === 'unbound' ? { getKAContextGraphId: async () => 0n } : {}),
      });
      expect(await authenticate(adapter, fault === 'wrong-binding' ? '10' : '9', async () => fault !== 'wrong-local-binding')).toMatchObject({ kind: 'mismatch' });
    });

  it('distinguishes unavailable chain evidence from an authenticated mismatch', async () => {
    await expect(authenticate(chain({ chainId: 'none' }))).rejects.toMatchObject({ code: 'VM_CHAIN_VERIFICATION_UNSUPPORTED' });
    await expect(authenticate(chain({ getKAContextGraphId: undefined }))).rejects.toMatchObject({ code: 'VM_CHAIN_VERIFICATION_UNSUPPORTED' });
    await expect(authenticate(chain({ chainId: 'hardhat:1' }))).rejects.toThrow('is not on local chain hardhat:1');
  });

  it('retries a transient read and fails at the deadline', async () => {
    let reads = 0;
    const flaky = chain({ getMerkleRootCount: async () => {
      reads += 1;
      if (reads === 1) throw createRpcTimeoutError('endpoint stalled');
      return 3n;
    } });
    await expect(authenticateHeldGraphScopedAssetWithinDeadline({
      chain: flaky, copy: COPY, requiredBinding: '9', verifyContextGraphBinding: async () => true, deadline: Date.now() + 30_000,
    })).resolves.toEqual({ kind: 'match' });
    expect(reads).toBe(2);
    await expect(authenticateHeldGraphScopedAssetWithinDeadline({
      chain: chain(), copy: COPY, requiredBinding: '9', verifyContextGraphBinding: async () => true, deadline: Date.now() - 1,
    })).rejects.toThrow('exceeded its context-graph deadline');
  });

  it('uses the recovery authority and its memoised binding proof', async () => {
    const verifyContextGraphBinding = vi.fn(async () => true);
    const authority = createRecoveryAuthority({ chain: chain(), verifyContextGraphBinding,
      resolveAuthority: async () => { throw new Error('not read'); }, warn: () => {} });
    for (let read = 0; read < 2; read += 1) {
      await expect(authority.authenticateHeld!(COPY, '9', Date.now() + 30_000)).resolves.toEqual({ kind: 'match' });
    }
    expect(verifyContextGraphBinding).toHaveBeenCalledOnce();
    expect(verifyContextGraphBinding.mock.calls[0]!.slice(0, 2)).toEqual([COPY.contextGraphId, '9']);
    await expect(authority.authenticateHeld!(COPY, '10', Date.now() + 30_000)).resolves.toMatchObject({ kind: 'mismatch' });
  });
});
