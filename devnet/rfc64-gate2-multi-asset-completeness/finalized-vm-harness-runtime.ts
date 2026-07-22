import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  assertContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

export const RFC64_GATE2_DEPLOYMENT = Object.freeze({
  networkId: 'otp:20430',
  assertedAtChainId: '20430',
  assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
});

export interface FinalizedVmHarnessConfigV1 {
  readonly assertionRoot: Digest32V1;
  readonly assertionVersion: string;
  readonly authorAddress: EvmAddressV1;
  readonly contextGraphId: string;
  readonly kaId: string;
  readonly nameHash: Digest32V1;
  readonly onChainContextGraphId: string;
}

export interface FinalizedVmHarnessRuntimeV1 {
  readonly chainAdapter: MockChainAdapter;
  readonly rpcUrl: string;
  close(): Promise<void>;
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
const FINALIZED_BLOCK_HASH = `0x${'77'.repeat(32)}`;
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();

class FinalizedVmHarnessMockChainAdapter extends MockChainAdapter {
  constructor() {
    super(RFC64_GATE2_DEPLOYMENT.networkId);
  }

  override async getEvmChainId(): Promise<bigint> {
    return BigInt(RFC64_GATE2_DEPLOYMENT.assertedAtChainId);
  }

  override async getKnowledgeAssetsLifecycleAddress(): Promise<string> {
    return RFC64_GATE2_DEPLOYMENT.assertedAtKav10Address;
  }

  override async getDKGKnowledgeAssetsAddress(): Promise<string> {
    return RFC64_GATE2_DEPLOYMENT.assertedAtKav10Address;
  }
}

export function parseFinalizedVmHarnessConfigV1(
  input: string,
): Readonly<FinalizedVmHarnessConfigV1> {
  if (Buffer.byteLength(input) > 16_384) {
    throw new TypeError('finalized VM harness config exceeds 16 KiB');
  }
  const parsed = plainRecord(JSON.parse(input), 'finalized VM harness config');
  const contextGraphId = requiredString(parsed.contextGraphId, 'finalizedVm.contextGraphId');
  assertContextGraphIdV1(contextGraphId);
  const authorAddress = canonicalEvmAddress(parsed.authorAddress, 'finalizedVm.authorAddress');
  const assertionRoot = requiredDigest(parsed.assertionRoot, 'finalizedVm.assertionRoot');
  const assertionVersion = canonicalDecimalWire(
    parsed.assertionVersion,
    'finalizedVm.assertionVersion',
  );
  if (BigInt(assertionVersion) === 0n) {
    throw new TypeError('finalized VM assertion version must be non-zero');
  }
  const nameHash = requiredDigest(parsed.nameHash, 'finalizedVm.nameHash');
  const kaId = canonicalDecimalWire(parsed.kaId, 'finalizedVm.kaId');
  const onChainContextGraphId = canonicalDecimalWire(
    parsed.onChainContextGraphId,
    'finalizedVm.onChainContextGraphId',
  );
  if (BigInt(onChainContextGraphId) === 0n) {
    throw new TypeError('finalized VM on-chain context graph id must be non-zero');
  }
  return Object.freeze({
    assertionRoot,
    assertionVersion,
    authorAddress,
    contextGraphId,
    kaId,
    nameHash,
    onChainContextGraphId,
  });
}

export async function startFinalizedVmHarnessRuntimeV1(
  config: Readonly<FinalizedVmHarnessConfigV1>,
): Promise<Readonly<FinalizedVmHarnessRuntimeV1>> {
  const chainAdapter = new FinalizedVmHarnessMockChainAdapter();
  (chainAdapter as unknown as { nextContextGraphId: bigint }).nextContextGraphId =
    BigInt(config.onChainContextGraphId);
  const created = await chainAdapter.createOnChainContextGraph({
    accessPolicy: 0,
    publishPolicy: 1,
    nameHash: config.nameHash,
  });
  if (created.contextGraphId.toString() !== config.onChainContextGraphId) {
    throw new Error('mock chain created a different numeric context graph id');
  }

  let activeServer: Server | undefined;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405, { 'content-type': 'text/plain' });
        response.end('method not allowed');
        return;
      }
      const chunks: Buffer[] = [];
      let byteLength = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.byteLength;
        if (byteLength > 1_000_000) throw new Error('JSON-RPC request exceeds 1 MiB');
        chunks.push(bytes);
      }
      const call = plainRecord(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        'finalized VM JSON-RPC call',
      );
      const method = requiredString(call.method, 'finalized VM JSON-RPC method');
      const params = plainArray(call.params, 'finalized VM JSON-RPC params');
      let result: unknown;
      switch (method) {
        case 'eth_chainId':
          result = '0x4fce';
          break;
        case 'eth_getBlockByNumber':
          result = { number: '0x7b', hash: FINALIZED_BLOCK_HASH };
          break;
        case 'eth_getCode':
          result = '0x6000';
          break;
        case 'eth_call':
          result = finalizedVmEthCallResult(params, config);
          break;
        default:
          throw new Error(`unexpected finalized VM JSON-RPC method ${method}`);
      }
      sendRpcResponse(response, call.id, { result });
    } catch (error) {
      sendRpcResponse(response, null, {
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  activeServer = server;
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    await closeServer(server);
    throw new Error('finalized VM JSON-RPC server has no address');
  }
  return Object.freeze({
    chainAdapter,
    rpcUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      const current = activeServer;
      activeServer = undefined;
      if (current !== undefined) await closeServer(current);
    },
  });
}

