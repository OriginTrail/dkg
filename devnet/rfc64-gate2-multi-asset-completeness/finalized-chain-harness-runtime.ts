import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  assertContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';

import {
  FinalizedChainLoopbackMockChainAdapterV1,
  createFinalizedChainLoopbackRpcV1,
  type FinalizedChainLoopbackFixtureConfigV1,
  type FinalizedChainLoopbackRpcV1,
} from '../../packages/agent/test/support/rfc64-finalized-chain-loopback-fixture.js';
import {
  FinalizedVmLoopbackMockChainAdapterV1,
  createFinalizedVmLoopbackRpcV1,
  type FinalizedVmLoopbackFixtureConfigV1,
} from '../../packages/agent/test/support/rfc64-finalized-vm-loopback-fixture.js';

export const RFC64_GATE2_DEPLOYMENT = Object.freeze({
  networkId: 'otp:20430',
  assertedAtChainId: '20430',
  assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
});

const RFC64_GATE2_CONTEXT_GRAPH_STORAGE_ADDRESS =
  '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const RFC64_GATE2_KNOWLEDGE_ASSET_STORAGE_ADDRESS =
  '0x5555555555555555555555555555555555555555' as EvmAddressV1;

export interface FinalizedChainHarnessVmAssetConfigV1 {
  readonly assertionRoot: Digest32V1;
  readonly assertionVersion: string;
  readonly authorAddress: EvmAddressV1;
  readonly kaId: string;
}

export interface FinalizedChainHarnessVmInventoryConfigV1 {
  readonly assets: readonly Readonly<FinalizedChainHarnessVmAssetConfigV1>[];
}

/** Finalized chain/CG policy baseline; VM inventory is an explicit extension. */
interface FinalizedChainAuthorityHarnessConfigV1 {
  readonly accessPolicy: 0 | 1;
  readonly contextGraphId: string;
  readonly nameHash: Digest32V1;
  readonly onChainContextGraphId: string;
  readonly ownerAddress: EvmAddressV1;
}

export type FinalizedChainHarnessConfigV1 =
  | Readonly<FinalizedChainAuthorityHarnessConfigV1 & { kind: 'policy' }>
  | Readonly<FinalizedChainAuthorityHarnessConfigV1 & {
      kind: 'vm'; vmInventory: Readonly<FinalizedChainHarnessVmInventoryConfigV1>;
    }>;

interface FinalizedChainHarnessServerV1<T extends FinalizedChainLoopbackMockChainAdapterV1> {
  readonly chainAdapter: T;
  readonly rpcUrl: string;
  close(): Promise<void>;
}

export type FinalizedChainHarnessRuntimeV1 =
  | Readonly<FinalizedChainHarnessServerV1<FinalizedChainLoopbackMockChainAdapterV1> & { kind: 'policy' }>
  | Readonly<FinalizedChainHarnessServerV1<FinalizedVmLoopbackMockChainAdapterV1> & { kind: 'vm' }>;

const FINALIZED_BLOCK_HASH = `0x${'77'.repeat(32)}`;

export function parseFinalizedChainHarnessConfigV1(
  input: string,
): Readonly<FinalizedChainHarnessConfigV1> {
  if (Buffer.byteLength(input) > 1_000_000) {
    throw new TypeError('finalized chain harness config exceeds 1 MiB');
  }
  const parsed = plainRecord(JSON.parse(input), 'finalized chain harness config');
  const contextGraphId = requiredString(parsed.contextGraphId, 'finalizedChain.contextGraphId');
  assertContextGraphIdV1(contextGraphId);
  const accessPolicy = parsed.accessPolicy === undefined
    ? 0
    : canonicalAccessPolicy(parsed.accessPolicy, 'finalizedChain.accessPolicy');
  const nameHash = requiredDigest(parsed.nameHash, 'finalizedChain.nameHash');
  const ownerAddress = canonicalEvmAddress(parsed.ownerAddress, 'finalizedChain.ownerAddress');
  const onChainContextGraphId = canonicalDecimalWire(
    parsed.onChainContextGraphId,
    'finalizedChain.onChainContextGraphId',
  );
  if (BigInt(onChainContextGraphId) === 0n) {
    throw new TypeError('finalized chain on-chain context graph id must be non-zero');
  }
  const authority = { accessPolicy, contextGraphId, nameHash, onChainContextGraphId, ownerAddress };
  // Normalize the legacy wire shape once; all runtime consumers use the mode.
  return parsed.vmInventory === undefined
    ? Object.freeze({ ...authority, kind: 'policy' })
    : Object.freeze({ ...authority, kind: 'vm', vmInventory: parseVmInventory(parsed.vmInventory) });
}

function parseVmInventory(value: unknown): Readonly<FinalizedChainHarnessVmInventoryConfigV1> {
  const inventory = plainRecord(value, 'finalizedChain.vmInventory');
  const assetsInput = plainArray(inventory.assets, 'finalizedChain.vmInventory.assets');
  if (assetsInput.length === 0) throw new TypeError('finalizedChain.vmInventory.assets must not be empty');
  const assets = assetsInput.map((value, index) => {
    const asset = plainRecord(value, `finalizedChain.vmInventory.assets[${index}]`);
    const assertionVersion = canonicalDecimalWire(
      asset.assertionVersion,
      `finalizedChain.vmInventory.assets[${index}].assertionVersion`,
    );
    if (BigInt(assertionVersion) === 0n) {
      throw new TypeError(`finalizedChain.vmInventory.assets[${index}].assertionVersion must be non-zero`);
    }
    return Object.freeze({
      assertionRoot: requiredDigest(
        asset.assertionRoot,
        `finalizedChain.vmInventory.assets[${index}].assertionRoot`,
      ),
      assertionVersion,
      authorAddress: canonicalEvmAddress(
        asset.authorAddress,
        `finalizedChain.vmInventory.assets[${index}].authorAddress`,
      ),
      kaId: canonicalDecimalWire(asset.kaId, `finalizedChain.vmInventory.assets[${index}].kaId`),
    });
  });
  return Object.freeze({ assets: Object.freeze(assets) });
}

