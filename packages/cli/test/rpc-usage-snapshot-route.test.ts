import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  RpcUsageCumulativeAccumulator,
  RpcUsageTracker,
  withRpcUsageConsumer,
  type RpcUsageCumulativeSnapshot,
} from '@origintrail-official/dkg-chain';
import {
  handleRpcUsageSnapshotRequest,
  isLoopbackAddress,
  RPC_USAGE_SNAPSHOT_PATH,
} from '../src/daemon/rpc-usage-snapshot-route.js';

function request(method: string, remoteAddress: string): IncomingMessage {
  return {
    method,
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function response(): {
  readonly res: ServerResponse;
  readonly status: () => number | undefined;
  readonly headers: () => Record<string, string> | undefined;
  readonly body: () => string | undefined;
} {
  let status: number | undefined;
  let headers: Record<string, string> | undefined;
  let body: string | undefined;
  return {
    res: {
      writeHead: (nextStatus: number, nextHeaders: Record<string, string>) => {
        status = nextStatus;
        headers = nextHeaders;
      },
      end: (nextBody?: string) => { body = nextBody; },
    } as unknown as ServerResponse,
    status: () => status,
    headers: () => headers,
    body: () => body,
  };
}

function snapshot(): RpcUsageCumulativeSnapshot {
  return {
    schemaVersion: 1,
    consumerVocabularyVersion: 2,
    processEpoch: 'epoch-1',
    capturedAtUtc: '2026-09-20T12:00:00.000Z',
    capturedAtMonotonicMs: 123,
    completeness: {
      complete: true,
      reasons: [],
      populationEpoch: 3,
      sources: {
        mainAgent: { status: 'included', totalRegisteredTrackers: 1, totalsRetained: true },
        publisherWallets: { status: 'included', totalRegisteredTrackers: 1, totalsRetained: true },
        routeRuntimes: { status: 'included', totalRegisteredTrackers: 1, totalsRetained: true },
        other: { status: 'included', totalRegisteredTrackers: 0, totalsRetained: true },
      },
    },
    cumulative: {
      methods: { eth_call: 2 },
      consumers: { eth_call: { unattributed: 2 } },
      adapterRoles: { eth_call: { main_agent: 2 } },
    },
  };
}

describe('RPC usage snapshot diagnostic route', () => {
  it('recognizes only loopback peer addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.2')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('serves a no-store immutable snapshot only after auth and without side effects', () => {
    const out = response();
    const capture = vi.fn(snapshot);

    expect(handleRpcUsageSnapshotRequest({
      req: request('GET', '127.0.0.1'),
      res: out.res,
      url: new URL(`http://127.0.0.1${RPC_USAGE_SNAPSHOT_PATH}`),
      authenticated: true,
      snapshot: capture,
    })).toBe(true);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(out.status()).toBe(200);
    expect(out.headers()).toMatchObject({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    expect(JSON.parse(out.body() ?? '')).toEqual(snapshot());
    expect(JSON.parse(out.body() ?? '').consumerVocabularyVersion).toBe(2);
  });

  it('serializes unknown credentials, IDs, graph names, and query labels only as other', () => {
    const cumulative = new RpcUsageCumulativeAccumulator('epoch-private-route');
    const tracker = new RpcUsageTracker(() => 'evm:31337', 'main_agent', cumulative);
    const unknownConsumers = [
      'Bearer fixture-secret-token',
      'request.01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'request.cuidclh0am13x0000w5a0k2q4g',
      'graph.customer-private',
      'query.select_name_from_graph',
    ];
    for (const consumer of unknownConsumers) {
      withRpcUsageConsumer(consumer, () => tracker.record('eth_call'));
    }
    const out = response();

    expect(handleRpcUsageSnapshotRequest({
      req: request('GET', '127.0.0.1'),
      res: out.res,
      url: new URL(`http://127.0.0.1${RPC_USAGE_SNAPSHOT_PATH}`),
      authenticated: true,
      snapshot: () => cumulative.snapshot(),
    })).toBe(true);

    expect(out.status()).toBe(200);
    for (const fragment of [
      'Bearer',
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'cuidclh0am13x0000w5a0k2q4g',
      'customer-private',
      'select_name_from_graph',
    ]) {
      expect(out.body()).not.toContain(fragment);
    }
    const body = JSON.parse(out.body() ?? '') as RpcUsageCumulativeSnapshot;
    expect(body.consumerVocabularyVersion).toBe(2);
    expect(body.cumulative.consumers.eth_call).toEqual({ other: unknownConsumers.length });
  });

  it('does not capture for unauthenticated, non-local, or non-GET requests', () => {
    const cases = [
      { authenticated: false, method: 'GET', address: '127.0.0.1', status: 401 },
      { authenticated: true, method: 'GET', address: '10.0.0.2', status: 403 },
      { authenticated: true, method: 'POST', address: '127.0.0.1', status: 405 },
    ] as const;
    for (const entry of cases) {
      const out = response();
      const capture = vi.fn(snapshot);
      expect(handleRpcUsageSnapshotRequest({
        req: request(entry.method, entry.address),
        res: out.res,
        url: new URL(`http://127.0.0.1${RPC_USAGE_SNAPSHOT_PATH}`),
        authenticated: entry.authenticated,
        snapshot: capture,
      })).toBe(true);
      expect(out.status()).toBe(entry.status);
      expect(capture).not.toHaveBeenCalled();
    }
  });

  it('does not claim unrelated paths', () => {
    const out = response();
    const capture = vi.fn(snapshot);
    expect(handleRpcUsageSnapshotRequest({
      req: request('GET', '127.0.0.1'),
      res: out.res,
      url: new URL('http://127.0.0.1/api/status'),
      authenticated: true,
      snapshot: capture,
    })).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});
