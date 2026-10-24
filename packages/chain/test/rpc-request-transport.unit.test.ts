// SPDX-License-Identifier: Apache-2.0
/**
 * RPC request transport cancellation, admission, retry, and batching contracts.
 * Loopback RPC servers prove whether a request physically reached the provider.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Network } from 'ethers';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { rpcUsageWindowTotal } from '../src/rpc-usage.js';
import {
  activeRpcRequestContext,
  createBatchedRpcRequestProvider,
  createRpcRequestProvider,
  withOwnedRpcRequestContext,
  withRpcRequestContext,
  withRpcRequestTimeout,
  type RpcRequestContext,
} from '../src/rpc-request-transport.js';
import { RpcRequestGovernor } from '../src/rpc-request-governor.js';
import { createRpcTimeoutError } from '../src/chain-rpc-transport-error.js';
import {
  CHAIN_ID_HEX,
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcResult,
  startLoopbackRpc,
  type LoopbackRpc,
} from './loopback-rpc-harness.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB = '0x0000000000000000000000000000000000000001';

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    privateKey: DEPLOYER_PK,
    hubAddress: HUB,
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    ...overrides,
  };
}

describe('RPC request transport', () => {
  let mp: MeterProvider | null = null;
  let exporter: InMemoryMetricExporter;
  const adapters: EVMChainAdapter[] = [];
  const servers: LoopbackRpc[] = [];

  function installMeter(): void {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    mp = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();
  }

  afterEach(async () => {
    for (const a of adapters.splice(0)) { try { a.destroy(); } catch { /* idempotent */ } }
    for (const s of servers.splice(0)) await s.close();
    if (mp) { await mp.forceFlush().catch(() => {}); await mp.shutdown().catch(() => {}); mp = null; }
    metrics.disable();
    rebuildMetrics();
  });

  it('separates compositional caller cancellation from owned work cancellation', () => {
    const caller = new AbortController();
    const child = new AbortController();
    const owner = new AbortController();
    let composed!: RpcRequestContext;
    let owned!: RpcRequestContext;
    const onProgress = () => {};

    withRpcRequestContext({
      requestClass: 'background',
      admissionPriority: 'authority',
      signal: caller.signal,
      onProgress,
    }, () => {
      withRpcRequestContext({ signal: child.signal }, () => {
        composed = activeRpcRequestContext();
      });
      withOwnedRpcRequestContext({ signal: owner.signal }, () => {
        owned = activeRpcRequestContext();
      });
    });

    expect(composed.requestClass).toBe('background');
    expect(composed.admissionPriority).toBe('authority');
    expect(composed.onProgress).toBe(onProgress);
    expect(owned).toEqual({
      requestClass: 'background',
      admissionPriority: 'authority',
      signal: owner.signal,
    });
    caller.abort(new Error('caller left'));
    expect(composed.signal?.aborted).toBe(true);
    expect(owned.signal?.aborted).toBe(false);
    owner.abort(new Error('owner stopped'));
    expect(owned.signal?.aborted).toBe(true);
  });

  it('reports successful issuer RPC progress through nested deadlines only', async () => {
    const rpc = await startLoopbackRpc({ throttle: ['eth_getCode'] });
    servers.push(rpc);
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0, network: Network.from(31_337),
      providerOptions: { batchMaxCount: 1 },
    });
    let progress = 0;
    const onProgress = () => { progress++; };
    try {
      await expect(withRpcRequestContext({ onProgress }, () =>
        withRpcRequestTimeout(2_000, 'test read', () => provider.send('eth_blockNumber', [])),
      )).resolves.toBe('0x10');
      expect(progress).toBe(1);
      await expect(withRpcRequestContext({ onProgress }, () =>
        provider.send('eth_getCode', []),
      )).rejects.toThrow();
      expect(progress).toBe(1);
      await withRpcRequestContext({ onProgress }, () =>
        withOwnedRpcRequestContext({ requestClass: 'background' }, () =>
          provider.send('eth_blockNumber', []),
        ),
      );
      expect(progress).toBe(1);
      await expect(withRpcRequestContext({ onProgress: () => { throw new Error('observer'); } }, () =>
        provider.send('eth_blockNumber', []),
      )).resolves.toBe('0x10');
    } finally {
      provider.destroy();
    }
  });

  it('keeps a concurrent caller alive when a request queued beside it is cancelled', async () => {
    // Two callers issue a request in the SAME scheduling turn, so both payloads
    // share one provider dispatch window. Cancelling the first must not reach
    // the second: an abort landing on the peer's live HTTP attempt surfaces as
    // a transport fault and is reported as exhaustion carrying the FOREIGN
    // cancellation reason.
    const rpc = await startLoopbackRpc({ hang: ['eth_blockNumber'] });
    servers.push(rpc);
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
    });
    const abandoned = new AbortController();
    const peer = new AbortController();
    const abandonment = Object.assign(
      new Error('Shared request has no active waiters'),
      { name: 'AbortError' },
    );
    let abandonedProgress = 0;
    let peerProgress = 0;

    const abandonedRead = withOwnedRpcRequestContext(
      { signal: abandoned.signal, onProgress: () => { abandonedProgress++; } },
      () => provider.send('eth_blockNumber', []),
    );
    // Settle the abandoned read into a value so its rejection is owned from the
    // start; it fails before the peer assertion below can attach a handler.
    const abandonedOutcome = abandonedRead.then(() => undefined, (error: unknown) => error);
    const peerRead = withOwnedRpcRequestContext(
      { signal: peer.signal, onProgress: () => { peerProgress++; } },
      () => provider.send('eth_chainId', []),
    );
    abandoned.abort(abandonment);

    try {
      await expect(peerRead).resolves.toBe(CHAIN_ID_HEX);
      expect(rpc.aborted('eth_chainId')).toBe(0);
      await expect(provider.getNetwork()).resolves.toMatchObject({ chainId: 31_337n });
      // The abandoning caller still loses its own physical request.
      expect(await abandonedOutcome).toMatchObject({ name: 'AbortError' });
      expect(abandonedProgress).toBe(0);
      expect(peerProgress).toBe(1);
    } finally {
      if (!peer.signal.aborted) peer.abort(new Error('test teardown'));
      await Promise.allSettled([abandonedOutcome, peerRead]);
      provider.destroy();
    }
  });

  it('preserves ethers startup, debug events, network detection, and high-level reads', async () => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
    });
    const debugActions: string[] = [];
    await provider.on('debug', (event) => {
      if ('action' in event) debugActions.push(event.action);
    });

    try {
      await expect(provider.send('eth_blockNumber', [])).resolves.toBe('0x10');
      expect(provider.ready).toBe(true);
      await expect(provider.getNetwork()).resolves.toMatchObject({ chainId: 31_337n });
      await expect(provider.getBlockNumber()).resolves.toBe(16);
      expect(debugActions).toContain('sendRpcPayload');
      expect(debugActions).toContain('receiveRpcResult');
    } finally {
      provider.destroy();
    }
  });

  it.each(['getNetwork', 'send'] as const)('destroy removes queued discovery started by %s without late HTTP', async (entrypoint) => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    let now = 0;
    let releaseAdmission = () => {};
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 0.1,
      foregroundReservePercent: 0,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 0,
    }, {
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout(callback, delayMs) {
          const timer = setTimeout(callback, delayMs);
          timer.unref?.();
          releaseAdmission = () => {
            clearTimeout(timer);
            now += 10_000;
            callback();
          };
          return timer;
        },
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });
    await governor.acquire('foreground');
    const provider = createRpcRequestProvider(rpc.url, { maxRetries: 0, admission: governor });
    const healthyPeer = createRpcRequestProvider(rpc.url, {
      maxRetries: 0, admission: governor, network: Network.from(31_337),
    });
    const caller = new AbortController();
    const reason = new Error('startup stopped');
    const pending = withRpcRequestContext({ signal: caller.signal }, () =>
      entrypoint === 'getNetwork' ? provider.getNetwork() : provider.send('eth_blockNumber', []),
    ).then(() => undefined, (error: unknown) => error);
    // Observe the shared discovery separately from the ordinary send, which
    // can settle on caller cancellation before discovery is destroyed.
    const discovery = provider.getNetwork().then(() => undefined, (error: unknown) => error);
    try {
      await expect.poll(() => governor.snapshot().foregroundQueued).toBe(entrypoint === 'send' ? 2 : 1);
      caller.abort(reason);
      await expect.poll(() => governor.snapshot().foregroundQueued).toBe(1);
      expect(rpc.totalHits()).toBe(0);
      provider.destroy();
      provider.destroy();
      expect(governor.snapshot()).toMatchObject({
        foregroundQueued: 0,
        cancelled: entrypoint === 'send' ? 2 : 1,
      });
      await expect(discovery).resolves.toBeInstanceOf(Error);
      await expect(pending).resolves.toBeInstanceOf(Error);
      // A cancelled wakeup must not dispatch discovery or consume the refill.
      // A real HTTP response from another provider proves the released token
      // remains usable, rather than merely checking an empty queue snapshot.
      releaseAdmission();
      await expect(healthyPeer.send('eth_blockNumber', [])).resolves.toBe('0x10');
      expect(rpc.hits('eth_chainId')).toBe(0);
      expect(rpc.totalHits()).toBe(1);
      expect(governor.snapshot().foregroundAdmitted).toBe(2);
    } finally {
      caller.abort(reason);
      provider.destroy();
      // Drain the old implementation's orphan on a failing regression run.
      releaseAdmission();
      await Promise.all([pending, discovery]);
      healthyPeer.destroy();
    }
  });

  it.each(['getNetwork', 'send'] as const)('destroy physically aborts hanging discovery started by %s', async (entrypoint) => {
    const rpc = await startLoopbackRpc({ hang: ['eth_chainId'] });
    servers.push(rpc);
    let discoveryContext: RpcRequestContext | undefined;
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      onRequest(method) {
        if (method === 'eth_chainId') discoveryContext = activeRpcRequestContext();
      },
    });
    let callerProgress = 0;
    const caller = new AbortController();
    const pending = withRpcRequestContext({
      requestClass: 'background', admissionPriority: 'authority', signal: caller.signal,
      onProgress: () => { callerProgress++; },
    }, () => entrypoint === 'getNetwork' ? provider.getNetwork() : provider.send('eth_blockNumber', []))
      .then(() => undefined, (error: unknown) => error);
    const discovery = provider.getNetwork().then(() => undefined, (error: unknown) => error);
    const destroyedAtAbort: boolean[] = [];
    try {
      await expect.poll(() => rpc.hits('eth_chainId')).toBe(1);
      discoveryContext?.signal?.addEventListener('abort', () => {
        destroyedAtAbort.push(provider.destroyed);
      }, { once: true });
      caller.abort(new Error('startup stopped'));
      provider.destroy();
      provider.destroy();
      await expect.poll(() => rpc.aborted('eth_chainId')).toBe(1);
      await expect(discovery).resolves.toBeInstanceOf(Error);
      expect(discoveryContext).toEqual({ requestClass: 'foreground', signal: expect.any(AbortSignal) });
      expect(discoveryContext!.signal!.aborted).toBe(true);
      expect(destroyedAtAbort).toEqual([true]);
      expect(rpc.hits('eth_chainId')).toBe(1);
      if (entrypoint === 'getNetwork') expect(callerProgress).toBe(0);
    } finally {
      caller.abort(new Error('test cleanup'));
      provider.destroy();
      // Close the old implementation's orphan before awaiting it on red runs.
      await rpc.close();
      await Promise.all([pending, discovery]);
    }
  });

  it.each(['getNetwork', 'send'] as const)('keeps discovery started by %s alive for a peer after its first caller aborts', async (entrypoint) => {
    const harness = createLoopbackJsonRpcTestHarness();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let discoveryClosed = 0;
    const rpc = await harness.start(async (request, response) => {
      if (request.method === 'eth_chainId') {
        response.on('close', () => { if (!response.writableEnded) discoveryClosed++; });
      }
      await released;
      sendJsonRpcResult(response, request, request.method === 'eth_chainId' ? CHAIN_ID_HEX : '0x10');
    });
    const provider = createRpcRequestProvider(rpc.url, { maxRetries: 0 });
    const caller = new AbortController();
    const reason = new Error('first discovery caller left');
    const pending = withRpcRequestContext({ signal: caller.signal }, () =>
      withRpcRequestTimeout(5_000, 'first discovery caller', () =>
        entrypoint === 'getNetwork' ? provider.getNetwork() : provider.send('eth_blockNumber', []),
      ),
    ).then(() => undefined, (error: unknown) => error);
    const peer = provider.getNetwork();
    // Own a possible peer failure immediately, including while asserting that
    // the cancelled caller settles before the server releases discovery.
    const peerOutcome = peer.then((network) => network, (error: unknown) => error);
    try {
      await expect.poll(() => rpc.calls.filter((request) => request.method === 'eth_chainId').length).toBe(1);
      caller.abort(reason);
      await expect(pending).resolves.toBe(reason);
      expect(discoveryClosed).toBe(0);
      release();
      await expect(peerOutcome).resolves.toMatchObject({ chainId: 31_337n });
      expect(discoveryClosed).toBe(0);
      expect(rpc.calls.filter((request) => request.method === 'eth_chainId')).toHaveLength(1);
      await expect(provider.getBlockNumber()).resolves.toBe(16);
    } finally {
      caller.abort(reason);
      release();
      provider.destroy();
      await harness.stopAll();
      await Promise.all([pending, peerOutcome]);
    }
  });

  it('rejects an in-flight response after destruction through ethers lifecycle handling', async () => {
    const harness = createLoopbackJsonRpcTestHarness();
    let markBlockNumberSeen!: () => void;
    const blockNumberSeen = new Promise<void>((resolve) => { markBlockNumberSeen = resolve; });
    let releaseBlockNumber!: () => void;
    const blockNumberReleased = new Promise<void>((resolve) => { releaseBlockNumber = resolve; });
    const rpc = await harness.start(async (request, response) => {
      if (request.method === 'eth_chainId') {
        sendJsonRpcResult(response, request, CHAIN_ID_HEX);
        return;
      }
      if (request.method === 'eth_blockNumber') {
        markBlockNumberSeen();
        await blockNumberReleased;
        sendJsonRpcResult(response, request, '0x10');
        return;
      }
      sendJsonRpcResult(response, request, '0x');
    });
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
    });
    const pending = provider.send('eth_blockNumber', []);

    try {
      await blockNumberSeen;
      provider.destroy();
      releaseBlockNumber();
      await expect(pending).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        operation: 'eth_blockNumber',
      });
    } finally {
      releaseBlockNumber();
      await pending.catch(() => {});
      provider.destroy();
      await harness.stopAll();
    }
  });

  it('emits ethers missing-response errors for malformed RPC replies', async () => {
    const harness = createLoopbackJsonRpcTestHarness();
    const rpc = await harness.start((request, response) => {
      if (request.method === 'eth_chainId') {
        sendJsonRpcResult(response, request, CHAIN_ID_HEX);
        return;
      }
      sendJsonRpcResult(response, { ...request, id: request.id + 1 }, '0x10');
    });
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
    });
    const errors: unknown[] = [];
    await provider.on('error', (error) => { errors.push(error); });

    try {
      await expect(provider.send('eth_blockNumber', [])).rejects.toMatchObject({
        code: 'BAD_DATA',
      });
      await expect.poll(() => errors.length).toBe(1);
      expect(errors[0]).toMatchObject({ code: 'BAD_DATA' });
    } finally {
      provider.destroy();
      await harness.stopAll();
    }
  });

  it('cancels the active ethers HTTP request when the caller aborts a chain read', async () => {
    const rpc = await startLoopbackRpc({ hang: ['eth_blockNumber'] });
    servers.push(rpc);
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
    });
    const controller = new AbortController();
    const timeoutError = createRpcTimeoutError('authentication attempt timed out');

    const pending = withRpcRequestContext(
      { signal: controller.signal },
      () => provider.send('eth_blockNumber', []),
    );
    try {
      for (let turn = 0; turn < 50 && rpc.hits('eth_blockNumber') === 0; turn += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      expect(rpc.hits('eth_blockNumber')).toBe(1);
      controller.abort(timeoutError);
      await expect(pending).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
      for (let turn = 0; turn < 50 && rpc.aborted('eth_blockNumber') === 0; turn += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      expect(rpc.aborted('eth_blockNumber')).toBe(1);
    } finally {
      if (!controller.signal.aborted) controller.abort(timeoutError);
      await pending.catch(() => {});
      provider.destroy();
    }
  });

  it('owns the active socket deadline and aborts a hanging provider request', async () => {
    const rpc = await startLoopbackRpc({ hang: ['eth_blockNumber'] });
    servers.push(rpc);
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 5,
      providerOptions: { batchMaxCount: 1 },
    });
    const pending = withRpcRequestTimeout(
      50,
      'unit hanging request',
      () => provider._send({
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
      }),
    );
    try {
      await expect(pending).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
      await expect.poll(() => rpc.aborted('eth_blockNumber')).toBe(1);
      expect(rpc.hits('eth_blockNumber')).toBe(1);
    } finally {
      await pending.catch(() => {});
      provider.destroy();
    }
  });

  it('cancels retry backoff at the helper-owned deadline without a delayed retry', async () => {
    const rpc = await startLoopbackRpc({ throttle: ['eth_blockNumber'] });
    servers.push(rpc);
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 5,
      providerOptions: { batchMaxCount: 1 },
    });
    const pending = withRpcRequestTimeout(
      100,
      'unit retry backoff',
      () => provider._send({
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
      }),
    );
    try {
      await expect(pending).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
      expect(rpc.hits('eth_blockNumber')).toBe(1);
      await new Promise<void>((resolve) => setTimeout(resolve, 550));
      expect(rpc.hits('eth_blockNumber')).toBe(1);
    } finally {
      await pending.catch(() => {});
      provider.destroy();
    }
  });

  it('removes an aborted request while it is waiting for governor capacity', async () => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 0.1,
      foregroundReservePercent: 0,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    await governor.acquire('foreground');
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
      admission: governor,
    });
    const controller = new AbortController();
    const timeoutError = createRpcTimeoutError('caller deadline expired');
    const pending = withRpcRequestContext(
      { signal: controller.signal },
      () => provider._send({
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
      }),
    );
    try {
      await expect.poll(() => governor.snapshot().foregroundQueued).toBe(1);
      controller.abort(timeoutError);
      await expect(pending).rejects.toBe(timeoutError);
      expect(rpc.totalHits()).toBe(0);
      expect(governor.snapshot()).toMatchObject({
        foregroundQueued: 0,
        cancelled: 1,
      });
    } finally {
      if (!controller.signal.aborted) controller.abort(timeoutError);
      await pending.catch(() => {});
      provider.destroy();
    }
  });

  it('neither dispatches nor fails over after an attempt\'s admission deadline expires', async () => {
    const primary = await startLoopbackRpc();
    const backup = await startLoopbackRpc();
    servers.push(primary, backup);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 0.1,
      foregroundReservePercent: 0,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    await governor.acquire('foreground');
    const adapter = new EVMChainAdapter(minimalConfig({
      rpcUrl: primary.url,
      rpcUrls: [backup.url],
      rpcRequestAdmission: governor,
    }));
    adapters.push(adapter);

    // The attempt never left the shared local queue, so the backup is not
    // tried: it would only wait behind the same governor.
    await expect(adapter.getBlockNumber()).rejects.toMatchObject({
      code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
    });
    expect(governor.snapshot()).toMatchObject({
      foregroundQueued: 0,
      cancelled: 1,
    });
    // The first abandoned waiter would receive the 10-second refill here if
    // the attempt timeout had merely raced it instead of aborting admission.
    await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
    expect(primary.totalHits() + backup.totalHits()).toBe(0);
  }, 15_000);

  it('surfaces queue saturation without failing over across the shared governor', async () => {
    const primary = await startLoopbackRpc();
    const backup = await startLoopbackRpc();
    servers.push(primary, backup);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 0.1,
      foregroundReservePercent: 0,
      burstRequests: 1,
      maxQueueSize: 1,
      startupJitterMs: 0,
    });
    await governor.acquire('foreground');
    const queuedController = new AbortController();
    const queued = governor.acquire('foreground', queuedController.signal);
    const adapter = new EVMChainAdapter(minimalConfig({
      rpcUrl: primary.url,
      rpcUrls: [backup.url],
      rpcRequestAdmission: governor,
    }));
    adapters.push(adapter);
    try {
      await expect(adapter.getBlockNumber()).rejects.toMatchObject({
        code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
      });
      expect(primary.totalHits() + backup.totalHits()).toBe(0);
      expect(governor.snapshot().rejected).toBe(1);
    } finally {
      queuedController.abort(new Error('test cleanup'));
      await queued.catch(() => {});
    }
  });

  it('RETRIES BILL: ethers 429-retry attempts below _send are counted (tracker == server hits)', async () => {
    installMeter();
    // Single-RPC adapter → boundedRetryFetchRequest keeps the default retry
    // budget (5), and a perpetually-throttled method makes ethers issue
    // 1 + 5 HTTP attempts inside ONE _send dispatch. Every attempt is a
    // billable provider request and the server sees each one — the tracker
    // must match exactly (this is the undercount the review flagged).
    const rpc = await startLoopbackRpc({ throttle: ['eth_chainId'] });
    servers.push(rpc);
    const rpcRequestGovernor = new RpcRequestGovernor({
      maxRequestsPerSecond: 10_000,
      foregroundReservePercent: 0,
      burstRequests: 100_000,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: rpc.url,
      staticNetwork: false,
      rpcRequestAdmission: rpcRequestGovernor,
    }));
    adapters.push(a);

    await expect(a.getEvmChainId()).rejects.toBeTruthy(); // perpetual 429 → bounded failure

    const usage = a.drainRpcUsage();
    expect(rpc.hits('eth_chainId')).toBeGreaterThanOrEqual(2); // initial + ≥1 retry actually happened
    expect(usage.byMethod['eth_chainId'] ?? 0).toBe(rpc.hits('eth_chainId'));
    expect(rpcUsageWindowTotal(usage)).toBe(rpc.totalHits());
    const admission = rpcRequestGovernor.snapshot();
    expect(admission.foregroundAdmitted + admission.backgroundAdmitted)
      .toBe(rpc.totalHits());
  }, 30_000);

  it('forces single-entry batching when governed even if provider options are omitted', () => {
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    const provider = createRpcRequestProvider('http://127.0.0.1:1', {
      admission: governor,
    });
    try {
      expect((provider as any)._getOption('batchMaxCount')).toBe(1);
    } finally {
      provider.destroy();
    }
  });

  it('rejects a governed batchMaxCount override above one at construction', () => {
    const governor = new RpcRequestGovernor({ startupJitterMs: 0 });
    expect(() => createRpcRequestProvider('http://127.0.0.1:1', {
      admission: governor,
      providerOptions: { batchMaxCount: 2 },
    })).toThrow(/batchMaxCount <= 1/u);
  });

  it('requires an explicit batched transport when batching is requested', () => {
    expect(() => createRpcRequestProvider('http://127.0.0.1:1', {
      providerOptions: { batchMaxCount: 2 },
    })).toThrow(/createBatchedRpcRequestProvider/u);
  });

  it('restores foreground and background admission across concurrent sends', async () => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      network: Network.from(31_337),
      admission: governor,
    });
    try {
      const background = withOwnedRpcRequestContext(
        { requestClass: 'background' },
        () => provider.send('eth_blockNumber', []),
      );
      const foreground = withOwnedRpcRequestContext(
        { requestClass: 'foreground' },
        () => provider.send('eth_chainId', []),
      );
      await expect(background).resolves.toBe('0x10');
      await expect(foreground).resolves.toBe(CHAIN_ID_HEX);
      expect(governor.snapshot()).toMatchObject({
        foregroundAdmitted: 1,
        backgroundAdmitted: 1,
      });
    } finally {
      provider.destroy();
    }
  });

  it('keeps startup network discovery foreground when the first caller is background', async () => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 50,
      burstRequests: 4,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      admission: governor,
    });

    try {
      await expect(withRpcRequestContext(
        { requestClass: 'background' },
        () => provider.send('eth_blockNumber', []),
      )).resolves.toBe('0x10');
      expect(rpc.hits('eth_chainId')).toBe(1);
      expect(governor.snapshot()).toMatchObject({
        foregroundAdmitted: 1,
        backgroundAdmitted: 1,
      });
    } finally {
      provider.destroy();
    }
  });

  it('paces concurrent governed sends as independent single-entry HTTP requests', async () => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    // Keep refill time independent of real HTTP/CI scheduling. Otherwise the
    // 50 ms permit window can expire before the observer sees the first hit.
    let governorNowMs = 0;
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 20,
      foregroundReservePercent: 0,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 0,
    }, {
      clock: {
        now: () => governorNowMs,
        random: () => 0,
        setTimeout,
        clearTimeout,
      },
    });
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      admission: governor,
    });
    const controller = new AbortController();
    const sends: Promise<unknown>[] = [];
    try {
      const first = withOwnedRpcRequestContext({ signal: controller.signal }, () => provider._send({
        id: 1, jsonrpc: '2.0', method: 'eth_blockNumber', params: [],
      }));
      const second = withOwnedRpcRequestContext({ signal: controller.signal }, () => provider._send({
        id: 2, jsonrpc: '2.0', method: 'eth_chainId', params: [],
      }));
      sends.push(first, second);
      const both = Promise.all(sends);
      // Own an unexpected rejection even while asserting the queued state.
      void both.catch(() => {});
      await expect.poll(() => governor.snapshot().foregroundQueued).toBe(1);
      await first;
      expect(rpc.totalHits()).toBe(1);
      governorNowMs = 49;
      expect(governor.snapshot()).toMatchObject({
        foregroundAdmitted: 1,
        foregroundQueued: 1,
      });
      governorNowMs = 50;
      await both;
      expect(rpc.totalHits()).toBe(2);
      expect(rpc.httpRequestMethods()).toEqual([['eth_blockNumber'], ['eth_chainId']]);
      expect(governor.snapshot()).toMatchObject({
        foregroundAdmitted: 2,
        foregroundQueued: 0,
      });
    } finally {
      controller.abort(new Error('test teardown'));
      provider.destroy();
      await Promise.allSettled(sends);
    }
  });

  it('rejects a direct multi-entry dispatch before mid-admission cancellation can burn permits', async () => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 0,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      admission: governor,
    });
    try {
      await expect(provider._send([
        { id: 1, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] },
        { id: 2, jsonrpc: '2.0', method: 'eth_chainId', params: [] },
      ])).rejects.toThrow(/single-entry JSON-RPC dispatch/u);
      expect(rpc.totalHits()).toBe(0);
      expect(governor.snapshot()).toMatchObject({
        foregroundAdmitted: 0,
        foregroundQueued: 0,
      });
    } finally {
      provider.destroy();
    }
  });

  it('batches public sends and accounts every entry at the HTTP-attempt boundary', async () => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const observed: string[] = [];
    const provider = createBatchedRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      network: Network.from(31_337),
      providerOptions: { batchMaxCount: 2 },
      onRequest: (method) => { observed.push(method); },
    });
    try {
      const blockNumber = provider.send('eth_blockNumber', []);
      const code = provider.send('eth_getCode', []);
      await expect(Promise.all([blockNumber, code])).resolves.toEqual(['0x10', '0x1234']);
      expect(observed).toEqual(['eth_blockNumber', 'eth_getCode']);
      expect(rpc.hits('eth_blockNumber')).toBe(1);
      expect(rpc.hits('eth_getCode')).toBe(1);
      expect(rpc.httpRequestMethods()).toEqual([
        ['eth_blockNumber', 'eth_getCode'],
      ]);
    } finally {
      provider.destroy();
    }
  });

});
