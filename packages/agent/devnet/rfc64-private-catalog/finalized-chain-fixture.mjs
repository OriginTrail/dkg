// SPDX-License-Identifier: Apache-2.0

import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import {
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
  #authorityStatePath;
  #fixture;
  #participantRemovalAlsoRemoves;
  #participantRemovalNoop;

  constructor(fixture, options = {}) {
    super(fixture.networkId, options.signerAddress ?? fixture.ownerAddress, {
      initialContextGraphId: BigInt(fixture.onChainContextGraphId),
    });
    this.#authorityStatePath = options.authorityStatePath;
    this.#fixture = fixture;
    this.#participantRemovalAlsoRemoves = options.participantRemovalAlsoRemoves;
    this.#participantRemovalNoop = options.participantRemovalNoop === true;
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

  async getContextGraphAuthoritySnapshot(contextGraphId, options = {}) {
    const snapshot = await super.getContextGraphAuthoritySnapshot(contextGraphId, options);
    const shared = this.#authorityStatePath === undefined
      ? null
      : await readRfc64PrivateAuthorityStateV1(this.#authorityStatePath);
    return Object.freeze({
      ...snapshot,
      ...(shared === null ? {} : shared),
      governanceContract: this.#fixture.contextGraphStorageAddress,
      owner: this.#fixture.ownerAddress,
      sourceBlockNumber: this.#fixture.authorityBlockNumber,
      sourceBlockHash: this.#fixture.authorityBlockHash,
    });
  }

  /** Every production membership reader observes the same finalized roster. */
  async getContextGraphParticipantAgents(contextGraphId) {
    const snapshot = await this.getContextGraphAuthoritySnapshot(contextGraphId);
    return [...snapshot.participantAgents];
  }

  async removeContextGraphParticipantAgent(contextGraphId, agent) {
    if (this.signerAddress.toLowerCase() !== this.#fixture.ownerAddress.toLowerCase()) {
      throw new Error('RFC-64 private authority mutation requires the owner signer');
    }
    if (this.#participantRemovalNoop) return this.txResult(true);
    const result = await super.removeContextGraphParticipantAgent(contextGraphId, agent);
    if (this.#participantRemovalAlsoRemoves !== undefined) {
      await super.removeContextGraphParticipantAgent(
        contextGraphId,
        this.#participantRemovalAlsoRemoves,
      );
    }
    if (this.#authorityStatePath !== undefined) {
      const snapshot = await super.getContextGraphAuthoritySnapshot(contextGraphId);
      await writeRfc64PrivateAuthorityStateV1(this.#authorityStatePath, {
        participantAgents: snapshot.participantAgents,
        rosterVersion: snapshot.rosterVersion,
      });
    }
    return result;
  }
}

/** Seed the one finalized-authority snapshot observed by every runtime child. */
export function initializeRfc64PrivateAuthorityStateV1(path, fixture) {
  return writeRfc64PrivateAuthorityStateV1(path, {
    participantAgents: fixture.participantAgents,
    rosterVersion: fixture.rosterVersion,
  });
}

async function readRfc64PrivateAuthorityStateV1(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || Object.keys(parsed).sort().join('\n') !== 'participantAgents\nrosterVersion'
    || !Array.isArray(parsed.participantAgents)
    || parsed.participantAgents.some((address) => !ethers.isAddress(address))
    || typeof parsed.rosterVersion !== 'string'
    || !/^(0|[1-9][0-9]*)$/u.test(parsed.rosterVersion)
  ) {
    throw new Error('RFC-64 private shared authority state is invalid');
  }
  return Object.freeze({
    participantAgents: Object.freeze(parsed.participantAgents
      .map((address) => address.toLowerCase())
      .sort()),
    rosterVersion: parsed.rosterVersion,
  });
}

async function writeRfc64PrivateAuthorityStateV1(path, state) {
  const snapshot = Object.freeze({
    participantAgents: Object.freeze([...state.participantAgents]
      .map((address) => address.toLowerCase())
      .sort()),
    rosterVersion: state.rosterVersion,
  });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

/**
 * Start a real loopback HTTP JSON-RPC server. The responses are deterministic,
 * but every finalized-policy and VM read still travels through ethers and the
 * production strict-current-finalized snapshot path.
 */
export async function startRfc64PrivateDevnetFinalizedRpc(fixture, options = {}) {
  const calls = new Map();
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw);
      const batch = Array.isArray(body) ? body : [body];
      const results = await Promise.all(batch.map(async (call) => {
        calls.set(call.method, (calls.get(call.method) ?? 0) + 1);
        try {
          return {
            jsonrpc: '2.0',
            id: call.id,
            result: await finalizedRpcResult(
              call.method,
              call.params ?? [],
              fixture,
              options.readAuthoritySnapshot,
            ),
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
      }));
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
    snapshot: () => Object.freeze(Object.fromEntries(
      [...calls.entries()].sort(([left], [right]) => left.localeCompare(right)),
    )),
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  });
}

async function finalizedRpcResult(method, params, fixture, readAuthoritySnapshot) {
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
      return finalizedVmEthCallResult(
        params,
        fixture,
        assets,
        readAuthoritySnapshot,
      );
    default:
      throw new Error(`unexpected finalized RPC method ${method}`);
  }
}

async function finalizedVmEthCallResult(
  params,
  fixture,
  assets,
  readAuthoritySnapshot,
) {
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
    case CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraph').selector: {
      assertContextGraphCall('getContextGraph', data, fixture.onChainContextGraphId);
      const authority = readAuthoritySnapshot === undefined
        ? fixture
        : await readAuthoritySnapshot();
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getContextGraph', [
        authority.owner ?? fixture.ownerAddress,
        authority.participantAgents,
        0n,
        authority.active,
        1n,
        authority.accessPolicy,
        authority.publishPolicy,
        authority.publishAuthority ?? ethers.ZeroAddress,
        BigInt(authority.publishAuthorityAccountId),
      ]);
    }
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
