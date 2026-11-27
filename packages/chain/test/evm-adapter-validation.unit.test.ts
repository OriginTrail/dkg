// SPDX-License-Identifier: Apache-2.0
/**
 * Static-network and configured chain-id validation through real adapter
 * construction and loopback RPC endpoints.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
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
  withRpcRequestContext,
} from '../src/rpc-request-transport.js';
import { RpcRequestGovernor } from '../src/rpc-request-governor.js';
import { createRpcTimeoutError } from '../src/chain-rpc-transport-error.js';
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

describe('EVM adapter endpoint validation', () => {
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

  it('STATIC NETWORK: one cancelled waiter cannot poison shared chain-id validation', async () => {
    let resolveChainId!: (value: string) => void;
    const physical = new Promise<string>((resolve) => { resolveChainId = resolve; });
    const provider = { send: vi.fn(() => physical) };
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapters.push(adapter);
    const firstController = new AbortController();
    const firstAbort = createRpcTimeoutError('first caller stopped waiting');

    const first = withRpcRequestContext(
      { signal: firstController.signal },
      () => adapter.ensureConfiguredStaticChainIdValidated(provider),
    );
    const second = adapter.ensureConfiguredStaticChainIdValidated(provider);
    firstController.abort(firstAbort);

    await expect(first).rejects.toBe(firstAbort);
    expect(provider.send).toHaveBeenCalledTimes(1);
    resolveChainId('0x7a69');
    await expect(second).resolves.toBe(31337n);
    await expect(adapter.ensureConfiguredStaticChainIdValidated(provider)).resolves.toBe(31337n);
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('STATIC NETWORK: chain-id validation preserves priority and does not block foreground behind background', async () => {
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 80,
      burstRequests: 10,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    let backgroundStarted!: () => void;
    let releaseBackground!: () => void;
    const backgroundDidStart = new Promise<void>((resolve) => { backgroundStarted = resolve; });
    const backgroundMayFinish = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const provider = {
      send: vi.fn(async () => {
        await governor.acquireActiveRequest();
        if (activeRpcRequestContext().requestClass === 'background') {
          backgroundStarted();
          await backgroundMayFinish;
        }
        return '0x7a69';
      }),
    };
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapters.push(adapter);

    const background = withRpcRequestContext(
      { requestClass: 'background' },
      () => adapter.ensureConfiguredStaticChainIdValidated(provider),
    );
    await backgroundDidStart;

    const foreground = withRpcRequestContext(
      { requestClass: 'foreground' },
      () => adapter.ensureConfiguredStaticChainIdValidated(provider),
    );
    await expect(foreground).resolves.toBe(31337n);
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(governor.snapshot()).toMatchObject({
      backgroundAdmitted: 1,
      foregroundAdmitted: 1,
    });

    releaseBackground();
    await expect(background).resolves.toBe(31337n);
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

});
