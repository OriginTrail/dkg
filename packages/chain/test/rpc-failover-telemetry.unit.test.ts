// SPDX-License-Identifier: Apache-2.0
/**
 * Review coverage gap (PR #1317): the chain telemetry re-homed into
 * `RpcFailoverClient` instruments THREE independent branches — contract reads
 * (covered by chain-rpc-telemetry.unit.test.ts), transaction BROADCAST
 * (`chain.tx_submit` / eth_sendRawTransaction), and RECEIPT wait
 * (`chain.tx_wait` / eth_getTransactionReceipt). This drives the real broadcast
 * + getReceipt paths (success and all-endpoints-exhausted) through the actual
 * `RpcFailoverClient` under an in-memory meter, asserting bounded labels, the
 * exhaustion failover counter, and outcome correctness.
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
import { RpcFailoverClient } from '../src/rpc-failover-client.js';

const CHAIN = 'evm:31337';
const URLS = ['http://a', 'http://b'];
const ALLOWED = new Set(['rpc_method', 'outcome', 'retryable', 'chain_id']);
const FAILOVER_ALLOWED = new Set(['rpc_method', 'chain_id', 'reason']);
const FORBIDDEN = ['rpc_url', 'peer_id', 'tx_hash', 'operation_id'];

const retryable429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };

function mkClient(providers: any[]): RpcFailoverClient {
  return new RpcFailoverClient(
    () => providers.map((p, i) => ({ provider: p, rpcUrl: URLS[i] })),
    async () => ({ signedTx: '0xsigned', txHash: '0xhash' }),
    () => CHAIN,
  );
}

describe('RpcFailoverClient telemetry — write/receipt failover metrics', () => {
  let mp: MeterProvider | null = null;
  let exporter: InMemoryMetricExporter;

  function installMeter(): void {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    mp = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();
  }

  async function points(name: string): Promise<Array<Record<string, unknown>>> {
    await mp!.forceFlush();
    const out: Array<Record<string, unknown>> = [];
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          if (m.descriptor.name === name)
            for (const dp of m.dataPoints) out.push(dp.attributes as Record<string, unknown>);
    return out;
  }

  afterEach(async () => {
    if (mp) { await mp.forceFlush().catch(() => {}); await mp.shutdown().catch(() => {}); mp = null; }
    metrics.disable();
    rebuildMetrics();
  });

  it('broadcast SUCCESS → chainRpcTotal{eth_sendRawTransaction, outcome:ok} bounded labels', async () => {
    installMeter();
    await mkClient([{ broadcastTransaction: async () => ({}) }]).broadcast('0xsigned', '0xhash', 'unit write');
    const total = await points('dkg.chain.rpc.total');
    const send = total.filter((a) => a.rpc_method === 'eth_sendRawTransaction');
    expect(send.length).toBeGreaterThanOrEqual(1);
    expect(send.some((a) => a.outcome === 'ok')).toBe(true);
    const keys = new Set(total.flatMap((a) => Object.keys(a)));
    expect([...keys].filter((k) => !ALLOWED.has(k))).toEqual([]);
    for (const bad of FORBIDDEN) expect(keys.has(bad)).toBe(false);
  });

  it('broadcast ALL-ENDPOINTS-EXHAUSTED → chainRpcFailoverTotal{eth_sendRawTransaction, exhausted} + retryable total', async () => {
    installMeter();
    const client = mkClient([
      { broadcastTransaction: async () => { throw retryable429(); } },
      { broadcastTransaction: async () => { throw retryable429(); } },
    ]);
    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    const fo = await points('dkg.chain.rpc.failover.total');
    expect(fo.some((a) => a.rpc_method === 'eth_sendRawTransaction' && a.reason === 'exhausted' && a.chain_id === CHAIN)).toBe(true);
    expect([...new Set(fo.flatMap((a) => Object.keys(a)))].filter((k) => !FAILOVER_ALLOWED.has(k))).toEqual([]);
    const total = await points('dkg.chain.rpc.total');
    expect(total.some((a) => a.rpc_method === 'eth_sendRawTransaction' && a.outcome !== 'ok' && a.retryable === true)).toBe(true);
  });

  it('getReceipt SUCCESS → chainRpcTotal{eth_getTransactionReceipt, outcome:ok}', async () => {
    installMeter();
    const receipt = { status: 1 };
    const got = await mkClient([{ getTransactionReceipt: async () => receipt }]).getReceipt('0xhash');
    expect(got).toBe(receipt);
    const total = await points('dkg.chain.rpc.total');
    expect(total.some((a) => a.rpc_method === 'eth_getTransactionReceipt' && a.outcome === 'ok')).toBe(true);
  });

  it('getReceipt ALL-ENDPOINTS-EXHAUSTED → chainRpcFailoverTotal{eth_getTransactionReceipt, exhausted}', async () => {
    installMeter();
    const client = mkClient([
      { getTransactionReceipt: async () => { throw retryable429(); } },
      { getTransactionReceipt: async () => { throw retryable429(); } },
    ]);
    await expect(client.getReceipt('0xhash')).rejects.toBeTruthy();
    const fo = await points('dkg.chain.rpc.failover.total');
    expect(fo.some((a) => a.rpc_method === 'eth_getTransactionReceipt' && a.reason === 'exhausted')).toBe(true);
  });
});
