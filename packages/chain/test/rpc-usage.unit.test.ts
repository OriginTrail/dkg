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
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { boundedRpcMethodLabel, RpcUsageTracker } from '../src/rpc-usage.js';
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

    await expect(a.getEvmChainId()).resolves.toBe(31337n);
    await expect(a.getEvmChainId()).resolves.toBe(31337n);

    // Source of truth: the server's own per-method request log. The tracker's
    // window must EQUAL it — no over- or under-counting.
    const usage = a.drainRpcUsage();
    expect(usage.total).toBe(rpc.totalHits());
    expect(usage.total).toBeGreaterThanOrEqual(1); // guard against a 0==0 vacuous pass
    for (const [method, count] of Object.entries(usage.byMethod)) {
      expect(rpc.hits(method), `method ${method}`).toBe(count);
    }
    // ...and per-method the other way: every server-observed method was counted.
    // (The harness has no method-list accessor, so probe the ones this read issues.)
    expect(usage.byMethod['eth_chainId'] ?? 0).toBe(rpc.hits('eth_chainId'));

    // OTel counter: bounded labels only.
    const pts = await requestPoints();
    expect(pts.length).toBeGreaterThanOrEqual(1);
    const keys = new Set(pts.flatMap((p) => Object.keys(p)));
    expect([...keys].sort()).toEqual(['chain_id', 'rpc_method']);
    expect(pts.some((p) => p.rpc_method === 'eth_chainId' && p.chain_id === 'evm:31337')).toBe(true);

    // Drain semantics: deltas, not cumulative; lifetime monotonic.
    const drained = a.drainRpcUsage();
    expect(drained.total).toBe(0);
    expect(drained.lifetimeTotal).toBe(usage.lifetimeTotal);
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
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpc.url }));
    adapters.push(a);

    await expect(a.getEvmChainId()).rejects.toBeTruthy(); // perpetual 429 → bounded failure

    const usage = a.drainRpcUsage();
    expect(rpc.hits('eth_chainId')).toBeGreaterThanOrEqual(2); // initial + ≥1 retry actually happened
    expect(usage.byMethod['eth_chainId'] ?? 0).toBe(rpc.hits('eth_chainId'));
    expect(usage.total).toBe(rpc.totalHits());
  }, 30_000);

  it('bounds unknown methods to "other" for the metric label', () => {
    expect(boundedRpcMethodLabel('eth_getLogs')).toBe('eth_getLogs');
    expect(boundedRpcMethodLabel('eth_sendRawTransaction')).toBe('eth_sendRawTransaction');
    expect(boundedRpcMethodLabel('debug_traceTransaction')).toBe('other');
    expect(boundedRpcMethodLabel('weird method !!')).toBe('other');
  });

  it('tracker.record never throws; window keys stay RAW (log token-safety is the formatter concern)', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    expect(() => t.record('eth_call')).not.toThrow();
    expect(() => t.record('debug_traceTransaction')).not.toThrow(); // raw key preserved in window
    expect(() => t.record('')).not.toThrow(); // degenerate → 'other'
    expect(() => t.record('x'.repeat(500))).not.toThrow(); // oversized → 'other'
    const w = t.drainWindow();
    expect(w.total).toBe(4);
    expect(w.byMethod['eth_call']).toBe(1);
    expect(w.byMethod['debug_traceTransaction']).toBe(1); // NOT sanitized to 'other'
    expect(w.byMethod['other']).toBe(2);
  });
});
