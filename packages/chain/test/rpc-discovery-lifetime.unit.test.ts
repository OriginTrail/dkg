// SPDX-License-Identifier: Apache-2.0

/** Shared network discovery owns physical lifetime; each caller owns its wait. */
import { afterEach, describe, expect, it } from 'vitest';
import { Network, type JsonRpcProvider } from 'ethers';
import { readFirstProviderWithTransientRetry } from '../src/rpc-provider-fallback.js';
import { isContractViewRetryable } from '../src/rpc-failover-client.js';
import { readRpcTuple } from '../src/rpc-read-lifecycle.js';
import { RpcRequestGovernor } from '../src/rpc-request-governor.js';
import { AbortableKeyedSingleFlight } from '../src/keyed-ttl-single-flight-cache.js';
import {
  activeRpcRequestContext,
  createRpcRequestProvider,
  withDetachedRpcRequestContext,
  withOwnedRpcRequestContext,
  withRpcRequestContext,
  withRpcRequestTimeout,
  type RpcRequestContext,
  type RpcRequestProviderConfig,
} from '../src/rpc-request-transport.js';
import {
  CHAIN_ID_HEX,
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcResult,
  startLoopbackRpc,
  type LoopbackRpc,
} from './loopback-rpc-harness.js';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const outcome = <T>(pending: Promise<T>) => pending.then((value) => value, (error: unknown) => error);
const STALL_MS = 100;

function governor(rate = 100): RpcRequestGovernor {
  return new RpcRequestGovernor({
    maxRequestsPerSecond: rate, foregroundReservePercent: 0,
    burstRequests: 1, maxQueueSize: 8, startupJitterMs: 0,
  });
}

