// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RPC_TIMING_BUCKET_UPPER_MS,
  diffRpcRequestTiming,
  recordRpcAdmissionWait,
  recordRpcEndpointLatency,
  resetRpcRequestTimingForTests,
  snapshotRpcRequestTiming,
} from '../src/rpc-request-timing.js';

describe('RPC request timing accumulator', () => {
  beforeEach(() => resetRpcRequestTimingForTests());

  it('starts empty and keeps the two request classes separate', () => {
    const empty = snapshotRpcRequestTiming();
    expect(empty.background.admissionWait.count).toBe(0);
    expect(empty.foreground.endpointLatency.totalMs).toBe(0);

    recordRpcAdmissionWait('background', 1_500);
    recordRpcEndpointLatency('foreground', 80, true);
    const snapshot = snapshotRpcRequestTiming();
    expect(snapshot.background.admissionWait).toMatchObject({ count: 1, totalMs: 1_500 });
    expect(snapshot.background.endpointLatency.count).toBe(0);
    expect(snapshot.foreground.endpointLatency).toMatchObject({ count: 1, totalMs: 80 });
    expect(snapshot.foreground.admissionWait.count).toBe(0);
  });

  it('places observations in fixed inclusive buckets and counts failed attempts', () => {
    for (const ms of [0, 10, 11, 100, 101, 1_000, 5_000, 20_000, 20_001]) {
      recordRpcAdmissionWait('background', ms);
    }
    recordRpcEndpointLatency('background', 40, true);
    recordRpcEndpointLatency('background', 9_000, false);
    const { background } = snapshotRpcRequestTiming();
    expect(RPC_TIMING_BUCKET_UPPER_MS).toEqual([10, 100, 1_000, 5_000, 20_000]);
    // <=10, <=100, <=1000, <=5000, <=20000, >20000
    expect(background.admissionWait.buckets).toEqual([2, 2, 2, 1, 1, 1]);
    expect(background.endpointLatency.count).toBe(2);
    expect(background.endpointFailures).toBe(1);
  });

  it('ignores negative, non-finite and NaN observations instead of corrupting totals', () => {
    recordRpcAdmissionWait('background', -1);
    recordRpcAdmissionWait('background', Number.NaN);
    recordRpcAdmissionWait('background', Number.POSITIVE_INFINITY);
    recordRpcEndpointLatency('foreground', -5, true);
    const snapshot = snapshotRpcRequestTiming();
    expect(snapshot.background.admissionWait.count).toBe(0);
    expect(snapshot.foreground.endpointLatency.count).toBe(0);
  });

  it('returns immutable, non-aliased snapshots that diff to the interval between them', () => {
    recordRpcAdmissionWait('background', 500);
    const before = snapshotRpcRequestTiming();
    recordRpcAdmissionWait('background', 2_500);
    recordRpcAdmissionWait('background', 30);
    recordRpcEndpointLatency('background', 200, true);
    const after = snapshotRpcRequestTiming();

    expect(before.background.admissionWait.count).toBe(1);
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.background.admissionWait.buckets)).toBe(true);

    const delta = diffRpcRequestTiming(before, after);
    expect(delta.background.admissionWait).toMatchObject({ count: 2, totalMs: 2_530 });
    expect(delta.background.admissionWait.buckets).toEqual([0, 1, 0, 1, 0, 0]);
    expect(delta.background.endpointLatency).toMatchObject({ count: 1, totalMs: 200 });
    expect(delta.foreground.admissionWait.count).toBe(0);
  });
});

