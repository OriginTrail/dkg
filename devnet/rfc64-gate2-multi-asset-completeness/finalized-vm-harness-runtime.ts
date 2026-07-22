import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  assertContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';

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
  readonly chainAdapter: FinalizedVmLoopbackMockChainAdapterV1;
  readonly rpcUrl: string;
  close(): Promise<void>;
}

const FINALIZED_BLOCK_HASH = `0x${'77'.repeat(32)}`;

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
  const fixture = Object.freeze({
    accessPolicy: 0,
    active: true,
    assertedAtChainId: RFC64_GATE2_DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address:
      RFC64_GATE2_DEPLOYMENT.assertedAtKav10Address as EvmAddressV1,
    assets: Object.freeze([Object.freeze({
      assertionRoot: config.assertionRoot,
      assertionVersion: config.assertionVersion,
      authorAddress: config.authorAddress,
      kaId: config.kaId,
      publisherAddress: '0x6666666666666666666666666666666666666666' as EvmAddressV1,
    })]),
    blockHash: FINALIZED_BLOCK_HASH as Digest32V1,
    blockNumberQuantity: '0x7b',
    contextGraphStorageAddress: RFC64_GATE2_CONTEXT_GRAPH_STORAGE_ADDRESS,
    nameHash: config.nameHash,
    networkId: RFC64_GATE2_DEPLOYMENT.networkId as NetworkIdV1,
    onChainContextGraphId: config.onChainContextGraphId,
    ownerAddress: config.authorAddress,
    publishPolicy: 1,
  } satisfies FinalizedVmLoopbackFixtureConfigV1);
  const rpcFixture = createFinalizedVmLoopbackRpcV1(fixture);
  const chainAdapter = new FinalizedVmLoopbackMockChainAdapterV1(fixture);
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