describe('native shared discovery lifetime', () => {
  const harness = createLoopbackJsonRpcTestHarness();
  const providers: JsonRpcProvider[] = [];
  const servers: LoopbackRpc[] = [];

  function provider(url: string, config: RpcRequestProviderConfig = {}): JsonRpcProvider {
    const created = createRpcRequestProvider(url, {
      maxRetries: 0, discoveryStallTimeoutMs: STALL_MS,
      providerOptions: { staticNetwork: false }, ...config,
    });
    providers.push(created);
    return created;
  }

  afterEach(async () => {
    for (const current of providers.splice(0)) current.destroy();
    await harness.stopAll();
    for (const rpc of servers.splice(0)) await rpc.close();
  });

  it('a cold hung discovery rejects its shared peers and physically closes the request', async () => {
    const rpc = await startLoopbackRpc({ hang: ['eth_chainId'] });
    servers.push(rpc);
    const current = provider(rpc.url);
    const startedAt = performance.now();
    const first = outcome(withRpcRequestTimeout(2_000, 'discovery test watchdog', () => current.getNetwork()));
    const peer = outcome(current.getNetwork());

    await expect(first).resolves.toMatchObject({ code: 'RPC_TIMEOUT', message: expect.stringContaining('RPC response') });
    await expect(peer).resolves.toMatchObject({ code: 'RPC_TIMEOUT' });
    await expect.poll(() => rpc.aborted('eth_chainId')).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(rpc.hits('eth_chainId')).toBe(1);
  });

  it('the discovery physical cap covers an incomplete response body after successful headers', async () => {
    let socketClosed = 0;
    const rpc = await harness.start((request, response) => {
      response.on('close', () => { if (!response.writableEnded) socketClosed++; });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(JSON.stringify({ jsonrpc: '2.0', id: request.id }).slice(0, -1) + ',"result":"');
    });
    const current = provider(rpc.url);
    const pending = outcome(withRpcRequestTimeout(2_000, 'body test watchdog', () => current.getNetwork()));

    await expect(pending).resolves.toMatchObject({ code: 'RPC_TIMEOUT', message: expect.stringContaining('RPC response') });
    await expect.poll(() => socketClosed).toBe(1);
    expect(rpc.calls.map(({ method }) => method)).toEqual(['eth_chainId']);
  });

  it('destroy cancels an in-flight discovery body before its physical stall deadline', async () => {
    let socketClosed = 0;
    let discoveryContext: RpcRequestContext | undefined;
    const rpc = await harness.start((request, response) => {
      response.on('close', () => { if (!response.writableEnded) socketClosed++; });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(JSON.stringify({ jsonrpc: '2.0', id: request.id }).slice(0, -1) + ',"result":"');
    });
    const current = provider(rpc.url, {
      discoveryStallTimeoutMs: 2_000,
      onRequest() { discoveryContext = activeRpcRequestContext(); },
    });
    const pending = outcome(current.getNetwork());
    const peer = outcome(current.getNetwork());
    const destroyedAtAbort: boolean[] = [];
    await expect.poll(() => rpc.calls.length).toBe(1);
    discoveryContext!.signal!.addEventListener('abort', () => { destroyedAtAbort.push(current.destroyed); }, { once: true });
    current.destroy();
    await expect(pending).resolves.toMatchObject({ name: 'AbortError' });
    await expect(peer).resolves.toMatchObject({ name: 'AbortError' });
    await expect.poll(() => socketClosed).toBe(1);
    expect(destroyedAtAbort).toEqual([true]);
    expect(rpc.calls.map(({ method }) => method)).toEqual(['eth_chainId']);
  });

  it('a native 0.1 RPS queue can exceed four seconds before a fast discovery uses its physical cap', async () => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const admission = governor(0.1);
    await admission.acquire('foreground'); // Consume the burst; the next permit is ten seconds later.
    const current = provider(rpc.url, { admission });
    const caller = new AbortController();
    const reason = new Error('first queued discovery waiter left');
    const first = outcome(withRpcRequestContext({ signal: caller.signal }, () => current.getNetwork()));
    const peer = outcome(current.getNetwork());
    const beganAt = performance.now();
    try {
      await expect.poll(() => admission.snapshot().foregroundQueued).toBe(1);
      caller.abort(reason);
      await expect(first).resolves.toBe(reason);
      await pause(4_100);
      expect(rpc.totalHits()).toBe(0);
      expect(admission.snapshot()).toMatchObject({ foregroundQueued: 1, cancelled: 0, rejected: 0 });
      await expect(peer).resolves.toMatchObject({ chainId: 31_337n });
      expect(performance.now() - beganAt).toBeGreaterThan(4_000);
      expect(rpc.hits('eth_chainId')).toBe(1);
      expect(rpc.aborted('eth_chainId')).toBe(0);
      expect(admission.snapshot()).toMatchObject({ foregroundQueued: 0, foregroundAdmitted: 2, cancelled: 0 });
    } finally {
      caller.abort(reason);
      current.destroy();
      await Promise.all([first, peer]);
    }
  }, 20_000);

  it('an in-flight first waiter cancels promptly while its peer uses the same discovery request', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let socketClosed = 0;
    let discoveryContext: RpcRequestContext | undefined;
    let foreignTimeouts = 0;
    let foreignProgress = 0;
    const rpc = await harness.start(async (request, response) => {
      response.on('close', () => { if (!response.writableEnded) socketClosed++; });
      await released;
      sendJsonRpcResult(response, request, CHAIN_ID_HEX);
    });
    const current = provider(rpc.url, {
      discoveryStallTimeoutMs: 1_000,
      onRequest() { discoveryContext = activeRpcRequestContext(); },
    });
    const caller = new AbortController();
    const reason = new Error('first in-flight discovery waiter left');
    const first = outcome(withRpcRequestContext({
      requestClass: 'background', admissionPriority: 'authority', signal: caller.signal,
      onProgress: () => { foreignProgress++; },
      responseStallPolicy: { timeoutMs: 10, onTimeout: () => { foreignTimeouts++; } },
    }, () => current.getNetwork()));
    const peer = outcome(current.getNetwork());
    try {
      await expect.poll(() => rpc.calls.length).toBe(1);
      caller.abort(reason);
      await expect(first).resolves.toBe(reason);
      await pause(30); // Longer than the first waiter's foreign policy, shorter than the owner's cap.
      expect(socketClosed).toBe(0);
      expect(discoveryContext).toEqual({
        // The provider cap is selected at physical transport; discovery keeps
        // only its independent owner and must not inherit a caller policy.
        requestClass: 'foreground', signal: expect.any(AbortSignal),
      });
      expect(discoveryContext!.signal!.aborted).toBe(false);
      expect(foreignTimeouts).toBe(0);
      expect(foreignProgress).toBe(0);
      release();
      await expect(peer).resolves.toMatchObject({ chainId: 31_337n });
      expect(rpc.calls.map(({ method }) => method)).toEqual(['eth_chainId']);
      expect(socketClosed).toBe(0);
    } finally {
      caller.abort(reason);
      release();
      current.destroy();
      await Promise.all([first, peer]);
    }
  });

  it.each(['direct', 'inherited'] as const)('an already-aborted %s getter consumes no admission and starts no HTTP', async (scope) => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const admission = governor();
    const current = provider(rpc.url, { admission });
    const caller = new AbortController();
    const reason = new Error('already-aborted getter');
    caller.abort(reason);
    const pending = withRpcRequestContext({ signal: caller.signal }, () => (
      scope === 'direct' ? current.getNetwork() : withRpcRequestContext({}, () => current.getNetwork())
    ));

    await expect(pending).rejects.toBe(reason);
    current.destroy();
    await pause(30);
    expect(rpc.totalHits()).toBe(0);
    expect(admission.snapshot()).toMatchObject({ foregroundAdmitted: 0, foregroundQueued: 0, cancelled: 0 });
  });

  it('a discovery stall leaves the provider lifecycle usable for a fresh real discovery', async () => {
    let firstSocketClosed = 0;
    const contexts: RpcRequestContext[] = [];
    const rpc = await harness.start((request, response) => {
      if (rpc.calls.length === 1) {
        response.on('close', () => { if (!response.writableEnded) firstSocketClosed++; });
        return;
      }
      sendJsonRpcResult(response, request, CHAIN_ID_HEX);
    });
    const current = provider(rpc.url, { onRequest() { contexts.push(activeRpcRequestContext()); } });
    const failed = outcome(withRpcRequestTimeout(2_000, 'recovery test watchdog', () => current.getNetwork()));

    await expect(failed).resolves.toMatchObject({ code: 'RPC_TIMEOUT', message: expect.stringContaining('RPC response') });
    await expect.poll(() => firstSocketClosed).toBe(1);
    expect(contexts[0].signal!.aborted).toBe(false);
    await expect(current.getNetwork()).resolves.toMatchObject({ chainId: 31_337n });
    expect(rpc.calls.map(({ method }) => method)).toEqual(['eth_chainId', 'eth_chainId']);
    expect(contexts[1].signal!.aborted).toBe(false);
  });

  it('the coherent native pass leaves a cold hung endpoint for a fresh healthy fallback', async () => {
    const primary = await startLoopbackRpc({ hang: ['eth_chainId'] });
    const fallback = await startLoopbackRpc();
    const unused = await startLoopbackRpc();
    servers.push(primary, fallback, unused);
    const endpoints = [primary, fallback, unused].map(({ url }) => provider(url));
    const order: number[] = [];
    const result = readFirstProviderWithTransientRetry(endpoints, async (current) => {
      order.push(endpoints.indexOf(current));
      const network = await current.getNetwork();
      const [blockNumber, code] = await readRpcTuple<[string, string]>([
        () => current.send('eth_blockNumber', []) as Promise<string>,
        () => current.send('eth_getCode', ['0x' + '11'.repeat(20), '0x10']) as Promise<string>,
      ]);
      return { chainId: network.chainId, blockNumber, code };
    }, { retryDelayMs: 1, isRetryable: isContractViewRetryable });

    await expect(result).resolves.toEqual({ chainId: 31_337n, blockNumber: '0x10', code: '0x1234' });
    await expect.poll(() => primary.aborted('eth_chainId')).toBe(1);
    expect(order).toEqual([0, 1]);
    expect(primary.httpRequestMethods()).toEqual([['eth_chainId']]);
    expect(fallback.hits('eth_blockNumber')).toBe(1);
    expect(fallback.hits('eth_getCode')).toBe(1);
    expect(unused.totalHits()).toBe(0);
  });

  it('fixed-network shared validation uses the provider physical cap inside its independent 45-second owner', async () => {
    let firstSocketClosed = 0;
    let foreignTimeouts = 0;
    let foreignProgress = 0;
    let sharedSignal: AbortSignal | undefined;
    let physicalContext: RpcRequestContext | undefined;
    const rpc = await harness.start((request, response) => {
      if (rpc.calls.length === 1) {
        response.on('close', () => { if (!response.writableEnded) firstSocketClosed++; });
        return;
      }
      sendJsonRpcResult(response, request, CHAIN_ID_HEX);
    });
    const current = provider(rpc.url, {
      network: Network.from(31_337), onRequest() { physicalContext = activeRpcRequestContext(); },
    });
    await expect(current.getNetwork()).resolves.toMatchObject({ chainId: 31_337n });
    expect(rpc.calls).toEqual([]); // Static identity does not perform discovery; explicit validation is still physical.
    const validation = new AbortableKeyedSingleFlight<JsonRpcProvider, bigint>();
    const read = (waiterSignal?: AbortSignal) => validation.run(current, (signal) => {
      sharedSignal = signal;
      return withOwnedRpcRequestContext({ signal }, () => withRpcRequestTimeout(
        45_000, 'configured chainId validation', async () => BigInt(await current.send('eth_chainId', [])),
      ));
    }, waiterSignal);
    const caller = new AbortController();
    const reason = new Error('first static validation waiter left');
    const first = outcome(withRpcRequestContext({
      signal: caller.signal, onProgress: () => { foreignProgress++; },
      responseStallPolicy: { timeoutMs: 10, onTimeout: () => { foreignTimeouts++; } },
    }, () => read(caller.signal)));
    const peer = outcome(read());
    try {
      await expect.poll(() => rpc.calls.length).toBe(1);
      caller.abort(reason);
      await expect(first).resolves.toBe(reason);
      expect(sharedSignal!.aborted).toBe(false);
      await expect(peer).resolves.toMatchObject({ code: 'RPC_TIMEOUT', message: expect.stringContaining('RPC response') });
      await expect.poll(() => firstSocketClosed).toBe(1);
      expect(physicalContext?.responseStallPolicy).toBeUndefined();
      expect(physicalContext?.onProgress).toBeUndefined();
      expect(foreignTimeouts).toBe(0);
      expect(foreignProgress).toBe(0);
      expect(rpc.calls.map(({ method }) => method)).toEqual(['eth_chainId']);
      await expect(read()).resolves.toBe(31_337n);
      expect(rpc.calls.map(({ method }) => method)).toEqual(['eth_chainId', 'eth_chainId']);
    } finally {
      caller.abort(reason);
      current.destroy();
      await Promise.all([first, peer]);
    }
  });
  it.each(['owned', 'detached'] as const)('%s physical work drops a first caller response callback and deadline', async (boundary) => {
    let foreignTimeouts = 0;
    let foreignProgress = 0;
    let physicalContext: RpcRequestContext | undefined;
    const rpc = await harness.start(async (request, response) => {
      await pause(40);
      sendJsonRpcResult(response, request, '0x10');
    });
    const current = provider(rpc.url, {
      network: Network.from(31_337), onRequest() { physicalContext = activeRpcRequestContext(); },
    });
    const owner = new AbortController();
    const run = () => current.send('eth_blockNumber', []);
    const pending = withRpcRequestContext({
      onProgress: () => { foreignProgress++; },
      responseStallPolicy: { timeoutMs: 10, onTimeout: () => { foreignTimeouts++; } },
    }, () => boundary === 'owned'
      ? withOwnedRpcRequestContext({ signal: owner.signal }, run)
      : withDetachedRpcRequestContext('background', run));

    await expect(pending).resolves.toBe('0x10');
    expect(physicalContext?.responseStallPolicy).toBeUndefined();
    expect(physicalContext?.onProgress).toBeUndefined();
    expect(foreignTimeouts).toBe(0);
    expect(foreignProgress).toBe(0);
    expect(rpc.calls.map(({ method }) => method)).toEqual(['eth_blockNumber']);
  });
});
