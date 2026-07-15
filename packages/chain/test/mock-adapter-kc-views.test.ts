/**
 * MockChainAdapter — KC view unit tests.
 *
 * Covers the read-only V10 KC views the Random Sampling prover (and now
 * the daemon `/api/kc/:id/author` endpoint) use to bind a challenged
 * kaId to canonical chain state before building a proof or reporting
 * provenance to clients:
 *  - getLatestMerkleRoot(kaId)
 *  - getMerkleLeafCount(kaId)
 *  - getLatestMerkleRootPublisher(kaId)
 *  - getLatestMerkleRootAuthor(kaId)
 *  - getKAContextGraphId(kaId)
 *
 * The mock backs all five with the same in-memory `collections` map so
 * tests that publish via createKnowledgeAssets OR pre-seed via
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
      kaId: 42n,
      contextGraphId: 7n,
      merkleRootHex: ROOT_HEX,
      chunks: [
        { chunkId: 0n, chunk: LEAF0 },
        { chunkId: 1n, chunk: LEAF1 },
      ],
    });

    expect(ethers.hexlify(await adapter.getLatestMerkleRoot(42n))).toBe(ROOT_HEX);
    expect(await adapter.getMerkleRootCount(42n)).toBe(1n);
    expect(await adapter.getMerkleLeafCount(42n)).toBe(2);
    expect(await adapter.getLatestMerkleRootPublisher(42n)).toBe(MOCK_DEFAULT_SIGNER);
    // `__registerKC` is a Random-Sampling test bridge that bypasses the
    // V10.1 publish path entirely — no attestation is signed, so the
    // mock mirrors the on-chain `address(0)` semantics.
    expect(await adapter.getLatestMerkleRootAuthor(42n)).toBe(ethers.ZeroAddress);
    expect(await adapter.getKAContextGraphId(42n)).toBe(7n);
  });

  it('honours explicit merkleLeafCount and publisherAddress overrides', async () => {
    const adapter = new MockChainAdapter();
    const customPublisher = '0x' + 'cd'.repeat(20);
    adapter.__registerKC({
      kaId: 99n,
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

describe('MockChainAdapter KC views — createKnowledgeAssets path', () => {
  it('publishes a V10 KC and exposes the full view tuple', async () => {
    const adapter = new MockChainAdapter();
    await adapter.ensureProfile();

    const merkleRoot = ethers.getBytes(ROOT_HEX);
    const dummySig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    const result = await adapter.createKnowledgeAssets({
      publishOperationId: 'op-1',
      contextGraphId: 5n,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1024n,
      epochs: 1,
      tokenAmount: 0n,
      isImmutable: false,
      merkleLeafCount: 4,
      publisherNodeIdentityId: 1n,
      author: {
        address: MOCK_DEFAULT_SIGNER,
        signature: dummySig,
        schemeVersion: 1,
      },
      ackSignatures: [{ identityId: 1n, ...dummySig }],
    });

    expect(ethers.hexlify(await adapter.getLatestMerkleRoot(result.batchId))).toBe(ROOT_HEX);
    expect(await adapter.getMerkleRootCount(result.batchId)).toBe(1n);
    expect(await adapter.getMerkleLeafCount(result.batchId)).toBe(4);
    expect(await adapter.getLatestMerkleRootPublisher(result.batchId)).toBe(MOCK_DEFAULT_SIGNER);
    // V10.1 publish path: mock persists the supplied author address, so
    // the view reads back the same identity the caller signed against.
    expect(await adapter.getLatestMerkleRootAuthor(result.batchId)).toBe(MOCK_DEFAULT_SIGNER);
    expect(await adapter.getKAContextGraphId(result.batchId)).toBe(5n);
  });
});

describe('MockChainAdapter — per-CG registration ordinal reads (Phase B cursor key)', () => {
  it('counts registered KAs per CG and walks them in registration order', async () => {
    const adapter = new MockChainAdapter();
    // Interleave two CGs so we exercise the per-CG filter + ordering.
    adapter.__registerKC({ kaId: 10n, contextGraphId: 1n, merkleRootHex: ROOT_HEX, chunks: [{ chunkId: 0n, chunk: LEAF0 }] });
    adapter.__registerKC({ kaId: 20n, contextGraphId: 2n, merkleRootHex: ROOT_HEX, chunks: [{ chunkId: 0n, chunk: LEAF0 }] });
    adapter.__registerKC({ kaId: 11n, contextGraphId: 1n, merkleRootHex: ROOT_HEX, chunks: [{ chunkId: 0n, chunk: LEAF0 }] });
    adapter.__registerKC({ kaId: 12n, contextGraphId: 1n, merkleRootHex: ROOT_HEX, chunks: [{ chunkId: 0n, chunk: LEAF0 }] });

    expect(await adapter.getContextGraphKCCount(1n)).toBe(3n);
    expect(await adapter.getContextGraphKCCount(2n)).toBe(1n);

    expect(await adapter.getContextGraphKCAt(1n, 0n)).toBe(10n);
    expect(await adapter.getContextGraphKCAt(1n, 1n)).toBe(11n);
    expect(await adapter.getContextGraphKCAt(1n, 2n)).toBe(12n);
    expect(await adapter.getContextGraphKCAt(2n, 0n)).toBe(20n);
  });

  it('returns 0n count for an unknown CG and reverts on out-of-range index', async () => {
    const adapter = new MockChainAdapter();
    expect(await adapter.getContextGraphKCCount(999n)).toBe(0n);
    await expect(adapter.getContextGraphKCAt(999n, 0n)).rejects.toThrow(/out of range/);
  });

  it('surfaces a KnowledgeAssetRegisteredToContextGraph event for the live-nudge path', async () => {
    const adapter = new MockChainAdapter();
    adapter.__registerKC({ kaId: 5n, contextGraphId: 8n, merkleRootHex: ROOT_HEX, chunks: [{ chunkId: 0n, chunk: LEAF0 }] });
    adapter.__emitKARegisteredToContextGraph(8n, 5n);

    const seen: Array<{ cg: string; kaId: string }> = [];
    for await (const evt of adapter.listenForEvents({
      eventTypes: ['KnowledgeAssetRegisteredToContextGraph'],
      fromBlock: 0,
    })) {
      seen.push({ cg: String(evt.data.contextGraphId), kaId: String(evt.data.kaId) });
    }
    expect(seen).toEqual([{ cg: '8', kaId: '5' }]);
  });
});

describe('MockChainAdapter KC views — error / default behaviour', () => {
  it('throws on unknown kaId for the four required-data views', async () => {
    const adapter = new MockChainAdapter();
    await expect(adapter.getLatestMerkleRoot(404n)).rejects.toThrow(/unknown kaId/);
    await expect(adapter.getMerkleRootCount(404n)).rejects.toThrow(/unknown kaId/);
    await expect(adapter.getMerkleLeafCount(404n)).rejects.toThrow(/unknown kaId/);
    await expect(adapter.getLatestMerkleRootPublisher(404n)).rejects.toThrow(/unknown kaId/);
    await expect(adapter.getLatestMerkleRootAuthor(404n)).rejects.toThrow(/unknown kaId/);
  });

  it('returns 0n cgId for unknown kaId, mirroring Solidity default-zero mapping', async () => {
    const adapter = new MockChainAdapter();
    expect(await adapter.getKAContextGraphId(404n)).toBe(0n);
  });
});
