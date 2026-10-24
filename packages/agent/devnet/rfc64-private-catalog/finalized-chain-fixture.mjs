// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http';

import {
  MOCK_DEFAULT_SIGNER,
  MockChainAdapter,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

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

const CONTEXT_GRAPH_SELECTORS = new Set([
  'getContextGraph',
  'getNameHash',
  'isContextGraphActive',
  'getContextGraphKaCount',
  'getContextGraphKaAt',
].map((method) => CONTEXT_GRAPH_INTERFACE.getFunction(method).selector));
const KNOWLEDGE_ASSET_SELECTORS = new Set([
  'getKnowledgeAssetUpdateContext',
  'getLatestMerkleRoot',
  'getLatestMerkleRootAuthor',
  'getLatestMerkleRootPublisher',
].map((method) => KNOWLEDGE_ASSET_INTERFACE.getFunction(method).selector));

/** Chain adapter whose identity matches the deterministic finalized-RPC fixture. */
export class Rfc64PrivateDevnetChainAdapter extends MockChainAdapter {
  #fixture;

  constructor(fixture) {
    super(fixture.networkId, MOCK_DEFAULT_SIGNER, {
      initialContextGraphId: BigInt(fixture.onChainContextGraphId),
    });
    this.#fixture = fixture;
  }

  async getEvmChainId() {
    return BigInt(this.#fixture.assertedAtChainId);
  }

  async getKnowledgeAssetsLifecycleAddress() {
    return this.#fixture.assertedAtKav10Address;
  }

  async getDKGKnowledgeAssetsAddress() {
    return this.#fixture.knowledgeAssetStorageAddress;
  }
}

/**
 * Start a real loopback HTTP JSON-RPC server. The responses are deterministic,
 * but every finalized-policy and VM read still travels through ethers and the
 * production strict-current-finalized snapshot path.
 */
export async function startRfc64PrivateDevnetFinalizedRpc(fixture) {
  const calls = new Map();
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw);
      const batch = Array.isArray(body) ? body : [body];
      const results = batch.map((call) => {
        calls.set(call.method, (calls.get(call.method) ?? 0) + 1);
        try {
          return {
            jsonrpc: '2.0',
            id: call.id,
            result: finalizedRpcResult(call.method, call.params ?? [], fixture),
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id: call.id,
            error: {
              code: -32602,
              message: error instanceof Error ? error.message : 'invalid fixture request',
            },
          };
        }
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(Array.isArray(body) ? results : results[0]));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'invalid JSON-RPC request' },
      }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('finalized RPC did not bind a TCP address');
  }
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}`,
    calls: (method) => calls.get(method) ?? 0,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  });
}

function finalizedRpcResult(method, params, fixture) {
  const assets = new Map(fixture.assets.map((asset) => [asset.kaId, asset]));
  switch (method) {
    case 'eth_chainId':
      return ethers.toQuantity(BigInt(fixture.assertedAtChainId));
    case 'eth_blockNumber':
      return fixture.blockNumberQuantity;
    case 'eth_getBlockByNumber':
      return { number: fixture.blockNumberQuantity, hash: fixture.blockHash };
    case 'eth_getCode':
      return '0x6000';
    case 'eth_call':
      return finalizedVmEthCallResult(params, fixture, assets);
    default:
      throw new Error(`unexpected finalized RPC method ${method}`);
  }
}

function finalizedVmEthCallResult(params, fixture, assets) {
  const call = plainRecord(params[0], 'eth_call object');
  const target = requiredString(call.to, 'eth_call target').toLowerCase();
  const data = requiredString(call.data, 'eth_call data');
  if (data === '0x') return '0x';
  const selector = data.slice(0, 10);
  if (CONTEXT_GRAPH_SELECTORS.has(selector)) {
    assertCallTarget(target, fixture.contextGraphStorageAddress, 'context graph');
  } else if (KNOWLEDGE_ASSET_SELECTORS.has(selector)) {
    assertCallTarget(target, fixture.knowledgeAssetStorageAddress, 'knowledge asset');
  }
  switch (selector) {
    case CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraph').selector:
      assertContextGraphCall('getContextGraph', data, fixture.onChainContextGraphId);
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getContextGraph', [
        fixture.ownerAddress,
        [],
        0n,
        fixture.active,
        1n,
        fixture.accessPolicy,
        fixture.publishPolicy,
        fixture.publishAuthority,
        BigInt(fixture.publishAuthorityAccountId),
      ]);
    case CONTEXT_GRAPH_INTERFACE.getFunction('getNameHash').selector:
      assertContextGraphCall('getNameHash', data, fixture.onChainContextGraphId);
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getNameHash', [fixture.nameHash]);
    case CONTEXT_GRAPH_INTERFACE.getFunction('isContextGraphActive').selector:
      assertContextGraphCall('isContextGraphActive', data, fixture.onChainContextGraphId);
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('isContextGraphActive', [fixture.active]);
    case CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraphKaCount').selector:
      assertContextGraphCall('getContextGraphKaCount', data, fixture.onChainContextGraphId);
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult(
        'getContextGraphKaCount',
        [BigInt(fixture.assets.length)],
      );
    case CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraphKaAt').selector: {
      const [contextGraphId, ordinal] = CONTEXT_GRAPH_INTERFACE.decodeFunctionData(
        'getContextGraphKaAt',
        data,
      );
      assertNumericId(contextGraphId, fixture.onChainContextGraphId, 'context graph');
      const asset = fixture.assets[Number(ordinal)];
      if (asset === undefined) throw new Error(`unknown finalized VM ordinal ${ordinal}`);
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getContextGraphKaAt', [BigInt(asset.kaId)]);
    }
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getKnowledgeAssetUpdateContext').selector: {
      const asset = readAssetCall('getKnowledgeAssetUpdateContext', data, assets);
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getKnowledgeAssetUpdateContext',
        [BigInt(asset.assertionVersion), 0n, 0n, 0n, 0n, false, 0],
      );
    }
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getLatestMerkleRoot').selector: {
      const asset = readAssetCall('getLatestMerkleRoot', data, assets);
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult('getLatestMerkleRoot', [asset.assertionRoot]);
    }
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getLatestMerkleRootAuthor').selector: {
      const asset = readAssetCall('getLatestMerkleRootAuthor', data, assets);
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getLatestMerkleRootAuthor',
        [asset.authorAddress],
      );
    }
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getLatestMerkleRootPublisher').selector: {
      const asset = readAssetCall('getLatestMerkleRootPublisher', data, assets);
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getLatestMerkleRootPublisher',
        [asset.publisherAddress],
      );
    }
    default:
      throw new Error(`unexpected finalized RPC selector ${selector}`);
  }
}

function assertCallTarget(actual, expected, label) {
  if (actual !== expected.toLowerCase()) {
    throw new Error(`unexpected ${label} target`);
  }
}

function assertContextGraphCall(method, data, expectedId) {
  const [contextGraphId] = CONTEXT_GRAPH_INTERFACE.decodeFunctionData(method, data);
  assertNumericId(contextGraphId, expectedId, 'context graph');
}

function readAssetCall(method, data, assets) {
  const [kaId] = KNOWLEDGE_ASSET_INTERFACE.decodeFunctionData(method, data);
  const asset = assets.get(String(kaId));
  if (asset === undefined) throw new Error(`unknown finalized VM KA ${kaId}`);
  return asset;
}

function assertNumericId(actual, expected, label) {
  if (String(actual) !== expected) {
    throw new Error(`unexpected ${label} id`);
  }
}

function plainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value;
}