export async function startFinalizedChainHarnessRuntimeV1(
  config: Readonly<FinalizedChainHarnessConfigV1>,
): Promise<Readonly<FinalizedChainHarnessRuntimeV1>> {
  switch (config.kind) {
    case 'policy': {
      const fixture = authorityLoopbackFixture(config);
      const runtime = await startFinalizedChainHarnessServerV1(config,
        createFinalizedChainLoopbackRpcV1(fixture),
        rpcUrl => new FinalizedChainLoopbackMockChainAdapterV1(fixture, rpcUrl));
      return Object.freeze({ ...runtime, kind: 'policy' });
    }
    case 'vm': {
      const fixture = vmLoopbackFixture(config);
      const runtime = await startFinalizedChainHarnessServerV1(config,
        createFinalizedVmLoopbackRpcV1(fixture),
        rpcUrl => new FinalizedVmLoopbackMockChainAdapterV1(fixture, rpcUrl));
      return Object.freeze({ ...runtime, kind: 'vm' });
    }
  }
}

function authorityLoopbackFixture(
  config: FinalizedChainAuthorityHarnessConfigV1,
): FinalizedChainLoopbackFixtureConfigV1 {
  return Object.freeze({
    accessPolicy: config.accessPolicy,
    active: true,
    assertedAtChainId: RFC64_GATE2_DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address:
      RFC64_GATE2_DEPLOYMENT.assertedAtKav10Address as EvmAddressV1,
    blockHash: FINALIZED_BLOCK_HASH as Digest32V1,
    blockNumberQuantity: '0x7b',
    contextGraphStorageAddress: RFC64_GATE2_CONTEXT_GRAPH_STORAGE_ADDRESS,
    nameHash: config.nameHash,
    networkId: RFC64_GATE2_DEPLOYMENT.networkId as NetworkIdV1,
    onChainContextGraphId: config.onChainContextGraphId,
    ownerAddress: config.ownerAddress,
    publishPolicy: 1,
  } satisfies FinalizedChainLoopbackFixtureConfigV1);
}

function vmLoopbackFixture(
  config: Extract<FinalizedChainHarnessConfigV1, { kind: 'vm' }>,
): FinalizedVmLoopbackFixtureConfigV1 {
  return Object.freeze({
    ...authorityLoopbackFixture(config),
    knowledgeAssetStorageAddress: RFC64_GATE2_KNOWLEDGE_ASSET_STORAGE_ADDRESS,
    assets: Object.freeze(config.vmInventory.assets.map(asset => Object.freeze({
      ...asset, publisherAddress: '0x6666666666666666666666666666666666666666' as EvmAddressV1,
    }))),
  });
}

/** Shared HTTP ownership and adapter initialization for either explicit composition. */
async function startFinalizedChainHarnessServerV1<T extends FinalizedChainLoopbackMockChainAdapterV1>(
  config: FinalizedChainAuthorityHarnessConfigV1,
  rpcFixture: FinalizedChainLoopbackRpcV1,
  createAdapter: (rpcUrl: string) => T,
): Promise<Readonly<FinalizedChainHarnessServerV1<T>>> {
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
        'finalized chain JSON-RPC call',
      );
      const method = requiredString(call.method, 'finalized chain JSON-RPC method');
      const params = plainArray(call.params, 'finalized chain JSON-RPC params');
      const result = rpcFixture.respond(method, params);
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
    throw new Error('finalized chain JSON-RPC server has no address');
  }
  const rpcUrl = `http://127.0.0.1:${address.port}`;
  let chainAdapter: T;
  try {
    chainAdapter = createAdapter(rpcUrl);
    const created = await chainAdapter.createOnChainContextGraph({
      accessPolicy: config.accessPolicy,
      publishPolicy: 1,
      nameHash: config.nameHash,
    });
    if (created.contextGraphId.toString() !== config.onChainContextGraphId) {
      throw new Error('mock chain created a different numeric context graph id');
    }
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  return Object.freeze({
    chainAdapter,
    rpcUrl,
    close: async () => {
      const current = activeServer;
      activeServer = undefined;
      if (current !== undefined) await closeServer(current);
    },
  });
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

function canonicalAccessPolicy(value: unknown, label: string): 0 | 1 {
  if (value === 0 || value === 1) return value;
  throw new TypeError(`${label} must be 0 or 1`);
}

function canonicalEvmAddress(value: unknown, label: string): EvmAddressV1 {
  const address = requiredString(value, label);
  if (!/^0x[0-9a-f]{40}$/u.test(address) || address === `0x${'0'.repeat(40)}`) {
    throw new TypeError(`${label} is not a canonical non-zero EVM address`);
  }
  return address as EvmAddressV1;
}
