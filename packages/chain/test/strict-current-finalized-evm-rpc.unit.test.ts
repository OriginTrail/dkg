import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type ChainIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
  CONTROL_EIP1271_CALL_FROM_V1,
  CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
  CONTROL_EIP1271_GAS_LIMIT_V1,
  CONTROL_EIP1271_MAX_ATTEMPTS_V1,
  CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
  CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
  CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1,
  CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
  type CurrentFinalizedEvmCallRequestV1,
} from '../src/control-object-signature-verifier.js';
import {
  createStrictCurrentFinalizedEvmChainAdapterV1,
  type StrictCurrentFinalizedEvmRpcConfigV1,
} from '../src/strict-current-finalized-evm-rpc.js';

const CHAIN_ID = '20430' as ChainIdV1;
const CHAIN_QUANTITY = '0x4fce';
const TO = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const BLOCK_HASH = `0x${'22'.repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${'23'.repeat(32)}`;
const OBJECT_DIGEST = `${'33'.repeat(32)}`;
const CANONICAL_CALL_DATA = `0x1626ba7e${OBJECT_DIGEST}${'0'.repeat(62)}40${'0'.repeat(63)}1aa${'0'.repeat(62)}`;
const MAGIC_RETURN = `0x1626ba7e${'00'.repeat(28)}`;
const WRONG_MAGIC_RETURN = `0xffffffff${'00'.repeat(28)}`;

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

interface LoopbackRpcServer {
  readonly url: string;
  readonly calls: JsonRpcRequest[];
  readonly stop: () => Promise<void>;
}

type LoopbackHandler = (
  call: JsonRpcRequest,
  response: ServerResponse,
  request: IncomingMessage,
) => void | Promise<void>;

const activeServers: LoopbackRpcServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.stop()));
});

