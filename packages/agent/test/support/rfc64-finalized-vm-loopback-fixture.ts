import {
  MockChainAdapter,
  MOCK_DEFAULT_SIGNER,
} from '@origintrail-official/dkg-chain';
import type {
  Digest32V1,
  EvmAddressV1,
  NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

export interface FinalizedVmLoopbackAssetV1 {
  readonly assertionRoot: Digest32V1;
  readonly assertionVersion: string;
  readonly authorAddress: EvmAddressV1;
  readonly kaId: string;
  readonly publisherAddress: EvmAddressV1;
}

export interface FinalizedVmLoopbackFixtureConfigV1 {
  readonly accessPolicy: 0 | 1;
  readonly active: boolean;
  readonly assertedAtChainId: string;
  readonly assertedAtKav10Address: EvmAddressV1;
  readonly assets: readonly FinalizedVmLoopbackAssetV1[];
  readonly blockHash: Digest32V1;
  readonly blockNumberQuantity: string;
  readonly contextGraphStorageAddress: EvmAddressV1;
  readonly nameHash: Digest32V1;
  readonly networkId: NetworkIdV1;
  readonly onChainContextGraphId: string;
  readonly ownerAddress: EvmAddressV1;
  readonly publishPolicy: 0 | 1;
}

export interface FinalizedVmLoopbackRpcCallV1 {
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface FinalizedVmLoopbackRpcV1 {
  readonly calls: readonly FinalizedVmLoopbackRpcCallV1[];
  respond(method: string, params: readonly unknown[]): unknown;
}

const CONTEXT_GRAPH_INTERFACE = new ethers.Interface([
  'function getContextGraph(uint256 contextGraphId) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
  'function isContextGraphActive(uint256 contextGraphId) view returns (bool)',
  'function getContextGraphKaCount(uint256 contextGraphId) view returns (uint256)',
  'function getContextGraphKaAt(uint256 contextGraphId, uint256 ordinal) view returns (uint256)',
]);
const KNOWLEDGE_ASSET_INTERFACE = new ethers.Interface([
  'function getKnowledgeAssetUpdateContext(uint256 id) view returns (uint256 merkleRootsCount, uint256 minted, uint88 byteSize, uint40 endEpoch, uint96 tokenAmount, bool isImmutable, uint32 merkleLeafCount)',
  'function getLatestMerkleRoot(uint256 id) view returns (bytes32)',
  'function getLatestMerkleRootAuthor(uint256 id) view returns (address)',
  'function getLatestMerkleRootPublisher(uint256 id) view returns (address)',
]);

/** Mock adapter whose chain identity matches the loopback finalized-RPC lane. */
export class FinalizedVmLoopbackMockChainAdapterV1 extends MockChainAdapter {
  readonly #fixture: FinalizedVmLoopbackFixtureConfigV1;

  constructor(fixture: FinalizedVmLoopbackFixtureConfigV1) {
    super(fixture.networkId, MOCK_DEFAULT_SIGNER, {
      initialContextGraphId: BigInt(fixture.onChainContextGraphId),
    });
    this.#fixture = fixture;
  }

  override async getEvmChainId(): Promise<bigint> {
    return BigInt(this.#fixture.assertedAtChainId);
  }

  override async getKnowledgeAssetsLifecycleAddress(): Promise<string> {
    return this.#fixture.assertedAtKav10Address;
  }

  override async getDKGKnowledgeAssetsAddress(): Promise<string> {
    return this.#fixture.assertedAtKav10Address;
  }
}

/**
 * Package-owned protocol-shaped finalized RPC test support shared by the
 * integration suite and separate-process devnet proof. Callers own I/O only.
 */
export function createFinalizedVmLoopbackRpcV1(
  fixture: FinalizedVmLoopbackFixtureConfigV1,
): FinalizedVmLoopbackRpcV1 {
  const calls: FinalizedVmLoopbackRpcCallV1[] = [];
  const assets = new Map(fixture.assets.map((asset) => [asset.kaId, asset]));
  const respond = (method: string, params: readonly unknown[]): unknown => {
    calls.push(Object.freeze({ method, params: Object.freeze([...params]) }));
    switch (method) {
      case 'eth_chainId':
        return ethers.toQuantity(BigInt(fixture.assertedAtChainId));
      case 'eth_getBlockByNumber':
        return { number: fixture.blockNumberQuantity, hash: fixture.blockHash };
      case 'eth_getCode':
        return '0x6000';
      case 'eth_call':
        return finalizedVmEthCallResult(params, fixture, assets);
      default:
        throw new Error(`unexpected finalized VM JSON-RPC method ${method}`);
    }
  };
  return Object.freeze({ calls, respond });
}

function finalizedVmEthCallResult(
  params: readonly unknown[],
  fixture: FinalizedVmLoopbackFixtureConfigV1,
  assets: ReadonlyMap<string, FinalizedVmLoopbackAssetV1>,
): string {
  const call = plainRecord(params[0], 'finalized VM eth_call object');
  const target = requiredString(call.to, 'finalized VM eth_call target').toLowerCase();
  const data = requiredString(call.data, 'finalized VM eth_call data');
  if (data === '0x') return '0x';
  const selector = data.slice(0, 10);
  if (CONTEXT_GRAPH_SELECTORS.has(selector)) {
    assertCallTarget(target, fixture.contextGraphStorageAddress, 'context graph');
  } else if (KNOWLEDGE_ASSET_SELECTORS.has(selector)) {
    assertCallTarget(target, fixture.assertedAtKav10Address, 'knowledge asset');
  }
  switch (selector) {
    case CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraph')!.selector:
      assertContextGraphCall('getContextGraph', data, fixture.onChainContextGraphId);
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getContextGraph', [
        fixture.ownerAddress,
        [],
        0n,
        fixture.active,
        1n,
        fixture.accessPolicy,
        fixture.publishPolicy,
        fixture.publishPolicy === 1 ? ethers.ZeroAddress : fixture.ownerAddress,
        0n,
      ]);
    case CONTEXT_GRAPH_INTERFACE.getFunction('getNameHash')!.selector:
      assertContextGraphCall('getNameHash', data, fixture.onChainContextGraphId);
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getNameHash', [fixture.nameHash]);
    case CONTEXT_GRAPH_INTERFACE.getFunction('isContextGraphActive')!.selector:
      assertContextGraphCall('isContextGraphActive', data, fixture.onChainContextGraphId);
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult(
        'isContextGraphActive',
        [fixture.active],
      );
    case CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraphKaCount')!.selector:
      assertContextGraphCall('getContextGraphKaCount', data, fixture.onChainContextGraphId);
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult(
        'getContextGraphKaCount',
        [BigInt(fixture.assets.length)],
      );
    case CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraphKaAt')!.selector: {
      const [contextGraphId, ordinal] = CONTEXT_GRAPH_INTERFACE.decodeFunctionData(
        'getContextGraphKaAt',
        data,
      );
      assertNumericId(contextGraphId, fixture.onChainContextGraphId, 'context graph');
      const asset = fixture.assets[Number(ordinal)];
      if (asset === undefined) throw new Error(`unknown finalized VM ordinal ${ordinal}`);
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult(
        'getContextGraphKaAt',
        [BigInt(asset.kaId)],
      );
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
    default:
      throw new Error(`unexpected finalized VM eth_call selector ${selector}`);
  }
}

const CONTEXT_GRAPH_SELECTORS = new Set([
  'getContextGraph',
  'getNameHash',
  'isContextGraphActive',
  'getContextGraphKaCount',
  'getContextGraphKaAt',
].map((method) => CONTEXT_GRAPH_INTERFACE.getFunction(method)!.selector));

const KNOWLEDGE_ASSET_SELECTORS = new Set([
  'getKnowledgeAssetUpdateContext',
  'getLatestMerkleRoot',
  'getLatestMerkleRootAuthor',
  'getLatestMerkleRootPublisher',
].map((method) => KNOWLEDGE_ASSET_INTERFACE.getFunction(method)!.selector));

function assertCallTarget(actual: string, expected: EvmAddressV1, label: string): void {
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `unexpected finalized VM ${label} target ${actual}; expected ${expected.toLowerCase()}`,
    );
  }
}

function assertContextGraphCall(
  method: string,
  data: string,
  expectedId: string,
): void {
  const [contextGraphId] = CONTEXT_GRAPH_INTERFACE.decodeFunctionData(method, data);
  assertNumericId(contextGraphId, expectedId, 'context graph');
}

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

function assertNumericId(actual: unknown, expected: string, label: string): void {
  if (String(actual) !== expected) {
    throw new Error(`unexpected finalized VM ${label} id ${String(actual)}`);
  }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}
