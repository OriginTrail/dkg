import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  parseFinalizedChainHarnessConfigV1,
  startFinalizedChainHarnessRuntimeV1,
  type FinalizedChainHarnessConfigV1,
} from '../../../devnet/rfc64-gate2-multi-asset-completeness/finalized-chain-harness-runtime.js';
import {
  FinalizedChainLoopbackMockChainAdapterV1,
  FINALIZED_CONTEXT_GRAPH_INTERFACE,
} from './support/rfc64-finalized-chain-loopback-fixture.js';
import { FinalizedVmLoopbackMockChainAdapterV1 } from './support/rfc64-finalized-vm-loopback-fixture.js';

const authority = {
  accessPolicy: 0,
  contextGraphId: 'finalized-harness',
  nameHash: `0x${'11'.repeat(32)}`,
  onChainContextGraphId: '14',
  ownerAddress: `0x${'22'.repeat(20)}`,
};
const cgStorage = `0x${'33'.repeat(20)}`;
const kaStorage = `0x${'55'.repeat(20)}`;
const kaInterface = new ethers.Interface([
  'function getKnowledgeAssetUpdateContext(uint256 id) view returns (uint256 merkleRootsCount, uint256 minted, uint88 byteSize, uint40 endEpoch, uint96 tokenAmount, bool isImmutable, uint32 merkleLeafCount)',
  'function getLatestMerkleRoot(uint256 id) view returns (bytes32)',
  'function getLatestMerkleRootAuthor(uint256 id) view returns (address)',
  'function getLatestMerkleRootPublisher(uint256 id) view returns (address)',
]);

async function read(rpcUrl: string, abi: ethers.Interface, target: string, method: string, args: readonly unknown[]) {
  const response = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [
      { to: target, data: abi.encodeFunctionData(method, args) }, 'finalized',
    ] }),
  });
  const body = await response.json() as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  if (typeof body.result !== 'string') throw new Error('missing RPC result');
  return abi.decodeFunctionResult(method, body.result);
}

// A VM runtime cannot be requested without its inventory at the typed boundary.
const parsedPolicy = parseFinalizedChainHarnessConfigV1(JSON.stringify(authority));
// @ts-expect-error VM configuration requires a VM inventory.
const invalidVm: FinalizedChainHarnessConfigV1 = { ...parsedPolicy, kind: 'vm' };
void invalidVm;

describe('finalized chain harness compositions', () => {
  it('serves policy authority and zero inventory without a VM adapter', async () => {
    const runtime = await startFinalizedChainHarnessRuntimeV1(parsedPolicy);
    try {
      expect(runtime.kind).toBe('policy');
      expect(runtime.chainAdapter.constructor).toBe(FinalizedChainLoopbackMockChainAdapterV1);
      expect(await read(runtime.rpcUrl, FINALIZED_CONTEXT_GRAPH_INTERFACE, cgStorage, 'getNameHash', [14n]))
        .toEqual([authority.nameHash]);
      expect(await read(runtime.rpcUrl, FINALIZED_CONTEXT_GRAPH_INTERFACE, cgStorage, 'getContextGraphKaCount', [14n]))
        .toEqual([0n]);
      await expect(read(runtime.rpcUrl, FINALIZED_CONTEXT_GRAPH_INTERFACE, cgStorage, 'getContextGraphKaAt', [14n, 0n]))
        .rejects.toThrow('empty finalized chain inventory');
      await expect(read(runtime.rpcUrl, kaInterface, kaStorage, 'getLatestMerkleRoot', [1n]))
        .rejects.toThrow('unexpected finalized chain eth_call selector');
    } finally { await runtime.close(); }
  });

  it('layers all multi-asset inventory responses over the same private authority', async () => {
    const assets = [1, 2].map(index => ({
      assertionRoot: `0x${String(index).repeat(64)}`, assertionVersion: String(index + 2),
      authorAddress: `0x${String(index + 6).repeat(40)}`, kaId: String(index),
    }));
    const config = parseFinalizedChainHarnessConfigV1(JSON.stringify({ ...authority, accessPolicy: 1, vmInventory: { assets } }));
    const runtime = await startFinalizedChainHarnessRuntimeV1(config);
    try {
      expect(config.kind).toBe('vm');
      expect(runtime.kind).toBe('vm');
      expect(runtime.chainAdapter).toBeInstanceOf(FinalizedVmLoopbackMockChainAdapterV1);
      expect(await runtime.chainAdapter.getDKGKnowledgeAssetsAddress()).toBe(kaStorage);
      const cg = await read(runtime.rpcUrl, FINALIZED_CONTEXT_GRAPH_INTERFACE, cgStorage, 'getContextGraph', [14n]);
      expect(cg.owner.toLowerCase()).toBe(authority.ownerAddress);
      expect(cg.accessPolicy).toBe(1n);
      expect(await read(runtime.rpcUrl, FINALIZED_CONTEXT_GRAPH_INTERFACE, cgStorage, 'getContextGraphKaCount', [14n]))
        .toEqual([2n]);
      for (const [ordinal, asset] of assets.entries()) {
        expect(await read(runtime.rpcUrl, FINALIZED_CONTEXT_GRAPH_INTERFACE, cgStorage, 'getContextGraphKaAt', [14n, ordinal]))
          .toEqual([BigInt(asset.kaId)]);
        const update = await read(runtime.rpcUrl, kaInterface, kaStorage, 'getKnowledgeAssetUpdateContext', [asset.kaId]);
        expect(update.merkleRootsCount).toBe(BigInt(asset.assertionVersion));
        expect(await read(runtime.rpcUrl, kaInterface, kaStorage, 'getLatestMerkleRoot', [asset.kaId]))
          .toEqual([asset.assertionRoot]);
        expect((await read(runtime.rpcUrl, kaInterface, kaStorage, 'getLatestMerkleRootAuthor', [asset.kaId]))[0].toLowerCase())
          .toBe(asset.authorAddress);
        expect(await read(runtime.rpcUrl, kaInterface, kaStorage, 'getLatestMerkleRootPublisher', [asset.kaId]))
          .toEqual([`0x${'66'.repeat(20)}`]);
      }
      await expect(read(runtime.rpcUrl, FINALIZED_CONTEXT_GRAPH_INTERFACE, cgStorage, 'getContextGraphKaAt', [14n, 2n]))
        .rejects.toThrow('unknown finalized VM ordinal');
      await expect(read(runtime.rpcUrl, kaInterface, cgStorage, 'getLatestMerkleRoot', [1n]))
        .rejects.toThrow('unexpected finalized chain knowledge asset storage target');
    } finally { await runtime.close(); }
  });

  it('rejects an explicitly requested empty VM inventory', () => {
    expect(() => parseFinalizedChainHarnessConfigV1(JSON.stringify({ ...authority, vmInventory: { assets: [] } })))
      .toThrow('assets must not be empty');
  });
});