describe('RFC-64 strict current-finalized raw JSON-RPC transport', () => {
  it('uses the configured endpoint once, in exact EIP-1898 request order and shape', async () => {
    const server = await startRpcServer(successfulHandler());
    const configuredEndpoints = [server.url];
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: configuredEndpoints,
    });
    configuredEndpoints[0] = 'http://peer-controlled.invalid';

    await expect(adapter(fixedRequest())).resolves.toEqual({
      chainId: CHAIN_ID,
      blockNumber: '123',
      blockHash: BLOCK_HASH,
      returnData: MAGIC_RETURN,
    });
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
    expect(server.calls.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    // The raw transport must emit valid JSON-RPC 2.0 request envelopes. The
    // loopback records the parsed request body verbatim, so this fails at
    // runtime if postJsonRpc drops or changes the version field.
    expect(server.calls.map(({ jsonrpc }) => jsonrpc)).toEqual(['2.0', '2.0', '2.0', '2.0']);
    expect(server.calls[0]!.params).toEqual([]);
    expect(server.calls[1]!.params).toEqual(['finalized', false]);
    const hashReference = { blockHash: BLOCK_HASH, requireCanonical: true };
    expect(server.calls[2]!.params).toEqual([TO, hashReference]);
    expect(server.calls[3]!.params).toEqual([{
      from: CONTROL_EIP1271_CALL_FROM_V1,
      to: TO,
      data: CANONICAL_CALL_DATA,
      gas: '0xf4240',
    }, hashReference]);
  });

  it('uses the explicit trusted number profile with a same-endpoint post-hash sandwich', async () => {
    const server = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({
      blockNumber: '123',
      blockHash: BLOCK_HASH,
    });
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(server.calls[2]!.params).toEqual([TO, '0x7b']);
    expect(server.calls[3]!.params[1]).toBe('0x7b');
    expect(server.calls[4]!.params).toEqual(['0x7b', false]);
  });

  it('fails over in canonical order after wrong-chain evidence without endpoint stickiness', async () => {
    const first = await startRpcServer((call, response) => {
      sendResult(response, call, '0x1');
    });
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, `${second.url}/`],
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ chainId: CHAIN_ID });
    await expect(adapter(fixedRequest())).resolves.toMatchObject({ chainId: CHAIN_ID });
    expect(first.calls.map(({ method }) => method)).toEqual(['eth_chainId', 'eth_chainId']);
    expect(second.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
  });

  it('deduplicates normalized endpoints and performs no hidden same-endpoint retry', async () => {
    const server = await startRpcServer((call, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: call.id,
        error: { code: -32000, message: 'temporarily unavailable' },
      }));
    });
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [server.url, `${server.url}/`],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'rpc-unavailable' });
    expect(server.calls).toHaveLength(1);
  });

  it('never follows a redirect to an endpoint outside trusted local configuration', async () => {
    const unconfigured = await startRpcServer(successfulHandler());
    const configured = await startRpcServer((_call, response) => {
      response.writeHead(307, { location: unconfigured.url });
      response.end();
    });
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [configured.url],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'rpc-unavailable' });
    expect(configured.calls).toHaveLength(1);
    expect(unconfigured.calls).toHaveLength(0);
  });

  it('advances after a fallback hash mismatch and never accepts mixed-anchor evidence', async () => {
    let finalizedReads = 0;
    const first = await startRpcServer(successfulHandler({
      blockHash: () => (++finalizedReads === 1 ? BLOCK_HASH : OTHER_BLOCK_HASH),
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ blockHash: BLOCK_HASH });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(second.calls).toHaveLength(5);
  });

  it('does not turn reorg-produced fallback no-code into deterministic invalidity', async () => {
    let finalizedReads = 0;
    const first = await startRpcServer(successfulHandler({
      blockHash: () => (++finalizedReads === 1 ? BLOCK_HASH : OTHER_BLOCK_HASH),
      code: '0x',
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ blockHash: BLOCK_HASH });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_getBlockByNumber',
    ]);
    expect(second.calls).toHaveLength(5);
  });

  it('does not turn reorg-produced fallback out-of-gas into a terminal resource limit', async () => {
    let finalizedReads = 0;
    const first = await startRpcServer(successfulHandler({
      blockHash: () => (++finalizedReads === 1 ? BLOCK_HASH : OTHER_BLOCK_HASH),
      outOfGas: true,
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ blockHash: BLOCK_HASH });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(second.calls).toHaveLength(5);
  });

  it('keeps fallback out-of-gas terminal after the same-anchor post-read succeeds', async () => {
    const first = await startRpcServer(successfulHandler({ outOfGas: true }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'resource-limit' });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(second.calls).toHaveLength(0);
  });

  it('propagates a transport resource-limit from the number profile without the post-read sandwich', async () => {
    const base = successfulHandler();
    const first = await startRpcServer((call, response, request) => {
      if (call.method !== 'eth_call') return base(call, response, request);
      // A transport/local body-cap resource-limit is NOT anchor-dependent, so it
      // must propagate immediately rather than be held for the hash sandwich the
      // way an execution (out-of-gas) resource-limit is.
      response.writeHead(200, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      });
      response.write(' '.repeat(40_000));
      response.end(' '.repeat(30_000));
    });
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'resource-limit' });
    // No fifth post-read eth_getBlockByNumber: the transport resource-limit was
    // not held, unlike the anchor-dependent execution resource-limit above.
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
    expect(second.calls).toHaveLength(0);
  });

  it('stops on terminal no-code evidence without contacting a later endpoint', async () => {
    const first = await startRpcServer(successfulHandler({ code: '0x' }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'no-code' });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
    ]);
    expect(second.calls).toHaveLength(0);
  });

  it('stops on a deterministic contract revert without contacting a later endpoint', async () => {
    const first = await startRpcServer(successfulHandler({ revert: true }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'revert' });
    expect(second.calls).toHaveLength(0);
  });

  it('treats explicit revert evidence as terminal when its message also mentions gas', async () => {
    const first = await startRpcServer(successfulHandler({
      callError: { code: 3, message: 'execution reverted: out of gas' },
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'revert' });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
    expect(second.calls).toHaveLength(0);
  });

  it('keeps mixed revert-and-gas evidence terminal after a stable fallback post-read', async () => {
    const first = await startRpcServer(successfulHandler({
      callError: { code: 3, message: 'execution reverted: gas required exceeds allowance' },
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'revert' });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(second.calls).toHaveLength(0);
  });

  it('rejects malformed contract returns but preserves exact wrong magic for the verifier', async () => {
    const malformed = await startRpcServer(successfulHandler({ returnData: '0x1626ba7e' }));
    const malformedAdapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [malformed.url],
    });
    await expect(malformedAdapter(fixedRequest()))
      .rejects.toMatchObject({ code: 'malformed-return' });

    const wrong = await startRpcServer(successfulHandler({ returnData: WRONG_MAGIC_RETURN }));
    const wrongAdapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [wrong.url],
    });
    await expect(wrongAdapter(fixedRequest())).resolves.toMatchObject({
      returnData: WRONG_MAGIC_RETURN,
    });
  });

  it('enforces the 65,536-byte cap while streaming, before JSON parsing or failover', async () => {
    const first = await startRpcServer((_call, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      });
      response.write(' '.repeat(40_000));
      response.end(' '.repeat(30_000));
    });
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'resource-limit' });
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
  });

  it('fails over past a large HTTP error body instead of a terminal resource limit', async () => {
    const first = await startRpcServer((_call, response) => {
      // A transient 5xx whose error page far exceeds the JSON-RPC body cap must
      // stay failover-eligible, not be reclassified as a terminal resource-limit.
      response.writeHead(503, {
        'content-type': 'text/html',
        'transfer-encoding': 'chunked',
      });
      response.write(' '.repeat(40_000));
      response.end(' '.repeat(30_000));
    });
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ blockHash: BLOCK_HASH });
    expect(first.calls).toHaveLength(1);
    expect(second.calls.length).toBeGreaterThan(0);
  });

  it('cancels the actual loopback HTTP operation and does not fail over', async () => {
    const received = deferred<void>();
    const connectionClosed = deferred<void>();
    const first = await startRpcServer((_call, response) => {
      response.on('close', () => connectionClosed.resolve());
      received.resolve();
      // Deliberately leave the response open until AbortSignal cancels fetch.
    });
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });
    const controller = new AbortController();
    const operation = adapter(fixedRequest({ signal: controller.signal }));

    await received.promise;
    controller.abort(new Error('caller stopped'));
    // The transport closes as rpc-unavailable; the verifier-owned caller
    // signal maps this path to the public `cancelled` disposition.
    await expect(operation).rejects.toMatchObject({ code: 'rpc-unavailable' });
    await connectionClosed.promise;
    expect(second.calls).toHaveLength(0);
  });

  it('enforces one four-second whole-attempt budget, cancels it, then advances', async () => {
    const firstClosed = deferred<void>();
    const delayedSuccess = successfulHandler();
    const first = await startRpcServer(async (call, response, request) => {
      if (call.method === 'eth_call') response.on('close', () => firstClosed.resolve());
      // Each RPC is individually under four seconds, but the chain/header/code
      // work consumes most of the one shared attempt budget. The call is then
      // cancelled by that original timer (a per-RPC timer would wrongly pass).
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      if (!response.destroyed) await delayedSuccess(call, response, request);
    });
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });
    const started = Date.now();

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ chainId: CHAIN_ID });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1 - 200);
    expect(elapsed).toBeLessThan(CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1);
    await firstClosed.promise;
    expect(first.calls).toHaveLength(4);
    expect(second.calls).toHaveLength(4);
  }, 12_000);

  it('rejects unsafe configuration and more than two distinct normalized endpoints', () => {
    const third = 'http://127.0.0.1:3';
    for (const config of [
      { chainId: '020430', endpoints: ['http://127.0.0.1:1'] },
      { chainId: CHAIN_ID, endpoints: [] },
      { chainId: CHAIN_ID, endpoints: ['ftp://127.0.0.1/a'] },
      { chainId: CHAIN_ID, endpoints: ['http://127.0.0.1/a#fragment'] },
      { chainId: CHAIN_ID, endpoints: [
        'http://127.0.0.1:1',
        'http://127.0.0.1:2',
        third,
      ] },
      { chainId: CHAIN_ID, endpoints: ['http://127.0.0.1:1'], peerEndpoint: third },
    ]) {
      expect(() => createStrictCurrentFinalizedEvmChainAdapterV1(
        config as StrictCurrentFinalizedEvmRpcConfigV1,
      )).toThrow(TypeError);
    }
  });
});