describe('RPC request timing through the governed provider', () => {
  beforeEach(() => resetRpcRequestTimingForTests());
  afterEach(() => vi.restoreAllMocks());

  it('counts every admitted attempt of each request class', async () => {
    const [{ RpcRequestGovernor }, { createRpcRequestProvider, withRpcRequestContext }, { startLoopbackRpc }] = await Promise.all([
      import('../src/rpc-request-governor.js'),
      import('../src/rpc-request-transport.js'),
      import('./loopback-rpc-harness.js'),
    ]);
    const rpc = await startLoopbackRpc();
    // Background gets 20% of the budget, so its requests queue behind the bucket.
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 50,
      foregroundReservePercent: 80,
      burstRequests: 20,
      maxQueueSize: 16,
      startupJitterMs: 0,
    });
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
      admission: governor,
    });
    try {
      const background = <T,>(run: () => Promise<T>) => withRpcRequestContext({ requestClass: 'background' }, run);
      await background(() => provider.send('eth_blockNumber', []));
      await background(() => provider.send('eth_blockNumber', []));
      await background(() => provider.send('eth_blockNumber', []));
      await provider.send('eth_blockNumber', []); // foreground (default class)

      const snapshot = snapshotRpcRequestTiming();
      expect(rpc.hits('eth_blockNumber')).toBe(4);
      expect(snapshot.background.admissionWait.count).toBe(3);
      expect(snapshot.background.endpointLatency.count).toBe(3);
      expect(snapshot.background.endpointFailures).toBe(0);
      // Foreground: the explicit read plus the provider's own network discovery.
      expect(snapshot.foreground.admissionWait.count).toBe(rpc.totalHits() - 3);
      expect(snapshot.foreground.endpointLatency.count).toBe(rpc.totalHits() - 3);
    } finally {
      provider.destroy();
      await rpc.close();
    }
  });

  it('attributes a queued admission and a slow endpoint answer each to its own metric', async () => {
    const [{ createRpcRequestProvider, withRpcRequestContext }, loopback, { Network }] = await Promise.all([
      import('../src/rpc-request-transport.js'),
      import('./loopback-rpc-harness.js'),
      import('ethers'),
    ]);
    // A virtual clock that only the two simulated delays advance, so every duration is exact and
    // neither can leak into the other's metric unnoticed.
    let virtualNow = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => virtualNow);
    let admissionDelayMs = 0;
    let endpointDelayMs = 0;
    const harness = loopback.createLoopbackJsonRpcTestHarness();
    const server = await harness.start((call, response) => {
      virtualNow += endpointDelayMs;
      loopback.sendJsonRpcResult(response, call, call.method === 'eth_chainId' ? loopback.CHAIN_ID_HEX : '0x10');
    });
    const provider = createRpcRequestProvider(server.url, {
      maxRetries: 0,
      network: Network.from(31_337),
      admission: { acquireActiveRequest: async () => { virtualNow += admissionDelayMs; } },
    });
    const measureBackground = async () => {
      const before = snapshotRpcRequestTiming();
      await withRpcRequestContext({ requestClass: 'background' }, () => provider.send('eth_blockNumber', []));
      return diffRpcRequestTiming(before, snapshotRpcRequestTiming());
    };
    try {
      await provider.send('eth_chainId', []); // foreground warm-up: network discovery is out of the way

      // Queued in admission, answered instantly: only the admission metric moves.
      admissionDelayMs = 700;
      endpointDelayMs = 0;
      const queued = await measureBackground();
      expect(queued.background.admissionWait).toMatchObject({ count: 1, totalMs: 700 });
      expect(queued.background.endpointLatency).toMatchObject({ count: 1, totalMs: 0 });

      // Admitted at once, slow endpoint: only the endpoint metric moves.
      admissionDelayMs = 0;
      endpointDelayMs = 300;
      const slow = await measureBackground();
      expect(slow.background.admissionWait).toMatchObject({ count: 1, totalMs: 0 });
      expect(slow.background.endpointLatency).toMatchObject({ count: 1, totalMs: 300 });

      // Both at once: each keeps exactly its own duration, in its own bucket.
      admissionDelayMs = 120;
      endpointDelayMs = 4_500;
      const both = await measureBackground();
      expect(both.background.admissionWait).toMatchObject({ count: 1, totalMs: 120 });
      expect(both.background.endpointLatency).toMatchObject({ count: 1, totalMs: 4_500 });
      // <=10, <=100, <=1000, <=5000, <=20000, >20000
      expect(both.background.admissionWait.buckets).toEqual([0, 0, 1, 0, 0, 0]);
      expect(both.background.endpointLatency.buckets).toEqual([0, 0, 0, 1, 0, 0]);
      // Foreground was never touched by any of the background attempts.
      expect(both.foreground.admissionWait.count).toBe(0);
      expect(both.foreground.endpointLatency.count).toBe(0);
    } finally {
      provider.destroy();
      await server.stop();
    }
  });

  it('counts an endpoint answer other than 2xx as a failed attempt', async () => {
    const [{ createRpcRequestProvider }, { startLoopbackRpc }] = await Promise.all([
      import('../src/rpc-request-transport.js'),
      import('./loopback-rpc-harness.js'),
    ]);
    const rpc = await startLoopbackRpc({ throttle: ['eth_blockNumber'] });
    const provider = createRpcRequestProvider(rpc.url, { maxRetries: 0, providerOptions: { batchMaxCount: 1 } });
    try {
      await expect(provider.send('eth_blockNumber', [])).rejects.toBeDefined();
      const snapshot = snapshotRpcRequestTiming();
      expect(snapshot.foreground.endpointLatency.count).toBeGreaterThanOrEqual(1);
      expect(snapshot.foreground.endpointFailures).toBeGreaterThanOrEqual(1);
    } finally {
      provider.destroy();
      await rpc.close();
    }
  });
});
