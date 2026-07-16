// SPDX-License-Identifier: Apache-2.0
/**
 * R3 (PR #1317 review): the metric instrumentation must be proven through the
 * REAL instrumented code path, not by hand-emitting `getMetrics().xxx.add(...)`
 * with canned attributes. This drives the actual `readContractWith` adapter
 * delegator → `RpcFailoverClient.readContract` choke-point (the single seam
 * every contract VIEW read funnels through after the #1335 failover refactor
 * re-homed the telemetry into `RpcFailoverClient`) under an in-memory OTel meter
 * and asserts the
 * emitted `dkg.chain.rpc.total` carries ONLY the bounded low-cardinality label
 * set. It is the direct regression gate for the reviewer's example: "if
 * `chainRpcTotal.add(...)` were changed to include `{ rpc_url: this.rpcUrls[i] }`
 * this test would fail" — whereas the prior hand-written-sample test would not.
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

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB = '0x0000000000000000000000000000000000000001';

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    privateKey: DEPLOYER_PK,
    hubAddress: HUB,
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    staticNetwork: false,
    ...overrides,
  };
}

// A contract stub whose `.connect(runner)` returns itself, so `rebindContract`
// is a no-op and the read `fn` runs deterministically without a live provider.
function fakeContract(): any {
  const c: any = { connect: () => c };
  return c;
}

const ALLOWED_RPC_LABELS = new Set(['rpc_method', 'outcome', 'retryable', 'chain_id']);
const FORBIDDEN_LABELS = ['rpc_url', 'peer_id', 'tx_hash', 'operation_id', 'assertion_id', 'kaId'];

describe('chain RPC telemetry — real readContractWith emits bounded labels', () => {
  let mp: MeterProvider | null = null;
  let exporter: InMemoryMetricExporter;

  function installMeter(): void {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    mp = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics(); // rebind the core facade's instrument cache to the real meter
  }

  function chainRpcDataPoints(): Array<{ attrs: Record<string, unknown> }> {
    const out: Array<{ attrs: Record<string, unknown> }> = [];
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const metric of sm.metrics)
          if (metric.descriptor.name === 'dkg.chain.rpc.total')
            for (const dp of metric.dataPoints) out.push({ attrs: dp.attributes as Record<string, unknown> });
    return out;
  }

  afterEach(async () => {
    if (mp) {
      await mp.forceFlush().catch(() => {});
      await mp.shutdown().catch(() => {});
      mp = null;
    }
    metrics.disable();
    rebuildMetrics(); // back to the no-op meter for the next test/file
  });

  it('SUCCESS path: records outcome=ok with exactly {rpc_method,outcome,retryable,chain_id}', async () => {
    installMeter();
    const a: any = new EVMChainAdapter(minimalConfig());
    a.providers = [{}]; // one dummy provider — `fn` ignores it
    a.rpcUrls = ['http://loopback'];

    const out = await a.readContractWith(fakeContract(), 'token.allowance', () => 42n);
    expect(out).toBe(42n);

    await mp!.forceFlush();
    const pts = chainRpcDataPoints();
    expect(pts.length).toBeGreaterThanOrEqual(1);

    const keys = new Set(pts.flatMap((p) => Object.keys(p.attrs)));
    // Exactly the allow-listed labels — nothing high-cardinality leaked in.
    expect([...keys].filter((k) => !ALLOWED_RPC_LABELS.has(k))).toEqual([]);
    for (const bad of FORBIDDEN_LABELS) expect(keys.has(bad)).toBe(false);
    // Bounded VALUES on the success branch.
    expect(
      pts.some((p) => p.attrs.rpc_method === 'eth_call' && p.attrs.outcome === 'ok' && p.attrs.chain_id === 'evm:31337'),
    ).toBe(true);

    a.destroy?.();
  });

  it('ERROR path: records a non-ok outcome with the same bounded label set', async () => {
    installMeter();
    const a: any = new EVMChainAdapter(minimalConfig());
    a.providers = [{}];
    a.rpcUrls = ['http://loopback'];

    await expect(
      a.readContractWith(fakeContract(), 'token.allowance', () => {
        throw new Error('boom');
      }),
    ).rejects.toBeTruthy();

    await mp!.forceFlush();
    const pts = chainRpcDataPoints();
    expect(pts.length).toBeGreaterThanOrEqual(1);
    expect(pts.every((p) => p.attrs.outcome !== 'ok')).toBe(true);
    const keys = new Set(pts.flatMap((p) => Object.keys(p.attrs)));
    expect([...keys].filter((k) => !ALLOWED_RPC_LABELS.has(k))).toEqual([]);
    for (const bad of FORBIDDEN_LABELS) expect(keys.has(bad)).toBe(false);

    a.destroy?.();
  });

  // eth_getLogs page-scan branch (queryEventLogsPage) — its own outcome metric.
  function logScanContract(queryFilter: () => Promise<unknown[]>): any {
    const c: any = { connect: () => c, queryFilter };
    return c;
  }
  const scanProviders = [{ provider: {} as any, backendHead: 1_000 }];

  it('eth_getLogs SUCCESS: records dkg.chain.rpc.total{eth_getLogs, ok} bounded labels', async () => {
    installMeter();
    const a: any = new EVMChainAdapter(minimalConfig());
    const { logs } = await a.queryEventLogsPage(
      logScanContract(async () => []), {}, 0, 100, scanProviders, new Map(), 'unit getLogs',
    );
    expect(logs).toEqual([]);
    await mp!.forceFlush();
    const pts = chainRpcDataPoints().filter((p) => p.attrs.rpc_method === 'eth_getLogs');
    expect(pts.some((p) => p.attrs.outcome === 'ok' && p.attrs.chain_id === 'evm:31337')).toBe(true);
    const keys = new Set(pts.flatMap((p) => Object.keys(p.attrs)));
    expect([...keys].filter((k) => !ALLOWED_RPC_LABELS.has(k))).toEqual([]);
    for (const bad of FORBIDDEN_LABELS) expect(keys.has(bad)).toBe(false);
    a.destroy?.();
  });

  it('eth_getLogs FAILURE (all backends error): records a non-ok outcome', async () => {
    installMeter();
    const a: any = new EVMChainAdapter(minimalConfig());
    await expect(
      a.queryEventLogsPage(
        logScanContract(async () => { throw new Error('getLogs boom'); }),
        {}, 0, 100, scanProviders, new Map(), 'unit getLogs',
      ),
    ).rejects.toBeTruthy();
    await mp!.forceFlush();
    const pts = chainRpcDataPoints().filter((p) => p.attrs.rpc_method === 'eth_getLogs');
    expect(pts.length).toBeGreaterThanOrEqual(1);
    expect(pts.every((p) => p.attrs.outcome !== 'ok')).toBe(true);
    a.destroy?.();
  });
});
