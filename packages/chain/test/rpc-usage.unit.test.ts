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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Contract } from 'ethers';
import * as ts from 'typescript';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { MockChainAdapter } from '../src/mock-adapter.js';
import {
  boundedRpcEndpointSlotLabel,
  boundedRpcMethodLabel,
  boundedRpcUsageSnapshotConsumerLabel,
  mergeRpcUsageWindows,
  normalizeRpcEndpointSlotLabel,
  normalizeRpcUsageWindow,
  normalizeRpcUsageConsumer,
  RPC_ENDPOINT_SLOT_LABELS,
  RPC_USAGE_SNAPSHOT_CONSUMERS,
  RPC_USAGE_SNAPSHOT_CONSUMER_VOCABULARY_VERSION,
  rpcUsageWindowTotal,
  RpcUsageCumulativeAccumulator,
  RpcUsageTracker,
  type RpcUsageDrainable,
  withRpcUsageConsumer,
  withRpcUsageAdapterRole,
  withRpcUsageSite,
} from '../src/rpc-usage.js';
import {
  CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER,
  CONTEXT_GRAPH_AUTHORITY_RPC_SITES,
} from
  '../src/context-graph-authority-rpc-sites.js';
import { createRpcRequestProvider } from '../src/rpc-request-transport.js';
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
      attributions: [
        { method: 'eth_call', consumer: 'pcaNFT.getAccountInfo', count: 3 },
        { method: 'eth_call', consumer: 'token.balanceOf', count: 2 },
      ],
      lifetimeTotal: 150,
    });
  });

  it('mergeRpcUsageWindows skips undefined inputs; nothing to merge yields a concrete EMPTY window', () => {
    const w = {
      byMethod: { eth_call: 1 },
      ethCallByConsumer: {},
      ethGetLogsByConsumerAndEndpointSlot: {},
      lifetimeTotal: 1,
    };
    const legacy = { byMethod: { eth_call: 2 }, lifetimeTotal: 2 };
    const empty = {
      byMethod: {},
      ethCallByConsumer: {},
      attributions: [],
      lifetimeTotal: 0,
    };
    expect(mergeRpcUsageWindows(undefined, w, undefined)).toEqual({
      byMethod: { eth_call: 1 },
      ethCallByConsumer: {},
      attributions: [],
      lifetimeTotal: 1,
    });
    expect(mergeRpcUsageWindows(legacy)).toEqual({
      byMethod: { eth_call: 2 },
      ethCallByConsumer: {},
      attributions: [],
      lifetimeTotal: 2,
    });
    expect(normalizeRpcUsageWindow(legacy)).toEqual({
      byMethod: { eth_call: 2 },
      ethCallByConsumer: {},
      attributions: [],
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
      attributions: [],
      lifetimeTotal: 3,
    });
  });

  it('normalizes canonical attribution arrays and drops malformed external entries', () => {
    const normalized = normalizeRpcUsageWindow({
      byMethod: { eth_call: 2, eth_getLogs: 2 },
      attributions: [
        { method: 'eth_call', consumer: 'token.balanceOf', count: 2 },
        {
          method: 'eth_getLogs',
          consumer: 'cg.authority.history',
          endpointSlot: 'fallback_1',
          count: 1,
        },
        {
          method: 'eth_getLogs',
          consumer: 'cg.authority.history',
          endpointSlot: 'https://secret.example/rpc',
          count: 1,
        },
        null,
        [],
        { method: 'eth_call', consumer: 7, count: 1 },
        { method: 'eth_call', consumer: 'invalid-count', count: '1' },
        { method: 'net_version', consumer: 'unsupported', count: 1 },
      ],
      lifetimeTotal: 4,
    } as unknown as Parameters<typeof normalizeRpcUsageWindow>[0]);

    expect(normalized).toEqual({
      byMethod: { eth_call: 2, eth_getLogs: 2 },
      ethCallByConsumer: { 'token.balanceOf': 2 },
      attributions: [
        { method: 'eth_call', consumer: 'token.balanceOf', count: 2 },
        {
          method: 'eth_getLogs',
          consumer: 'cg.authority.history',
          endpointSlot: 'fallback_1',
          count: 1,
        },
        {
          method: 'eth_getLogs',
          consumer: 'cg.authority.history',
          endpointSlot: 'other',
          count: 1,
        },
      ],
      lifetimeTotal: 4,
    });
  });

  it('returns a concrete empty RPC usage window from the mock adapter', () => {
    expect(new MockChainAdapter().drainRpcUsage()).toEqual({
      byMethod: {},
      ethCallByConsumer: {},
      attributions: [],
      lifetimeTotal: 0,
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

  it('non-draining cumulative snapshots remain stable across repeated snapshots and drains', () => {
    const cumulative = new RpcUsageCumulativeAccumulator('epoch-fixed');
    const t = new RpcUsageTracker(() => 'evm:31337', 'main_agent', cumulative);
    withRpcUsageConsumer('chainIndex.head', () => t.record('eth_getBlockByNumber'));
    t.record('eth_call');

    const clock = {
      utcNow: () => new Date('2026-09-20T12:00:00.000Z'),
      monotonicNowMs: () => 123,
    };
    const beforeDrain = cumulative.snapshot(clock);
    const repeated = cumulative.snapshot(clock);
    expect(repeated).toEqual(beforeDrain);
    expect(t.drainWindow().byMethod).toEqual({ eth_getBlockByNumber: 1, eth_call: 1 });
    expect(cumulative.snapshot(clock)).toEqual(beforeDrain);
    expect(t.drainWindow().byMethod).toEqual({});
    expect(cumulative.snapshot(clock)).toEqual(beforeDrain);
    expect(beforeDrain).toEqual({
      schemaVersion: 1,
      consumerVocabularyVersion: 1,
      processEpoch: 'epoch-fixed',
      capturedAtUtc: '2026-09-20T12:00:00.000Z',
      capturedAtMonotonicMs: 123,
      completeness: {
        complete: true,
        reasons: [],
        populationEpoch: 1,
        sources: {
          mainAgent: { status: 'included', totalRegisteredTrackers: 1, totalsRetained: true },
          publisherWallets: { status: 'included', totalRegisteredTrackers: 0, totalsRetained: true },
          routeRuntimes: { status: 'included', totalRegisteredTrackers: 0, totalsRetained: true },
          other: { status: 'included', totalRegisteredTrackers: 0, totalsRetained: true },
        },
      },
      cumulative: {
        methods: { eth_getBlockByNumber: 1, eth_call: 1 },
        consumers: {
          eth_getBlockByNumber: { 'chainIndex.head': 1 },
          eth_call: { unattributed: 1 },
        },
        adapterRoles: {
          eth_getBlockByNumber: { main_agent: 1 },
          eth_call: { main_agent: 1 },
        },
      },
    });
    expect(Object.isFrozen(beforeDrain)).toBe(true);
    expect(Object.isFrozen(beforeDrain.cumulative.methods)).toBe(true);
    expect(Object.isFrozen(beforeDrain.cumulative.consumers.eth_call)).toBe(true);
  });

  it('retains retired tracker attempts and separates bounded adapter roles exactly once', () => {
    const cumulative = new RpcUsageCumulativeAccumulator('epoch-lifecycle');
    const retired = new RpcUsageTracker(() => 'evm:31337', 'publisher_wallet', cumulative);
    retired.record('eth_call');
    retired.record('eth_getBlockByHash');
    retired.drainWindow();

    const replacement = new RpcUsageTracker(() => 'evm:31337', 'publisher_wallet', cumulative);
    replacement.record('eth_call');
    const route = new RpcUsageTracker(() => 'evm:31337', 'route_runtime', cumulative);
    route.record('eth_blockNumber');

    const snapshot = cumulative.snapshot();
    expect(snapshot.completeness).toMatchObject({
      populationEpoch: 3,
      sources: {
        mainAgent: { totalRegisteredTrackers: 0 },
        publisherWallets: { totalRegisteredTrackers: 2 },
        routeRuntimes: { totalRegisteredTrackers: 1 },
        other: { totalRegisteredTrackers: 0 },
      },
    });
    expect(Object.values(snapshot.completeness.sources)
      .reduce((sum, source) => sum + source.totalRegisteredTrackers, 0))
      .toBe(snapshot.completeness.populationEpoch);
    expect(snapshot.cumulative.methods).toEqual({
      eth_call: 2,
      eth_getBlockByHash: 1,
      eth_blockNumber: 1,
    });
    expect(snapshot.cumulative.adapterRoles).toEqual({
      eth_call: { publisher_wallet: 2 },
      eth_getBlockByHash: { publisher_wallet: 1 },
      eth_blockNumber: { route_runtime: 1 },
    });
    for (const [method, total] of Object.entries(snapshot.cumulative.methods)) {
      expect(Object.values(snapshot.cumulative.consumers[method] ?? {})
        .reduce((sum, count) => sum + count, 0)).toBe(total);
      expect(Object.values(snapshot.cumulative.adapterRoles[method] ?? {})
        .reduce((sum, count) => sum + count, 0)).toBe(total);
    }
  });

  it('detects process replacement and collapses every unknown consumer into one bucket', () => {
    const first = new RpcUsageCumulativeAccumulator('epoch-a');
    const restarted = new RpcUsageCumulativeAccumulator('epoch-b');
    expect(first.snapshot().processEpoch).not.toBe(restarted.snapshot().processEpoch);

    const t = new RpcUsageTracker(() => 'evm:31337', 'main_agent', first);
    for (let i = 0; i < RpcUsageCumulativeAccumulator.MAX_CONSUMERS_PER_METHOD + 5; i += 1) {
      withRpcUsageConsumer(`consumer.${i}`, () => t.record('eth_getBlockByNumber'));
      t.drainWindow();
    }
    const consumers = first.snapshot().cumulative.consumers.eth_getBlockByNumber;
    expect(consumers).toEqual({
      other: RpcUsageCumulativeAccumulator.MAX_CONSUMERS_PER_METHOD + 5,
    });
  });

  it('captures a construction role once and never carries arbitrary role labels', () => {
    const cumulative = new RpcUsageCumulativeAccumulator('epoch-role');
    const publisher = withRpcUsageAdapterRole(
      'publisher_wallet',
      () => new RpcUsageTracker(() => 'evm:31337', undefined, cumulative),
    );
    publisher.record('eth_call');
    const unknown = new RpcUsageTracker(
      () => 'evm:31337',
      'secret-wallet-address' as never,
      cumulative,
    );
    unknown.record('eth_call');
    expect(cumulative.snapshot().cumulative.adapterRoles.eth_call).toEqual({
      publisher_wallet: 1,
      other: 1,
    });
  });

  it('retains only the frozen code-owned snapshot consumer vocabulary', () => {
    expect(RPC_USAGE_SNAPSHOT_CONSUMER_VOCABULARY_VERSION).toBe(1);
    expect(Object.isFrozen(RPC_USAGE_SNAPSHOT_CONSUMERS)).toBe(true);
    expect(RPC_USAGE_SNAPSHOT_CONSUMERS).toHaveLength(163);
    expect(RPC_USAGE_SNAPSHOT_CONSUMERS).toEqual(
      [...new Set(RPC_USAGE_SNAPSHOT_CONSUMERS)].sort(),
    );
    for (const consumer of RPC_USAGE_SNAPSHOT_CONSUMERS) {
      expect(boundedRpcUsageSnapshotConsumerLabel(consumer)).toBe(consumer);
    }
    for (const site of Object.values(CONTEXT_GRAPH_AUTHORITY_RPC_SITES)) {
      const composed = `${CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER}:${site}`;
      expect(boundedRpcUsageSnapshotConsumerLabel(composed)).toBe(composed);
    }
    for (const [raw, normalized] of [
      ['getNetwork (chainId)', 'getNetwork_chainId'],
      ['Hub.getContractAddress(Identity)', 'Hub.getContractAddress_Identity'],
      ['kas.queryFilter(KnowledgeAssetCreated)', 'kas.queryFilter_KnowledgeAssetCreated'],
    ] as const) {
      expect(boundedRpcUsageSnapshotConsumerLabel(raw)).toBe(normalized);
    }
  });

  it('retains every KA version snapshot header consumer literal', () => {
    const source = readFileSync(fileURLToPath(
      new URL('../src/evm-adapter-storage-reads.ts', import.meta.url),
    ), 'utf8');
    const start = source.indexOf('async readKnowledgeAssetVersionSnapshot(');
    const end = source.indexOf('async getMerkleLeafCount(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const consumers = [...source.slice(start, end).matchAll(
      /withRpcUsageConsumer\(\s*['"]([^'"]+)['"]/g,
    )].map((match) => match[1]!);
    expect(consumers).toEqual(['getBlock', 'getBlock', 'getBlock', 'getBlock']);
    for (const consumer of consumers) {
      expect(boundedRpcUsageSnapshotConsumerLabel(consumer)).toBe(consumer);
      expect(consumer).not.toBe('other');
    }
  });

  it('covers every active static resolveContract Hub label from source', () => {
    const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const visitDirectory = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name !== 'archive') visitDirectory(join(directory, entry.name));
        } else if (entry.name.endsWith('.ts')) {
          files.push(join(directory, entry.name));
        }
      }
    };
    visitDirectory(sourceRoot);

    const contractNames = new Set<string>();
    for (const path of files) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visitNode = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'resolveContract'
          && ts.isStringLiteralLike(node.arguments[0])
        ) {
          contractNames.add(node.arguments[0].text);
        }
        ts.forEachChild(node, visitNode);
      };
      visitNode(source);
    }

    expect([...contractNames].sort()).toEqual(expect.arrayContaining([
      'DKGStakingConvictionNFT',
      'ShardingTableStorage',
      'PublishingConviction',
      'ShardingTable',
    ]));
    for (const name of contractNames) {
      const raw = `Hub.getContractAddress(${name})`;
      const normalized = normalizeRpcUsageConsumer(raw);
      expect(normalized).toBeDefined();
      expect(RPC_USAGE_SNAPSHOT_CONSUMERS).toContain(normalized);
      expect(boundedRpcUsageSnapshotConsumerLabel(raw)).toBe(normalized);
    }
  });

  it('maps credentials and every unknown arbitrary identifier to other before storage', () => {
    const cumulative = new RpcUsageCumulativeAccumulator('epoch-private');
    const tracker = new RpcUsageTracker(() => 'evm:31337', 'main_agent', cumulative);
    const unsafeConsumers = [
      'Bearer fixture-secret-token',
      `wallet.0x${'ab'.repeat(20)}`,
      'request.01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'request.cuidclh0am13x0000w5a0k2q4g',
      'request.4ER7u3vQ',
      'graph.customer-private',
      'query.select_name_from_graph',
    ];
    for (const consumer of unsafeConsumers) {
      withRpcUsageConsumer(consumer, () => tracker.record('eth_call'));
    }
    const legitimateConsumers = [
      'listContextGraphsFromChain',
      'authorityProjection.validateAnchor',
      'token.balanceOf',
      'pcaNFT.getAccountInfo',
      'Hub.getContractAddress(Identity)',
      'eventLogPageScan',
    ];
    for (const consumer of legitimateConsumers) {
      expect(boundedRpcUsageSnapshotConsumerLabel(consumer)).toBe(
        normalizeRpcUsageConsumer(consumer),
      );
      withRpcUsageConsumer(consumer, () => tracker.record('eth_call'));
    }

    const snapshot = cumulative.snapshot();
    expect(snapshot.cumulative.methods.eth_call).toBe(
      unsafeConsumers.length + legitimateConsumers.length,
    );
    expect(snapshot.cumulative.consumers.eth_call).toEqual({
      other: unsafeConsumers.length,
      listContextGraphsFromChain: 1,
      'authorityProjection.validateAnchor': 1,
      'token.balanceOf': 1,
      'pcaNFT.getAccountInfo': 1,
      'Hub.getContractAddress_Identity': 1,
      eventLogPageScan: 1,
    });
    const serialized = JSON.stringify(snapshot).toLowerCase();
    for (const fragment of [
      'fixture-secret-token',
      '01arz3nd',
      'cuidclh0',
      'customer-private',
      'select_name_from_graph',
    ]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it('attributes every header request with an explicit unattributed remainder', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    withRpcUsageConsumer('chainIndex.head', () => {
      t.record('eth_blockNumber');
      t.record('eth_getBlockByNumber');
    });
    t.record('eth_getBlockByNumber');
    t.record('eth_getBlockByHash');

    const usage = t.drainWindow();
    expect(usage.attributions).toEqual([
      { method: 'eth_blockNumber', consumer: 'chainIndex.head', count: 1 },
      { method: 'eth_getBlockByNumber', consumer: 'chainIndex.head', count: 1 },
      { method: 'eth_getBlockByNumber', consumer: 'unattributed', count: 1 },
      { method: 'eth_getBlockByHash', consumer: 'unattributed', count: 1 },
    ]);
    for (const method of ['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash']) {
      expect(usage.attributions
        .filter((entry) => entry.method === method)
        .reduce((sum, entry) => sum + entry.count, 0)).toBe(usage.byMethod[method]);
    }
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
      withRpcUsageConsumer(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER, async () => {
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
      [CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER]: 1,
      'pcaNFT.getAccountInfo': 2,
    });
  });

  it('splits one funnel read label by the call site that wanted it', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    // The transport establishes the read label INNERMOST, exactly as
    // rpc-failover-client does, so this is the real nesting order.
    withRpcUsageSite('cgAuth.syncAuthz', () => {
      withRpcUsageConsumer(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER, () => t.record('eth_call'));
    });
    withRpcUsageSite('cgAuth.curatedProbe', () => {
      withRpcUsageConsumer(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER, () => t.record('eth_call'));
      withRpcUsageConsumer(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER, () => t.record('eth_call'));
    });
    // No site in scope: the bare read label is preserved, unchanged.
    withRpcUsageConsumer(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER, () => t.record('eth_call'));

    const w = t.drainWindow();
    expect(w.byMethod).toEqual({ eth_call: 4 });
    expect(w.ethCallByConsumer).toEqual({
      [`${CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER}:cgAuth.syncAuthz`]: 1,
      [`${CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER}:cgAuth.curatedProbe`]: 2,
      [CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER]: 1,
    });
  });

  it('keeps the authority site vocabulary unique, normalized and composable', () => {
    const sites = Object.values(CONTEXT_GRAPH_AUTHORITY_RPC_SITES);
    expect(new Set(sites).size).toBe(sites.length);
    for (const site of sites) {
      expect(normalizeRpcUsageConsumer(site)).toBe(site);
      expect(`${CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER}:${site}`.length).toBeLessThanOrEqual(64);
    }
  });

  it('does not append an authority site to unrelated eth_call consumers', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    withRpcUsageSite('cgAuth.syncAuthz', () => {
      withRpcUsageConsumer('pcaNFT.getAccountInfo', () => t.record('eth_call'));
    });
    expect(t.drainWindow().ethCallByConsumer).toEqual({
      'pcaNFT.getAccountInfo': 1,
    });
  });

  it('keeps the OUTERMOST call site: a funnel entry never overwrites its caller', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    withRpcUsageSite('cgAuth.syncAuthz', () => {
      // The funnel entry labels itself too; the caller above must win.
      withRpcUsageSite('cgAuth.gate', () => {
        withRpcUsageConsumer(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER, () => t.record('eth_call'));
      });
    });
    // Unlabelled caller: the funnel entry's own label is what gets reported.
    withRpcUsageSite('cgAuth.gate', () => {
      withRpcUsageConsumer(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER, () => t.record('eth_call'));
    });

    expect(t.drainWindow().ethCallByConsumer).toEqual({
      [`${CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER}:cgAuth.syncAuthz`]: 1,
      [`${CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER}:cgAuth.gate`]: 1,
    });
  });

  it('keeps composed consumer keys inside the logfmt token bound', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    withRpcUsageSite('x'.repeat(60), () => {
      withRpcUsageConsumer(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER, () => t.record('eth_call'));
    });
    // Degrading to the bare read label keeps the read attributed; composing
    // past 64 chars would be rewritten to `other` by the daemon formatter.
    expect(t.drainWindow().ethCallByConsumer).toEqual({
      [CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER]: 1,
    });
  });

  it('keeps overlapping async call sites isolated', async () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    await Promise.all([
      withRpcUsageSite('cgAuth.vmReconcile', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        withRpcUsageConsumer(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER, () => t.record('eth_call'));
      }),
      withRpcUsageSite('cgAuth.recipients', async () => {
        withRpcUsageConsumer(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER, () => t.record('eth_call'));
      }),
    ]);

    expect(t.drainWindow().ethCallByConsumer).toEqual({
      [`${CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER}:cgAuth.vmReconcile`]: 1,
      [`${CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER}:cgAuth.recipients`]: 1,
    });
  });

  it('does not relabel unrelated eth_getLogs inside an authority site scope', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    withRpcUsageSite('cgAuth.rfc64Roster', () => {
      withRpcUsageConsumer('cg.authority.history', () => t.record('eth_getLogs', 0));
    });
    expect(t.drainWindow().attributions).toEqual([{
      method: 'eth_getLogs',
      consumer: 'cg.authority.history',
      endpointSlot: 'primary',
      count: 1,
    }]);
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

  it('bounds configured endpoint slots without exposing endpoint identity', () => {
    for (const [slot, label] of RPC_ENDPOINT_SLOT_LABELS.entries()) {
      expect(boundedRpcEndpointSlotLabel(slot)).toBe(label);
      expect(normalizeRpcEndpointSlotLabel(label)).toBe(label);
    }
    expect(boundedRpcEndpointSlotLabel(RPC_ENDPOINT_SLOT_LABELS.length)).toBe('other');
    expect(boundedRpcEndpointSlotLabel(-1)).toBe('other');
    expect(boundedRpcEndpointSlotLabel(undefined)).toBe('other');
    expect(boundedRpcEndpointSlotLabel(Number.NaN)).toBe('other');
    expect(normalizeRpcEndpointSlotLabel('fallback_16')).toBe('other');
    expect(normalizeRpcEndpointSlotLabel('https://secret.example/rpc')).toBe('other');
  });

  it('attributes every eth_getLogs request, including unscoped calls, without changing the aggregate', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    withRpcUsageConsumer('cg.authority.history', () => {
      t.record('eth_getLogs', 0);
      t.record('eth_getLogs', 1);
    });
    t.record('eth_getLogs', 0);

    const w = t.drainWindow();
    expect(w.byMethod.eth_getLogs).toBe(3);
    expect(w.attributions).toEqual([
      { method: 'eth_getLogs', consumer: 'cg.authority.history', endpointSlot: 'primary', count: 1 },
      { method: 'eth_getLogs', consumer: 'cg.authority.history', endpointSlot: 'fallback_1', count: 1 },
      { method: 'eth_getLogs', consumer: 'unattributed', endpointSlot: 'primary', count: 1 },
    ]);
    expect(w.attributions.reduce((sum, attribution) => sum + attribution.count, 0))
      .toBe(w.byMethod.eth_getLogs);
    expect(t.drainWindow().attributions).toEqual([]);
  });

  it('caps distinct eth_getLogs consumer/slot pairs and reconciles overflow to other/other', () => {
    const t = new RpcUsageTracker(() => 'evm:31337');
    const max = RpcUsageTracker.MAX_WINDOW_GET_LOGS_ATTRIBUTIONS;
    for (let i = 0; i < max + 4; i += 1) {
      withRpcUsageConsumer(`consumer.${i}`, () => t.record('eth_getLogs', i % 2));
    }
    withRpcUsageConsumer('consumer.0', () => t.record('eth_getLogs', 0));

    const w = t.drainWindow();
    expect(w.attributions).toHaveLength(max + 1);
    expect(w.attributions).toContainEqual({
      method: 'eth_getLogs', consumer: 'consumer.0', endpointSlot: 'primary', count: 2,
    });
    expect(w.attributions).toContainEqual({
      method: 'eth_getLogs', consumer: 'other', endpointSlot: 'other', count: 4,
    });
    expect(w.attributions.reduce((sum, attribution) => sum + attribution.count, 0))
      .toBe(max + 5);
    expect(w.byMethod.eth_getLogs).toBe(max + 5);
  });

  it('merges eth_getLogs attribution by consumer and endpoint slot', () => {
    expect(mergeRpcUsageWindows(
      {
        byMethod: { eth_getLogs: 3 },
        ethGetLogsByConsumerAndEndpointSlot: {
          'cg.authority.history': { primary: 2, fallback_1: 1 },
        },
        lifetimeTotal: 3,
      },
      {
        byMethod: { eth_getLogs: 4 },
        ethGetLogsByConsumerAndEndpointSlot: {
          'cg.authority.history': { primary: 1 },
          'cg.subscription.events': { fallback_1: 3 },
        },
        lifetimeTotal: 4,
      },
    )).toEqual({
      byMethod: { eth_getLogs: 7 },
      ethCallByConsumer: {},
      attributions: [
        { method: 'eth_getLogs', consumer: 'cg.authority.history', endpointSlot: 'primary', count: 3 },
        { method: 'eth_getLogs', consumer: 'cg.authority.history', endpointSlot: 'fallback_1', count: 1 },
        { method: 'eth_getLogs', consumer: 'cg.subscription.events', endpointSlot: 'fallback_1', count: 3 },
      ],
      lifetimeTotal: 7,
    });
  });

  it('attributes failover eth_getLogs attempts to fixed configured endpoint slots', async () => {
    installMeter();
    const primary = await startLoopbackRpc({ throttle: ['eth_getLogs'] });
    const backup = await startLoopbackRpc();
    servers.push(primary, backup);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: primary.url,
      rpcUrls: [backup.url],
      chainId: 'evm:31337',
    }));
    adapters.push(a);

    await expect(a.readProvider(
      'unit.getLogs.failover',
      (provider: any) => provider.send('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1' }]),
      { policy: 'wideLogScan' },
    )).resolves.toBeDefined();

    const usage = a.drainRpcUsage();
    const primaryHits = primary.hits('eth_getLogs');
    const backupHits = backup.hits('eth_getLogs');
    expect(primaryHits).toBe(1);
    expect(backupHits).toBe(1);
    expect(usage.byMethod.eth_getLogs).toBe(primaryHits + backupHits);
    expect(usage.attributions).toEqual([
      { method: 'eth_getLogs', consumer: 'unit.getLogs.failover', endpointSlot: 'primary', count: primaryHits },
      { method: 'eth_getLogs', consumer: 'unit.getLogs.failover', endpointSlot: 'fallback_1', count: backupHits },
    ]);
    expect(JSON.stringify(usage.attributions))
      .not.toContain(primary.url);
    expect(JSON.stringify(usage.attributions))
      .not.toContain(backup.url);
  }, 30_000);

  it('attributes ethers-internal eth_getLogs retries to the same endpoint slot', async () => {
    const rpc = await startLoopbackRpc({ throttle: ['eth_getLogs'] });
    servers.push(rpc);
    const cumulative = new RpcUsageCumulativeAccumulator('epoch-retry');
    const tracker = new RpcUsageTracker(() => 'evm:31337', 'main_agent', cumulative);
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 1,
      providerOptions: { batchMaxCount: 1 },
      endpointSlot: 3,
      onRequest: (method, slot) => tracker.record(method, slot),
    });

    try {
      await expect(withRpcUsageConsumer(
        'eventLogPageScan',
        () => provider.send('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1' }]),
      )).rejects.toBeTruthy();

      const usage = tracker.drainWindow();
      const hits = rpc.hits('eth_getLogs');
      expect(hits).toBe(2);
      expect(usage.byMethod.eth_getLogs).toBe(hits);
      expect(usage.attributions).toEqual([
        { method: 'eth_getLogs', consumer: 'eventLogPageScan', endpointSlot: 'fallback_3', count: hits },
      ]);
      const snapshot = cumulative.snapshot();
      expect(snapshot.cumulative.methods.eth_getLogs).toBe(hits);
      expect(snapshot.cumulative.consumers.eth_getLogs).toEqual({
        eventLogPageScan: hits,
      });
      expect(snapshot.cumulative.adapterRoles.eth_getLogs).toEqual({ main_agent: hits });
    } finally {
      provider.destroy();
    }
  }, 30_000);

  it('keeps concurrent queued methods bound to their issuer consumers and publisher role', async () => {
    const rpc = await startLoopbackRpc({
      results: {
        eth_getBlockByNumber: { number: '0x10', hash: `0x${'11'.repeat(32)}` },
      },
    });
    servers.push(rpc);
    const cumulative = new RpcUsageCumulativeAccumulator('epoch-issuer-context');
    const tracker = new RpcUsageTracker(() => 'evm:31337', 'publisher_wallet', cumulative);
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
      onRequest: (method, slot) => tracker.record(method, slot),
    });

    try {
      // Complete provider startup before the paired calls. Both sends below
      // then enqueue in one scheduling turn and share ethers' drain timer --
      // the exact case where the timer owner's ALS used to label its peer.
      await provider.getNetwork();
      const header = withRpcUsageConsumer(
        'chainIndex.lineage',
        () => provider.send('eth_getBlockByNumber', ['latest', false]),
      );
      const authority = withRpcUsageSite(
        CONTEXT_GRAPH_AUTHORITY_RPC_SITES.query,
        () => withRpcUsageConsumer(
          CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER,
          () => provider.send('eth_call', [{ to: HUB, data: '0x' }, 'latest']),
        ),
      );

      await expect(Promise.all([header, authority])).resolves.toHaveLength(2);
      expect(rpc.hits('eth_getBlockByNumber')).toBe(1);
      expect(rpc.hits('eth_call')).toBe(1);

      const snapshot = cumulative.snapshot();
      expect(snapshot.cumulative.methods).toMatchObject({
        eth_getBlockByNumber: 1,
        eth_call: 1,
      });
      expect(snapshot.cumulative.consumers.eth_getBlockByNumber).toEqual({
        'chainIndex.lineage': 1,
      });
      expect(snapshot.cumulative.consumers.eth_call).toEqual({
        'cgStorage.getContextGraph:cgAuth.query': 1,
      });
      expect(snapshot.cumulative.consumers.eth_chainId).toEqual({
        unattributed: rpc.hits('eth_chainId'),
      });
      expect(snapshot.cumulative.adapterRoles.eth_getBlockByNumber).toEqual({
        publisher_wallet: 1,
      });
      expect(snapshot.cumulative.adapterRoles.eth_call).toEqual({
        publisher_wallet: 1,
      });
    } finally {
      provider.destroy();
    }
  }, 30_000);

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

  it('allows an adapter read helper to opt out of raw-read attribution explicitly', async () => {
    installMeter();
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: rpc.url,
      chainId: 'evm:31337',
    }));
    adapters.push(a);

    await expect(
      a.readProvider(
        'health probe label',
        (p: any) => p.send('eth_call', [{ to: HUB, data: '0x' }, 'latest']),
        { rpcUsageConsumer: null },
      ),
    ).resolves.toBeDefined();

    const usage = a.drainRpcUsage();
    expect(usage.byMethod.eth_call).toBeGreaterThanOrEqual(1);
    expect(usage.ethCallByConsumer).toEqual({});
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

  it('composes a real getContextGraph transport label with its authority call site', async () => {
    installMeter();
    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['address', 'address[]', 'uint256', 'bool', 'uint256', 'uint8', 'uint8', 'address', 'uint256'],
      [HUB, [HUB], 0n, true, 0n, 1, 0, HUB, 0n],
    );
    const rpc = await startLoopbackRpc({ results: { eth_call: encoded } });
    servers.push(rpc);
    const a: any = new EVMChainAdapter(minimalConfig({ rpcUrl: rpc.url }));
    adapters.push(a);
    a.initialized = true;
    a.init = async () => {};
    a.contracts = {
      contextGraphStorage: new Contract(HUB, [
        'function getContextGraph(uint256) view returns '
        + '(address,address[],uint256,bool,uint256,uint8,uint8,address,uint256)',
      ]),
    };

    await expect(withRpcUsageSite(
      CONTEXT_GRAPH_AUTHORITY_RPC_SITES.syncAuthorize,
      () => a.getContextGraphLiveAuthority(1n),
    )).resolves.toMatchObject({ active: true, accessPolicy: 1 });

    const usage = a.drainRpcUsage();
    expect(usage.ethCallByConsumer).toEqual({
      [`${CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER}:cgAuth.syncAuthz`]: rpc.hits('eth_call'),
    });
    expect(rpc.hits('eth_call')).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
