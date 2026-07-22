// SPDX-License-Identifier: Apache-2.0
/**
 * Shared loopback JSON-RPC harness for the immediate-RPC-failover tests
 * (T1 read failover, the real-provider WRITE failover gate, and the staged
 * T3/T6). NOT a test file (no `.test.` suffix) so vitest does not run it.
 *
 * Spins real `node:http` JSON-RPC servers so tests drive REAL
 * `ethers.JsonRpcProvider`s / `FetchRequest` / the adapter's failover loops —
 * the thing the existing ~170 bare-object provider mocks bypass entirely. No
 * Hardhat, no native deps; runs locally (`--ignore-scripts`) and in CI.
 *
 * Teardown discipline (REQUIRED by callers): under a perpetual 429 ethers keeps
 * retrying on keep-alive sockets AFTER the awaited call rejects. Always
 * `adapter.destroy()` then `rpc.close()` (which `closeAllConnections()` first)
 * in afterEach, or the hook hangs past vitest's timeout — the known flaky-CI
 * failure mode (see evm-adapter.unit.test.ts:1549).
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/** chainId 31337 (matches the tests' `chainId: 'evm:31337'`). */
export const CHAIN_ID_HEX = '0x7a69';

export interface LoopbackRpc {
  url: string;
  server: Server;
  /** Per-JSON-RPC-method request counts, e.g. `hits('eth_chainId')`. */
  hits: (method: string) => number;
  totalHits: () => number;
  /** Force-close sockets then close the server (afterEach teardown). */
  close: () => Promise<void>;
}

export interface LoopbackOptions {
  /** JSON-RPC methods that respond HTTP 429 (rate-limited). */
  throttle?: Iterable<string>;
  /** Override canned results per method (return a hex string). */
  results?: Record<string, string>;
}

export interface LoopbackJsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface LoopbackJsonRpcServer {
  readonly url: string;
  readonly calls: LoopbackJsonRpcRequest[];
  readonly stop: () => Promise<void>;
}

export type LoopbackJsonRpcHandler = (
  call: LoopbackJsonRpcRequest,
  response: ServerResponse,
  request: IncomingMessage,
) => void | Promise<void>;

export interface LoopbackJsonRpcTestHarness {
  readonly start: (handler: LoopbackJsonRpcHandler) => Promise<LoopbackJsonRpcServer>;
  readonly stopAll: () => Promise<void>;
}

const DEFAULT_RESULTS: Record<string, string> = {
  eth_chainId: CHAIN_ID_HEX,
  eth_blockNumber: '0x10',
  eth_getCode: '0x1234',
  eth_call: '0x' + '00'.repeat(32),
  eth_sendRawTransaction: '0x' + '11'.repeat(32),
  eth_getTransactionReceipt: '', // '' → null result (receipt not yet mined)
};

/**
 * Start a loopback JSON-RPC server. Methods in `throttle` answer HTTP 429;
 * everything else returns a canned OK result. `eth_chainId`/`eth_blockNumber`
 * are always answerable (unless throttled) so a healthy endpoint satisfies
 * ethers' network detection.
 */
export async function startLoopbackRpc(options: LoopbackOptions = {}): Promise<LoopbackRpc> {
  const throttle = new Set(options.throttle ?? []);
  const results = { ...DEFAULT_RESULTS, ...(options.results ?? {}) };
  const counts = new Map<string, number>();

  const loopback = await startLoopbackHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: unknown;
      try { body = JSON.parse(raw); } catch { body = {}; }
      const reqs = (Array.isArray(body) ? body : [body]) as Array<{ id: number; method: string }>;
      let throttled = false;
      const out: unknown[] = [];
      for (const r of reqs) {
        counts.set(r.method, (counts.get(r.method) ?? 0) + 1);
        if (throttle.has(r.method)) { throttled = true; continue; }
        const result = r.method in results ? results[r.method] : '0x';
        out.push({ jsonrpc: '2.0', id: r.id, result: result === '' ? null : result });
      }
      if (throttled) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: reqs[0]?.id ?? null,
          error: { code: -32005, message: 'rate limited' },
        }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(body) ? out : out[0]));
    });
  });

  return {
    url: loopback.url,
    server: loopback.server,
    hits: (method) => counts.get(method) ?? 0,
    totalHits: () => [...counts.values()].reduce((a, b) => a + b, 0),
    close: loopback.close,
  };
}

/** Handler-driven variant sharing the canonical loopback server lifecycle. */
export function createLoopbackJsonRpcTestHarness(): LoopbackJsonRpcTestHarness {
  const activeServers: LoopbackJsonRpcServer[] = [];

  const start = async (handler: LoopbackJsonRpcHandler): Promise<LoopbackJsonRpcServer> => {
    const calls: LoopbackJsonRpcRequest[] = [];
    const started = await startLoopbackHttpServer(async (request, response) => {
      try {
        const parsed = JSON.parse(await readRequestBody(request)) as LoopbackJsonRpcRequest;
        calls.push(parsed);
        await handler(parsed, response, request);
      } catch (cause) {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
        if (!response.writableEnded) {
          response.end(cause instanceof Error ? cause.message : 'failure');
        }
      }
    });
    let stopped = false;
    const loopback = Object.freeze({
      url: started.url,
      calls,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await started.close();
      },
    });
    activeServers.push(loopback);
    return loopback;
  };

  return Object.freeze({
    start,
    stopAll: async () => {
      await Promise.all(activeServers.splice(0).map((server) => server.stop()));
    },
  });
}

export function sendJsonRpcResult(
  response: ServerResponse,
  request: LoopbackJsonRpcRequest,
  result: unknown,
): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}

export function sendJsonRpcError(
  response: ServerResponse,
  request: LoopbackJsonRpcRequest,
  code: number,
  message: string,
  data?: string,
): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function startLoopbackHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<Readonly<{ url: string; server: Server; close: () => Promise<void> }>> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: () => closeServer(server),
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
