import { ethers } from 'ethers';
import type { Digest32V1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import {
  FinalizedChainLoopbackMockChainAdapterV1,
  FINALIZED_CONTEXT_GRAPH_INTERFACE,
  createFinalizedChainLoopbackRpcDriverV1,
  readFinalizedChainAuthorityCallV1,
  assertFinalizedChainCallTargetV1,
  assertFinalizedChainNumericIdV1,
  type FinalizedChainLoopbackFixtureConfigV1,
  type FinalizedChainLoopbackRpcV1,
  type FinalizedChainLoopbackContractCallV1,
} from './rfc64-finalized-chain-loopback-fixture.js';

export interface FinalizedVmLoopbackAssetV1 {
  readonly assertionRoot: Digest32V1;
  readonly assertionVersion: string;
  readonly authorAddress: EvmAddressV1;
  readonly kaId: string;
  readonly publisherAddress: EvmAddressV1;
}

/** VM inventory extension layered over finalized Context Graph authority. */
export interface FinalizedVmLoopbackFixtureConfigV1 extends FinalizedChainLoopbackFixtureConfigV1 {
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
  readonly assets: readonly FinalizedVmLoopbackAssetV1[];
}

const KNOWLEDGE_ASSET_INTERFACE = new ethers.Interface([
  'function getKnowledgeAssetUpdateContext(uint256 id) view returns (uint256 merkleRootsCount, uint256 minted, uint88 byteSize, uint40 endEpoch, uint96 tokenAmount, bool isImmutable, uint32 merkleLeafCount)',
  'function getLatestMerkleRoot(uint256 id) view returns (bytes32)',
  'function getLatestMerkleRootAuthor(uint256 id) view returns (address)',
  'function getLatestMerkleRootPublisher(uint256 id) view returns (address)',
]);

export class FinalizedVmLoopbackMockChainAdapterV1 extends FinalizedChainLoopbackMockChainAdapterV1 {
  constructor(private readonly vmFixture: FinalizedVmLoopbackFixtureConfigV1, rpcEndpoint: string) {
    super(vmFixture, rpcEndpoint);
  }

  override async getDKGKnowledgeAssetsAddress(): Promise<string> {
    return this.vmFixture.knowledgeAssetStorageAddress;
  }
}

/** Extend chain authority with a required, exact VM inventory. */
export function createFinalizedVmLoopbackRpcV1(
  fixture: FinalizedVmLoopbackFixtureConfigV1,
): FinalizedChainLoopbackRpcV1 {
  const assets = new Map(fixture.assets.map(asset => [asset.kaId, asset]));
  return createFinalizedChainLoopbackRpcDriverV1(fixture, call =>
    readFinalizedVmInventoryCallV1(fixture, assets, call));
}

function readFinalizedVmInventoryCallV1(
  fixture: FinalizedVmLoopbackFixtureConfigV1,
  assets: ReadonlyMap<string, FinalizedVmLoopbackAssetV1>,
  call: FinalizedChainLoopbackContractCallV1,
): string {
  const { target, data } = call;
  const selector = data.slice(0, 10);
  if (VM_CONTEXT_GRAPH_SELECTORS.has(selector)) {
    assertFinalizedChainCallTargetV1(target, fixture.contextGraphStorageAddress, 'context graph');
  } else if (KNOWLEDGE_ASSET_SELECTORS.has(selector)) {
    assertFinalizedChainCallTargetV1(target, fixture.knowledgeAssetStorageAddress, 'knowledge asset storage');
  }
  switch (selector) {
    case FINALIZED_CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraphKaCount')!.selector: {
      const [id] = FINALIZED_CONTEXT_GRAPH_INTERFACE.decodeFunctionData('getContextGraphKaCount', data);
      assertFinalizedChainNumericIdV1(id, fixture.onChainContextGraphId, 'context graph');
      return FINALIZED_CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getContextGraphKaCount', [BigInt(fixture.assets.length)]);
    }
    case FINALIZED_CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraphKaAt')!.selector: {
      const [id, ordinal] = FINALIZED_CONTEXT_GRAPH_INTERFACE.decodeFunctionData('getContextGraphKaAt', data);
      assertFinalizedChainNumericIdV1(id, fixture.onChainContextGraphId, 'context graph');
      const asset = fixture.assets[Number(ordinal)];
      if (asset === undefined) throw new Error(`unknown finalized VM ordinal ${ordinal}`);
      return FINALIZED_CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getContextGraphKaAt', [BigInt(asset.kaId)]);
    }
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getKnowledgeAssetUpdateContext')!.selector: {
      const asset = readAssetCall('getKnowledgeAssetUpdateContext', data, assets);
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getKnowledgeAssetUpdateContext',
        [BigInt(asset.assertionVersion), 0n, 0n, 0n, 0n, false, 0],
      );
    }
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getLatestMerkleRoot')!.selector: {
      const asset = readAssetCall('getLatestMerkleRoot', data, assets);
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getLatestMerkleRoot',
        [asset.assertionRoot],
      );
    }
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getLatestMerkleRootAuthor')!.selector: {
      const asset = readAssetCall('getLatestMerkleRootAuthor', data, assets);
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getLatestMerkleRootAuthor',
        [asset.authorAddress],
      );
    }
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getLatestMerkleRootPublisher')!.selector: {
      const asset = readAssetCall('getLatestMerkleRootPublisher', data, assets);
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getLatestMerkleRootPublisher',
        [asset.publisherAddress],
      );
    }
    default: return readFinalizedChainAuthorityCallV1(fixture, call);
  }
}

const VM_CONTEXT_GRAPH_SELECTORS = new Set(['getContextGraphKaCount', 'getContextGraphKaAt']
  .map(method => FINALIZED_CONTEXT_GRAPH_INTERFACE.getFunction(method)!.selector));
const KNOWLEDGE_ASSET_SELECTORS = new Set([
  'getKnowledgeAssetUpdateContext', 'getLatestMerkleRoot',
  'getLatestMerkleRootAuthor', 'getLatestMerkleRootPublisher',
].map(method => KNOWLEDGE_ASSET_INTERFACE.getFunction(method)!.selector));

function readAssetCall(
  method: string,
  data: string,
  assets: ReadonlyMap<string, FinalizedVmLoopbackAssetV1>,
): FinalizedVmLoopbackAssetV1 {
  const [kaId] = KNOWLEDGE_ASSET_INTERFACE.decodeFunctionData(method, data);
  const asset = assets.get(String(kaId));
  if (asset === undefined) throw new Error(`unknown finalized VM KA ${kaId}`);
  return asset;
}