function finalizedVmEthCallResult(
  params: readonly unknown[],
  config: Readonly<FinalizedVmHarnessConfigV1>,
): string {
  const call = plainRecord(params[0], 'finalized VM eth_call object');
  const data = requiredString(call.data, 'finalized VM eth_call data');
  if (data === '0x') return '0x';
  const selector = data.slice(0, 10);
  switch (selector) {
    case CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraph')!.selector:
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getContextGraph', [
        config.authorAddress,
        [],
        0n,
        true,
        1n,
        0,
        1,
        ZERO_ADDRESS,
        0n,
      ]);
    case CONTEXT_GRAPH_INTERFACE.getFunction('getNameHash')!.selector:
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getNameHash', [config.nameHash]);
    case CONTEXT_GRAPH_INTERFACE.getFunction('isContextGraphActive')!.selector:
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('isContextGraphActive', [true]);
    case CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraphKaCount')!.selector:
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getContextGraphKaCount', [1n]);
    case CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraphKaAt')!.selector:
      return CONTEXT_GRAPH_INTERFACE.encodeFunctionResult(
        'getContextGraphKaAt',
        [BigInt(config.kaId)],
      );
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getKnowledgeAssetUpdateContext')!.selector:
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getKnowledgeAssetUpdateContext',
        [BigInt(config.assertionVersion), 0n, 0n, 0n, 0n, false, 0],
      );
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getLatestMerkleRoot')!.selector:
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getLatestMerkleRoot',
        [config.assertionRoot],
      );
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getLatestMerkleRootAuthor')!.selector:
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getLatestMerkleRootAuthor',
        [config.authorAddress],
      );
    case KNOWLEDGE_ASSET_INTERFACE.getFunction('getLatestMerkleRootPublisher')!.selector:
      return KNOWLEDGE_ASSET_INTERFACE.encodeFunctionResult(
        'getLatestMerkleRootPublisher',
        ['0x6666666666666666666666666666666666666666'],
      );
    default:
      throw new Error(`unexpected finalized VM eth_call selector ${selector}`);
  }
}

function sendRpcResponse(
  response: ServerResponse,
  id: unknown,
  payload: Readonly<{ readonly result: unknown } | { readonly error: unknown }>,
): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
    server.closeIdleConnections();
  });
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function plainArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new TypeError(`${label} must be a bounded Array`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): Digest32V1 {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical digest`);
  }
  return value as Digest32V1;
}

function canonicalDecimalWire(value: unknown, label: string): string {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) return value;
  throw new TypeError(`${label} is not a canonical non-negative integer`);
}

function canonicalEvmAddress(value: unknown, label: string): EvmAddressV1 {
  const address = requiredString(value, label);
  if (!/^0x[0-9a-f]{40}$/u.test(address) || address === `0x${'0'.repeat(40)}`) {
    throw new TypeError(`${label} is not a canonical non-zero EVM address`);
  }
  return address as EvmAddressV1;
}