interface SuccessfulHandlerOptions {
  readonly blockHash?: string | (() => string);
  readonly callError?: { readonly code: number; readonly message: string };
  readonly code?: string;
  readonly outOfGas?: boolean;
  readonly returnData?: string;
  readonly revert?: boolean;
}

function successfulHandler(options: SuccessfulHandlerOptions = {}): LoopbackHandler {
  return (call, response) => {
    switch (call.method) {
      case 'eth_chainId':
        sendResult(response, call, CHAIN_QUANTITY);
        return;
      case 'eth_getBlockByNumber': {
        const selectedHash = typeof options.blockHash === 'function'
          ? options.blockHash()
          : (options.blockHash ?? BLOCK_HASH);
        sendResult(response, call, { number: '0x7b', hash: selectedHash });
        return;
      }
      case 'eth_getCode':
        sendResult(response, call, options.code ?? '0x6000');
        return;
      case 'eth_call':
        if (options.callError) {
          sendError(response, call, options.callError.code, options.callError.message);
        } else if (options.outOfGas) {
          sendError(response, call, -32000, 'out of gas');
        } else if (options.revert) {
          sendError(response, call, 3, 'execution reverted');
        } else {
          sendResult(response, call, options.returnData ?? MAGIC_RETURN);
        }
        return;
      default:
        sendError(response, call, -32601, 'method not found');
    }
  };
}

