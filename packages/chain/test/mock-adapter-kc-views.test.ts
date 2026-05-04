/**
 * MockChainAdapter — KC view unit tests.
 *
 * Covers the four read-only V10 KC views the Random Sampling prover
 * uses to bind a challenged kcId to canonical merkle material before
 * building a proof:
 *  - getLatestMerkleRoot(kcId)
 *  - getMerkleLeafCount(kcId)
 *  - getLatestMerkleRootPublisher(kcId)
 *  - getKCContextGraphId(kcId)
 *
 * The mock backs all four with the same in-memory `collections` map so
 * tests that publish via createKnowledgeAssetsV10 OR pre-seed via
 * __registerKC see coherent state.
 */
import { describe, it, expect } from 'vitest';
import { MockChainAdapter, MOCK_DEFAULT_SIGNER } from '../src/mock-adapter.js';
import { ethers } from 'ethers';

const LEAF0 = ('0x' + '01'.repeat(32)) as `0x${string}`;
const LEAF1 = ('0x' + '02'.repeat(32)) as `0x${string}`;
const ROOT_HEX = '0x' + 'ab'.repeat(32);

describe('MockChainAdapter KC views — __registerKC populated state', () => {
  it('returns root + leaf count + publisher + cgId for a registered KC', async () => {
    const adapter = new MockChainAdapter();
    adapter.__registerKC({
      kcId: 42n,
      contextGraphId: 7n,
      merkleRootHex: ROOT_HEX,
      chunks: [
        { chunkId: 0n, chunk: LEAF0 },
        { chunkId: 1n, chunk: LEAF1 },
      ],
    });

    expect(ethers.hexlify(await adapter.getLatestMerkleRoot(42n))).toBe(ROOT_HEX);
    expect(await adapter.getMerkleLeafCount(42n)).toBe(2);
    expect(await adapter.getLatestMerkleRootPublisher(42n)).toBe(MOCK_DEFAULT_SIGNER);
    expect(await adapter.getKCContextGraphId(42n)).toBe(7n);
  });

  it('honours explicit merkleLeafCount and publisherAddress overrides', async () => {
    const adapter = new MockChainAdapter();
    const customPublisher = '0x' + 'cd'.repeat(20);
    adapter.__registerKC({
      kcId: 99n,
      contextGraphId: 3n,
      merkleRootHex: ROOT_HEX,
      chunks: [{ chunkId: 0n, chunk: LEAF0 }],
      merkleLeafCount: 17,
      publisherAddress: customPublisher,
    });

    expect(await adapter.getMerkleLeafCount(99n)).toBe(17);
    expect(await adapter.getLatestMerkleRootPublisher(99n)).toBe(customPublisher);
  });
});

describe('MockChainAdapter KC views — createKnowledgeAssetsV10 path', () => {
  it('publishes a V10 KC and exposes the full view tuple', async () => {
    const adapter = new MockChainAdapter();
    await adapter.ensureProfile();

    const merkleRoot = ethers.getBytes(ROOT_HEX);
    const dummySig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    const result = await adapter.createKnowledgeAssetsV10({
      publishOperationId: 'op-1',
      contextGraphId: 5n,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1024n,
      epochs: 1,
      tokenAmount: 0n,
      isImmutable: false,
      merkleLeafCount: 4,
      paymaster: ethers.ZeroAddress,
      publisherNodeIdentityId: 1n,
      publisherSignature: dummySig,
      ackSignatures: [{ identityId: 1n, ...dummySig }],
    });

    expect(ethers.hexlify(await adapter.getLatestMerkleRoot(result.batchId))).toBe(ROOT_HEX);
    expect(await adapter.getMerkleLeafCount(result.batchId)).toBe(4);
    expect(await adapter.getLatestMerkleRootPublisher(result.batchId)).toBe(MOCK_DEFAULT_SIGNER);
    expect(await adapter.getKCContextGraphId(result.batchId)).toBe(5n);
  });
});

describe('MockChainAdapter KC views — error / default behaviour', () => {
  it('throws on unknown kcId for the three required-data views', async () => {
    const adapter = new MockChainAdapter();
    await expect(adapter.getLatestMerkleRoot(404n)).rejects.toThrow(/unknown kcId/);
    await expect(adapter.getMerkleLeafCount(404n)).rejects.toThrow(/unknown kcId/);
    await expect(adapter.getLatestMerkleRootPublisher(404n)).rejects.toThrow(/unknown kcId/);
  });

  it('returns 0n cgId for unknown kcId, mirroring Solidity default-zero mapping', async () => {
    const adapter = new MockChainAdapter();
    expect(await adapter.getKCContextGraphId(404n)).toBe(0n);
  });
});
