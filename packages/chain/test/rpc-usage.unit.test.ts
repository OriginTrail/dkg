// SPDX-License-Identifier: Apache-2.0
/**
 * RPC usage accounting (the provider-billing view) — proven through the REAL
 * transport path: an EVMChainAdapter over a live loopback JSON-RPC server, so
 * every counted request is an actual HTTP JSON-RPC request the node issued.
 * Asserts (a) `dkg.chain.rpc.requests.total` is emitted with EXACTLY the
 * bounded {rpc_method, chain_id} labels, (b) `_drainRpcUsage()` returns the
 * per-method delta window and resets it, (c) unknown methods bound to 'other'.
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

describe('RPC usage accounting — raw request counts through the real transport', () => {
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

  it('a real read issues raw requests → counter emitted with bounded labels + drain returns the delta', async () => {
    installMeter();
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpc.url }));
    adapters.push(a);

    await expect(a.getEvmChainId()).resolves.toBe(31337n);

    // (a) The OTel counter saw the raw transport requests.
    const pts = await requestPoints();
    expect(pts.length).toBeGreaterThanOrEqual(1);
    const keys = new Set(pts.flatMap((p) => Object.keys(p)));
    expect([...keys].sort()).toEqual(['chain_id', 'rpc_method']); // EXACTLY the bounded set
    expect(pts.some((p) => p.rpc_method === 'eth_chainId' && p.chain_id === 'evm:31337')).toBe(true);
    for (const bad of ['rpc_url', 'peer_id', 'tx_hash', 'operation_id']) expect(keys.has(bad)).toBe(false);

    // (b) The drain window carries the same requests, then resets.
    const usage = a._drainRpcUsage();
    expect(usage.total).toBeGreaterThanOrEqual(1);
    expect(usage.byMethod['eth_chainId'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(usage.lifetimeTotal).toBeGreaterThanOrEqual(usage.total);
    const drained = a._drainRpcUsage();
    expect(drained.total).toBe(0); // window reset — deltas, not cumulative
    expect(drained.lifetimeTotal).toBe(usage.lifetimeTotal); // lifetime is monotonic
  });

  it('bounds unknown methods to "other" for the metric label', () => {
    expect(boundedRpcMethodLabel('eth_getLogs')).toBe('eth_getLogs');
    expect(boundedRpcMethodLabel('eth_sendRawTransaction')).toBe('eth_sendRawTransaction');
    expect(boundedRpcMethodLabel('debug_traceTransaction')).toBe('other');
    expect(boundedRpcMethodLabel('weird method !!')).toBe('other');
  });

  it('tracker.record never throws even with a broken meter or odd input', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    expect(() => t.record('eth_call')).not.toThrow();
    expect(() => t.record('')).not.toThrow();
    expect(() => t.record('x'.repeat(500))).not.toThrow();
    const w = t.drainWindow();
    expect(w.total).toBe(3);
    // Unsafe method names are sanitized for the window keys too.
    expect(Object.keys(w.byMethod)).toContain('other');
  });
});