async function startRpcServer(handler: LoopbackHandler): Promise<LoopbackRpcServer> {
  const calls: JsonRpcRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      const parsed = JSON.parse(body) as JsonRpcRequest;
      calls.push(parsed);
      await handler(parsed, response, request);
    } catch (cause) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      if (!response.writableEnded) response.end(cause instanceof Error ? cause.message : 'failure');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  let stopped = false;
  const loopback = Object.freeze({
    url: `http://127.0.0.1:${address.port}`,
    calls,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await closeServer(server);
    },
  });
  activeServers.push(loopback);
  return loopback;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function sendResult(response: ServerResponse, request: JsonRpcRequest, result: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}

function sendError(
  response: ServerResponse,
  request: JsonRpcRequest,
  code: number,
  message: string,
): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message } }));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function fixedRequest(
  overrides: Partial<CurrentFinalizedEvmCallRequestV1> = {},
): CurrentFinalizedEvmCallRequestV1 {
  return {
    chainId: CHAIN_ID,
    to: TO,
    from: CONTROL_EIP1271_CALL_FROM_V1,
    data: CANONICAL_CALL_DATA,
    gasLimit: CONTROL_EIP1271_GAS_LIMIT_V1,
    maxReturnBytes: CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
    maxRpcResponseBytes: CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1,
    attemptTimeoutMs: CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
    maxAttempts: CONTROL_EIP1271_MAX_ATTEMPTS_V1,
    endpointAttemptPolicy: CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
    maxConcurrentCallsPerChain: CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
    totalDeadlineMs: CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
    ccipReadEnabled: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
