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
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** chainId 31337 (matches the tests' `chainId: 'evm:31337'`). */
export const CHAIN_ID_HEX = '0x7a69';

export interface LoopbackRpc {
  url: string;
  server: Server;
  /** Per-JSON-RPC-method request counts, e.g. `hits('eth_chainId')`. */
  hits: (method: string) => number;
  /** Requests whose client connection closed before a response was sent. */
  aborted: (method: string) => number;
  totalHits: () => number;
  /** Force-close sockets then close the server (afterEach teardown). */
  close: () => Promise<void>;
}

export interface LoopbackOptions {
  /** JSON-RPC methods that respond HTTP 429 (rate-limited). */
  throttle?: Iterable<string>;
  /** Override canned JSON-RPC results per method. */
  results?: Record<string, unknown>;
  /** JSON-RPC methods that accept the request but never send a response. */
  hang?: Iterable<string>;
}

const DEFAULT_RESULTS: Record<string, unknown> = {
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
  const hang = new Set(options.hang ?? []);
  const results = { ...DEFAULT_RESULTS, ...(options.results ?? {}) };
  const counts = new Map<string, number>();
  const abortedCounts = new Map<string, number>();

  const server = createServer((req, res) => {
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
      const hungMethods = reqs.filter(r => hang.has(r.method)).map(r => r.method);
      if (hungMethods.length > 0) {
        res.on('close', () => {
          if (res.writableEnded) return;
          for (const method of hungMethods) {
            abortedCounts.set(method, (abortedCounts.get(method) ?? 0) + 1);
          }
        });
        return;
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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    hits: (method) => counts.get(method) ?? 0,
    aborted: (method) => abortedCounts.get(method) ?? 0,
    totalHits: () => [...counts.values()].reduce((a, b) => a + b, 0),
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
