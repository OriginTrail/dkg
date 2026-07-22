// SPDX-License-Identifier: Apache-2.0
/**
 * RPC usage accounting (the provider-billing view) — proven through the REAL
 * transport path with the loopback JSON-RPC server as the SOURCE OF TRUTH:
 * the tracker's counts must EQUAL the raw HTTP JSON-RPC requests the server
 * actually received, total and per method — including ethers' internal
 * 429-retry attempts, which happen below JsonRpcProvider._send and each bill
 * at the provider. Also asserts the OTel counter's bounded {rpc_method,
 * chain_id} labels, drain-resets-window semantics, and label bounding.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Contract } from 'ethers';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import {
  boundedRpcMethodLabel,
  mergeRpcUsageWindows,
  normalizeRpcUsageWindow,
  normalizeRpcUsageConsumer,
  rpcUsageWindowTotal,
  RpcUsageTracker,
  createCountingJsonRpcProvider,
  type RpcUsageDrainable,
  withRpcUsageConsumer,
} from '../src/rpc-usage.js';
import { withRpcRequestAbortSignal } from '../src/rpc-request-transport.js';
import { createRpcTimeoutError } from '../src/chain-rpc-transport-error.js';
import type { ChainAdapter } from '../src/chain-adapter.js';
import { startLoopbackRpc, type LoopbackRpc } from './loopback-rpc-harness.js';

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

describe('RPC usage accounting — raw request counts EQUAL the server-received requests', () => {
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

  async function requestPoints(): Promise<Array<Record<string, unknown>>> {
    await mp!.forceFlush();
    const out: Array<Record<string, unknown>> = [];
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          if (m.descriptor.name === 'dkg.chain.rpc.requests.total')
            for (const dp of m.dataPoints) out.push(dp.attributes as Record<string, unknown>);
    return out;
  }

  afterEach(async () => {
    for (const a of adapters.splice(0)) { try { a.destroy(); } catch { /* idempotent */ } }
    for (const s of servers.splice(0)) await s.close();
    if (mp) { await mp.forceFlush().catch(() => {}); await mp.shutdown().catch(() => {}); mp = null; }
    metrics.disable();
    rebuildMetrics();
  });

  it('EXACT: tracker total + per-method counts equal what the server received; drain resets', async () => {
    installMeter();
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpc.url }));
    adapters.push(a);

    await expect(a.getBlockNumber()).resolves.toBe(16);
    await expect(a.getBlockNumber()).resolves.toBe(16);

    // Source of truth: the server's own per-method request log. The tracker's
    // window must EQUAL it — no over- or under-counting.
    const usage = a.drainRpcUsage();
    expect(rpcUsageWindowTotal(usage)).toBe(rpc.totalHits());
    expect(rpcUsageWindowTotal(usage)).toBeGreaterThanOrEqual(1); // guard against a 0==0 vacuous pass
    for (const [method, count] of Object.entries(usage.byMethod)) {
      expect(rpc.hits(method), `method ${method}`).toBe(count);
    }
    // ...and per-method the other way: every server-observed method was counted.
    // (The harness has no method-list accessor, so probe the ones this read issues.)
    expect(usage.byMethod['eth_blockNumber'] ?? 0).toBe(rpc.hits('eth_blockNumber'));

    // OTel counter: bounded labels only.
    const pts = await requestPoints();
    expect(pts.length).toBeGreaterThanOrEqual(1);
    const keys = new Set(pts.flatMap((p) => Object.keys(p)));
    expect([...keys].sort()).toEqual(['chain_id', 'rpc_method']);
    expect(pts.some((p) => p.rpc_method === 'eth_blockNumber' && p.chain_id === 'evm:31337')).toBe(true);

    // Drain semantics: deltas, not cumulative; lifetime monotonic.
    const drained = a.drainRpcUsage();
    expect(rpcUsageWindowTotal(drained)).toBe(0);
    expect(drained.lifetimeTotal).toBe(usage.lifetimeTotal);
  });

  it('cancels the active ethers HTTP request when the caller aborts a chain read', async () => {
    const rpc = await startLoopbackRpc({ hang: ['eth_blockNumber'] });
    servers.push(rpc);
    const provider = createCountingJsonRpcProvider(
      rpc.url,
      0,
      new RpcUsageTracker(() => 'evm:31337'),
      { batchMaxCount: 1 },
    );
    const controller = new AbortController();
    const timeoutError = createRpcTimeoutError('authentication attempt timed out');

    const pending = withRpcRequestAbortSignal(
      controller.signal,
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

  it('STATIC NETWORK: getEvmChainId validates configured chain id once, then caches it', async () => {
    installMeter();
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpc.url }));
    adapters.push(a);

    await expect(a.getEvmChainId()).resolves.toBe(31337n);
    await expect(a.getEvmChainId()).resolves.toBe(31337n);

    const usage = a.drainRpcUsage();
    expect(rpc.hits('eth_chainId')).toBe(1);
    expect(usage.byMethod['eth_chainId']).toBe(1);
    expect(rpcUsageWindowTotal(usage)).toBe(1);
  });

  it('STATIC NETWORK: ordinary reads validate configured chain id once, then avoid steady eth_chainId calls', async () => {
    installMeter();
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpc.url, chainId: 'evm:31337' }));
    adapters.push(a);

    await expect(a.getBlockNumber()).resolves.toBe(16);
    await expect(a.getBlockNumber()).resolves.toBe(16);

    const usage = a.drainRpcUsage();
    expect(rpc.hits('eth_chainId')).toBe(1);
    expect(usage.byMethod['eth_chainId']).toBe(1);
    expect(usage.byMethod['eth_blockNumber']).toBe(rpc.hits('eth_blockNumber'));
    expect(rpcUsageWindowTotal(usage)).toBe(rpc.totalHits());
  });

  it('STATIC NETWORK: ordinary reads fail closed on configured/live chain-id mismatch', async () => {
    installMeter();
    const rpc = await startLoopbackRpc({ results: { eth_chainId: '0x14a34' } });
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpc.url, chainId: 'evm:31337' }));
    adapters.push(a);

    await expect(a.getBlockNumber()).rejects.toThrow(/Configured chainId 31337 does not match RPC chainId 84532/);

    const usage = a.drainRpcUsage();
    expect(rpc.hits('eth_chainId')).toBe(1);
    expect(rpc.hits('eth_blockNumber')).toBe(0);
    expect(usage.byMethod['eth_chainId']).toBe(1);
    expect(usage.byMethod['eth_blockNumber'] ?? 0).toBe(0);
  });

  it('STATIC NETWORK: event log scans fail closed before probing mismatched providers', async () => {
    installMeter();
    const rpc = await startLoopbackRpc({ results: { eth_chainId: '0x14a34' } });
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpc.url, chainId: 'evm:31337' }));
    adapters.push(a);

    await expect(a.resolveLogScanHead('unit log scan'))
      .rejects.toThrow(/Configured chainId 31337 does not match RPC chainId 84532/);

    const usage = a.drainRpcUsage();
    expect(rpc.hits('eth_chainId')).toBe(1);
    expect(rpc.hits('eth_blockNumber')).toBe(0);
    expect(usage.byMethod['eth_chainId']).toBe(1);
    expect(usage.byMethod['eth_blockNumber'] ?? 0).toBe(0);
  });

  it('STATIC NETWORK: failover validates a backup endpoint before it can serve reads', async () => {
    installMeter();
    const primary = await startLoopbackRpc({ throttle: ['eth_blockNumber'] });
    const backup = await startLoopbackRpc({ results: { eth_chainId: '0x14a34', eth_blockNumber: '0x20' } });
    servers.push(primary, backup);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: primary.url,
      rpcUrls: [backup.url],
      chainId: 'evm:31337',
    }));
    adapters.push(a);

    await expect(a.getBlockNumber()).rejects.toThrow(/Configured chainId 31337 does not match RPC chainId 84532/);

    const usage = a.drainRpcUsage();
    expect(primary.hits('eth_chainId')).toBe(1);
    expect(primary.hits('eth_blockNumber')).toBe(1);
    expect(backup.hits('eth_chainId')).toBe(1);
    expect(backup.hits('eth_blockNumber')).toBe(0);
    expect(usage.byMethod['eth_chainId']).toBe(2);
    expect(usage.byMethod['eth_blockNumber']).toBe(1);
    expect(rpcUsageWindowTotal(usage)).toBe(primary.totalHits() + backup.totalHits());
  });

  it('STATIC NETWORK: configured chain ids stay bigint-only above JS safe-integer range', async () => {
    installMeter();
    const rpc = await startLoopbackRpc({ results: { eth_chainId: '0x20000000000001' } });
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: rpc.url,
      chainId: 'evm:9007199254740993',
    }));
    adapters.push(a);

    await expect(a.getBlockNumber()).resolves.toBe(16);

    const usage = a.drainRpcUsage();
    expect(rpc.hits('eth_chainId')).toBe(1);
    expect(usage.byMethod['eth_chainId']).toBe(1);
    expect(usage.byMethod['eth_blockNumber']).toBe(rpc.hits('eth_blockNumber'));
  });

  it('STATIC NETWORK: getEvmChainId preserves configured bigint chain ids above JS safe-integer range', async () => {
    installMeter();
    const rpc = await startLoopbackRpc({ results: { eth_chainId: '0x20000000000001' } });
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: rpc.url,
      chainId: 'evm:9007199254740993',
    }));
    adapters.push(a);

    await expect(a.getEvmChainId()).resolves.toBe(9007199254740993n);

    const usage = a.drainRpcUsage();
    expect(rpc.hits('eth_chainId')).toBe(1);
    expect(usage.byMethod['eth_chainId']).toBe(1);
  });

  it('STATIC NETWORK: non-numeric chain labels fall back to dynamic detection for compatibility', async () => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: rpc.url,
      chainId: 'dynamic-test',
    }));
    adapters.push(a);

    await expect(a.getEvmChainId()).resolves.toBe(31337n);
    expect(rpc.hits('eth_chainId')).toBeGreaterThan(0);
  });

  it('STATIC NETWORK: getEvmChainId fails when configured chain id does not match the RPC', async () => {
    installMeter();
    const rpc = await startLoopbackRpc({ results: { eth_chainId: '0x14a34' } });
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpc.url, chainId: 'evm:31337' }));
    adapters.push(a);

    await expect(a.getEvmChainId()).rejects.toThrow(/Configured chainId 31337 does not match RPC chainId 84532/);

    const usage = a.drainRpcUsage();
    expect(usage.byMethod['eth_chainId']).toBe(rpc.hits('eth_chainId'));
    expect(rpcUsageWindowTotal(usage)).toBe(rpc.totalHits());
  });

  it('STATIC NETWORK: getEvmChainId still surfaces endpoint exhaustion during validation', async () => {
    installMeter();
    const rpcA = await startLoopbackRpc({ throttle: ['eth_chainId'] });
    const rpcB = await startLoopbackRpc({ throttle: ['eth_chainId'] });
    servers.push(rpcA, rpcB);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: rpcA.url,
      rpcUrls: [rpcA.url, rpcB.url],
      chainId: 'evm:31337',
    }));
    adapters.push(a);

    await expect(a.getEvmChainId()).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });

    const ethChainIdHits = rpcA.hits('eth_chainId') + rpcB.hits('eth_chainId');
    const totalHits = rpcA.totalHits() + rpcB.totalHits();
    const usage = a.drainRpcUsage();
    expect(ethChainIdHits).toBe(2);
    expect(usage.byMethod['eth_chainId'] ?? 0).toBe(ethChainIdHits);
    expect(rpcUsageWindowTotal(usage)).toBe(totalHits);
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
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpc.url, staticNetwork: false }));
    adapters.push(a);

    await expect(a.getEvmChainId()).rejects.toBeTruthy(); // perpetual 429 → bounded failure

    const usage = a.drainRpcUsage();
    expect(rpc.hits('eth_chainId')).toBeGreaterThanOrEqual(2); // initial + ≥1 retry actually happened
    expect(usage.byMethod['eth_chainId'] ?? 0).toBe(rpc.hits('eth_chainId'));
    expect(rpcUsageWindowTotal(usage)).toBe(rpc.totalHits());
  }, 30_000);

  it('bounds unknown methods to "other" for the metric label', () => {
    expect(boundedRpcMethodLabel('eth_getLogs')).toBe('eth_getLogs');
    expect(boundedRpcMethodLabel('eth_sendRawTransaction')).toBe('eth_sendRawTransaction');
    expect(boundedRpcMethodLabel('debug_traceTransaction')).toBe('other');
    expect(boundedRpcMethodLabel('weird method !!')).toBe('other');
  });

  it('MULTI-ENDPOINT FAILOVER: failed attempts on endpoint A and the fallback success on B both bill (tracker == A hits + B hits)', async () => {
    installMeter();
    // Endpoint A rate-limits eth_chainId (HTTP 429 — the request REACHED the
    // provider, so it bills); endpoint B is healthy. A multi-RPC adapter uses
    // perEndpointRetries = 0, so the failover client moves to B after A's
    // billed refusal. The drained window must equal the SUM of what both
    // servers actually received — the failed attempt and the fallback success
    // are each one billable raw request.
    const rpcA = await startLoopbackRpc({ throttle: ['eth_chainId'] });
    const rpcB = await startLoopbackRpc();
    servers.push(rpcA, rpcB);
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpcA.url, rpcUrls: [rpcA.url, rpcB.url], staticNetwork: false }));
    adapters.push(a);

    await expect(a.getEvmChainId()).resolves.toBe(31337n); // failover succeeds via B

    const usage = a.drainRpcUsage();
    expect(rpcA.hits('eth_chainId')).toBeGreaterThanOrEqual(1); // billed refusal happened
    expect(rpcB.hits('eth_chainId')).toBeGreaterThanOrEqual(1); // fallback success happened
    expect(usage.byMethod['eth_chainId'] ?? 0).toBe(rpcA.hits('eth_chainId') + rpcB.hits('eth_chainId'));
    expect(rpcUsageWindowTotal(usage)).toBe(rpcA.totalHits() + rpcB.totalHits());
  }, 30_000);

  it('caps distinct window keys at MAX_WINDOW_METHODS; overflow aggregates into "other", existing keys keep counting raw', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    const max = RpcUsageTracker.MAX_WINDOW_METHODS;
    for (let i = 0; i < max + 6; i++) t.record(`fabricated_${i}`);
    t.record('fabricated_0'); // existing key increments raw even after the cap
    const w = t.drainWindow();
    expect(Object.keys(w.byMethod).length).toBeLessThanOrEqual(max + 1); // raw keys + 'other'
    expect(w.byMethod['fabricated_0']).toBe(2);
    expect(w.byMethod['other']).toBe(6); // the 6 overflow names
    expect(rpcUsageWindowTotal(w)).toBe(max + 7);
  });

  it('mergeRpcUsageWindows sums per-method and lifetime across trackers', () => {
    const merged = mergeRpcUsageWindows(
      {
        byMethod: { eth_call: 5, eth_estimateGas: 2 },
        ethCallByConsumer: { 'pcaNFT.getAccountInfo': 2 },
        lifetimeTotal: 100,
      },
      {
        byMethod: { eth_call: 3, eth_sendRawTransaction: 4 },
        ethCallByConsumer: { 'pcaNFT.getAccountInfo': 1, 'token.balanceOf': 2 },
        lifetimeTotal: 50,
      },
    );
    expect(merged).toEqual({
      byMethod: { eth_call: 8, eth_estimateGas: 2, eth_sendRawTransaction: 4 },
      ethCallByConsumer: { 'pcaNFT.getAccountInfo': 3, 'token.balanceOf': 2 },
      lifetimeTotal: 150,
    });
  });

  it('mergeRpcUsageWindows skips undefined inputs; nothing to merge yields a concrete EMPTY window', () => {
    const w = { byMethod: { eth_call: 1 }, ethCallByConsumer: {}, lifetimeTotal: 1 };
    const legacy = { byMethod: { eth_call: 2 }, lifetimeTotal: 2 };
    const empty = { byMethod: {}, ethCallByConsumer: {}, lifetimeTotal: 0 };
    expect(mergeRpcUsageWindows(undefined, w, undefined)).toEqual(w);
    expect(mergeRpcUsageWindows(legacy)).toEqual({
      byMethod: { eth_call: 2 },
      ethCallByConsumer: {},
      lifetimeTotal: 2,
    });
    expect(normalizeRpcUsageWindow(legacy)).toEqual({
      byMethod: { eth_call: 2 },
      ethCallByConsumer: {},
      lifetimeTotal: 2,
    });
    expect(mergeRpcUsageWindows(undefined, undefined)).toEqual(empty);
    expect(mergeRpcUsageWindows()).toEqual(empty);
  });

  it('keeps legacy aggregate-only drain sources source-compatible at public boundaries', () => {
    const drainable: RpcUsageDrainable = {
      drainRpcUsage: () => ({ byMethod: { eth_call: 1 }, lifetimeTotal: 1 }),
    };
    const adapter = {
      drainRpcUsage: () => ({ byMethod: { eth_getLogs: 2 }, lifetimeTotal: 2 }),
    } satisfies Pick<ChainAdapter, 'drainRpcUsage'>;

    expect(mergeRpcUsageWindows(drainable.drainRpcUsage(), adapter.drainRpcUsage?.())).toEqual({
      byMethod: { eth_call: 1, eth_getLogs: 2 },
      ethCallByConsumer: {},
      lifetimeTotal: 3,
    });
  });

  it('tracker.record never throws; window keys stay RAW (log token-safety is the formatter concern)', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    expect(() => t.record('eth_call')).not.toThrow();
    expect(() => t.record('debug_traceTransaction')).not.toThrow(); // raw key preserved in window
    expect(() => t.record('')).not.toThrow(); // degenerate → 'other'
    expect(() => t.record('x'.repeat(500))).not.toThrow(); // oversized → 'other'
    const w = t.drainWindow();
    expect(rpcUsageWindowTotal(w)).toBe(4);
    expect(w.byMethod['eth_call']).toBe(1);
    expect(w.byMethod['debug_traceTransaction']).toBe(1); // NOT sanitized to 'other'
    expect(w.byMethod['other']).toBe(2);
  });

  it('attributes eth_call to the current bounded consumer without changing aggregate totals', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    withRpcUsageConsumer('pcaNFT.getAccountInfo', () => {
      t.record('eth_call');
      t.record('eth_call');
      t.record('eth_getLogs');
    });
    t.record('eth_call');

    const w = t.drainWindow();
    expect(w.byMethod).toEqual({ eth_call: 3, eth_getLogs: 1 });
    expect(w.ethCallByConsumer).toEqual({ 'pcaNFT.getAccountInfo': 2 });
    expect(rpcUsageWindowTotal(w)).toBe(4);
  });

  it('drains eth_call consumer attribution as a per-window delta', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    withRpcUsageConsumer('pcaNFT.getAccountInfo', () => t.record('eth_call'));

    const first = t.drainWindow();
    expect(first.byMethod).toEqual({ eth_call: 1 });
    expect(first.ethCallByConsumer).toEqual({ 'pcaNFT.getAccountInfo': 1 });
    expect(first.lifetimeTotal).toBe(1);

    t.record('eth_getLogs');
    const second = t.drainWindow();
    expect(second.byMethod).toEqual({ eth_getLogs: 1 });
    expect(second.ethCallByConsumer).toEqual({});
    expect(second.lifetimeTotal).toBe(2);

    const third = t.drainWindow();
    expect(third.byMethod).toEqual({});
    expect(third.ethCallByConsumer).toEqual({});
    expect(third.lifetimeTotal).toBe(2);
  });

  it('keeps overlapping async consumer scopes isolated', async () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    await Promise.all([
      withRpcUsageConsumer('cgStorage.getContextGraph', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        t.record('eth_call');
      }),
      withRpcUsageConsumer('pcaNFT.getAccountInfo', async () => {
        t.record('eth_call');
        await new Promise((resolve) => setTimeout(resolve, 1));
        t.record('eth_call');
      }),
    ]);

    const w = t.drainWindow();
    expect(w.byMethod).toEqual({ eth_call: 3 });
    expect(w.ethCallByConsumer).toEqual({
      'cgStorage.getContextGraph': 1,
      'pcaNFT.getAccountInfo': 2,
    });
  });

  it('normalizes and bounds consumer labels', () => {
    expect(normalizeRpcUsageConsumer(' Hub.getContractAddress(Token) ')).toBe('Hub.getContractAddress_Token');
    expect(normalizeRpcUsageConsumer('bad label/with=spaces')).toBe('bad_label_with_spaces');
    expect(normalizeRpcUsageConsumer('')).toBeUndefined();
    expect(normalizeRpcUsageConsumer('x'.repeat(65))).toBe('other');
  });

  it('caps distinct eth_call consumer keys and overflows to other', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    const max = RpcUsageTracker.MAX_WINDOW_CONSUMERS;
    for (let i = 0; i < max + 4; i++) {
      withRpcUsageConsumer(`consumer.${i}`, () => t.record('eth_call'));
    }
    withRpcUsageConsumer('consumer.0', () => t.record('eth_call'));

    const w = t.drainWindow();
    expect(Object.keys(w.ethCallByConsumer)).toHaveLength(max + 1);
    expect(w.ethCallByConsumer['consumer.0']).toBe(2);
    expect(w.ethCallByConsumer.other).toBe(4);
    expect(w.byMethod.eth_call).toBe(max + 5);
  });

  it('attributes failover eth_call attempts to the readProvider label', async () => {
    installMeter();
    const primary = await startLoopbackRpc({ throttle: ['eth_call'] });
    const backup = await startLoopbackRpc();
    servers.push(primary, backup);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: primary.url,
      rpcUrls: [primary.url, backup.url],
      chainId: 'evm:31337',
    }));
    adapters.push(a);

    await expect(
      a.readProvider('unit.eth_call', (p: any) => p.send('eth_call', [{ to: HUB, data: '0x' }, 'latest'])),
    ).resolves.toBeDefined();

    const usage = a.drainRpcUsage();
    const rawEthCallHits = primary.hits('eth_call') + backup.hits('eth_call');
    expect(rawEthCallHits).toBeGreaterThanOrEqual(2);
    expect(usage.byMethod.eth_call).toBe(rawEthCallHits);
    expect(usage.ethCallByConsumer['unit.eth_call']).toBe(rawEthCallHits);
  }, 30_000);

  it('uses an explicit rpcUsageConsumer key independent of the human read label', async () => {
    installMeter();
    const primary = await startLoopbackRpc({ throttle: ['eth_call'] });
    const backup = await startLoopbackRpc();
    servers.push(primary, backup);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: primary.url,
      rpcUrls: [primary.url, backup.url],
      chainId: 'evm:31337',
    }));
    adapters.push(a);

    await expect(
      a.readProvider(
        'human label with spaces can change',
        (p: any) => p.send('eth_call', [{ to: HUB, data: '0x' }, 'latest']),
        { rpcUsageConsumer: 'unit.eth_call.stable' },
      ),
    ).resolves.toBeDefined();

    const usage = a.drainRpcUsage();
    const rawEthCallHits = primary.hits('eth_call') + backup.hits('eth_call');
    expect(rawEthCallHits).toBeGreaterThanOrEqual(2);
    expect(usage.byMethod.eth_call).toBe(rawEthCallHits);
    expect(usage.ethCallByConsumer['unit.eth_call.stable']).toBe(rawEthCallHits);
    expect(usage.ethCallByConsumer.human_label_with_spaces_can_change).toBeUndefined();
  }, 30_000);

  it('attributes same-endpoint eth_call retry attempts to the readProvider label', async () => {
    installMeter();
    const rpc = await startLoopbackRpc({ throttle: ['eth_call'] });
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: rpc.url,
      chainId: 'evm:31337',
    }));
    adapters.push(a);

    await expect(
      a.readProvider('unit.eth_call.retry', (p: any) => p.send('eth_call', [{ to: HUB, data: '0x' }, 'latest'])),
    ).rejects.toBeTruthy();

    const usage = a.drainRpcUsage();
    const rawEthCallHits = rpc.hits('eth_call');
    expect(rawEthCallHits).toBeGreaterThanOrEqual(2);
    expect(usage.byMethod.eth_call).toBe(rawEthCallHits);
    expect(usage.ethCallByConsumer['unit.eth_call.retry']).toBe(rawEthCallHits);
  }, 30_000);

  it('attributes failover contract-view eth_call attempts to the readContract label', async () => {
    installMeter();
    const primary = await startLoopbackRpc({ throttle: ['eth_call'] });
    const backup = await startLoopbackRpc();
    servers.push(primary, backup);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: primary.url,
      rpcUrls: [backup.url],
      chainId: 'evm:31337',
    }));
    adapters.push(a);
    const contract = new Contract(HUB, ['function value() view returns (uint256)']);

    await expect(a.readContract(contract, 'unit.contract.value', 'value')).resolves.toBe(0n);

    const usage = a.drainRpcUsage();
    const rawEthCallHits = primary.hits('eth_call') + backup.hits('eth_call');
    expect(rawEthCallHits).toBeGreaterThanOrEqual(2);
    expect(usage.byMethod.eth_call).toBe(rawEthCallHits);
    expect(usage.ethCallByConsumer['unit.contract.value']).toBe(rawEthCallHits);
  }, 30_000);

  it('attributes readContractWith eth_call attempts through the real transport path', async () => {
    installMeter();
    const primary = await startLoopbackRpc({ throttle: ['eth_call'] });
    const backup = await startLoopbackRpc();
    servers.push(primary, backup);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: primary.url,
      rpcUrls: [backup.url],
      chainId: 'evm:31337',
    }));
    adapters.push(a);
    const contract = new Contract(HUB, ['function value() view returns (uint256)']);

    await expect(
      a.readContractWith(contract, 'unit.contract.with', (c: any) => c.value()),
    ).resolves.toBe(0n);

    const usage = a.drainRpcUsage();
    const rawEthCallHits = primary.hits('eth_call') + backup.hits('eth_call');
    expect(rawEthCallHits).toBeGreaterThanOrEqual(2);
    expect(usage.byMethod.eth_call).toBe(rawEthCallHits);
    expect(usage.ethCallByConsumer['unit.contract.with']).toBe(rawEthCallHits);
  }, 30_000);
});
