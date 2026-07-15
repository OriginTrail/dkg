import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleStatusRoutes,
  invalidateExternalStoreQuadsCache,
} from '../src/daemon/routes/status.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const DISABLED_PUBLISHER_STATE: RequestContext['publisherState'] = {
  runtime: null,
  availability: {
    available: false,
    reason: 'publisher_disabled',
    retryable: false,
    operatorActionRequired: true,
  },
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function startStatusServer(query: (...args: unknown[]) => Promise<unknown>): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    await handleStatusRoutes({
      req,
      res,
      publisherState: DISABLED_PUBLISHER_STATE,
      path: url.pathname,
      url,
      network: null,
      config: {
        name: 'status-store-quads-test',
        nodeRole: 'edge',
        chain: { type: 'mock' },
        store: {
          backend: 'sparql-http',
          options: { url: 'http://127.0.0.1:9/query' },
        },
      },
      startedAt: Date.now(),
      agent: {
        peerId: 'peer-status-store-quads-test',
        multiaddrs: [],
        store: { query },
        node: {
          libp2p: { getConnections: () => [] },
          getRelayStats: () => null,
        },
        publisher: { getIdentityId: () => 0n },
      },
      nodeVersion: '0.0.0-test',
      nodeCommit: '',
      admission: { inFlight: 0, max: 0, rejectedTotal: 0 },
    } as unknown as RequestContext);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function fetchStatus(baseUrl: string, includeStoreQuads = false): Promise<{
  status: number;
  body: {
    storeQuads: number | null;
    storeQuadsStatus?: 'pending' | 'ready' | 'unreachable';
  };
}> {
  const suffix = includeStoreQuads ? '?includeStoreQuads=true' : '';
  const response = await fetch(`${baseUrl}/api/status${suffix}`);
  return {
    status: response.status,
    body: await response.json() as {
      storeQuads: number | null;
      storeQuadsStatus?: 'pending' | 'ready' | 'unreachable';
    },
  };
}

describe('/api/status external-store quad count', () => {
  afterEach(() => {
    invalidateExternalStoreQuadsCache();
    vi.restoreAllMocks();
  });

  it('does not start a full-store count during ordinary liveness polling', async () => {
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return { type: 'bindings', bindings: [{ c: '123' }] };
    });

    try {
      const first = await fetchStatus(baseUrl);
      const second = await fetchStatus(baseUrl);
      expect(first).toMatchObject({
        status: 200,
        body: { storeQuads: null },
      });
      expect(first.body.storeQuadsStatus).toBeUndefined();
      expect(second.body.storeQuadsStatus).toBeUndefined();
      expect(queryCalls).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it('returns a pending cold count without waiting for the store refresh', async () => {
    const countResult = deferred<unknown>();
    const queryStarted = deferred<void>();
    const queryCalls: unknown[][] = [];
    const { server, baseUrl } = await startStatusServer(async (...args: unknown[]) => {
      queryCalls.push(args);
      queryStarted.resolve();
      return countResult.promise;
    });

    try {
      const responsePromise = fetch(`${baseUrl}/api/status?includeStoreQuads=true`).then(async (response) => ({
        status: response.status,
        body: await response.json() as {
          storeQuads: number | null;
          storeQuadsStatus?: 'pending' | 'ready' | 'unreachable';
        },
      }));
      await queryStarted.promise;

      const timeout = Symbol('status timed out');
      const immediate = await Promise.race([
        responsePromise,
        new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 500)),
      ]);

      countResult.resolve({
        type: 'bindings',
        bindings: [{ c: '"123"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      });
      await responsePromise;

      expect(immediate).not.toBe(timeout);
      expect(immediate).toMatchObject({
        status: 200,
        body: { storeQuads: null, storeQuadsStatus: 'pending' },
      });
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0]?.[1]).toEqual({
        priority: 'health',
        source: 'daemon.status.storeQuads',
      });
    } finally {
      countResult.resolve({ type: 'bindings', bindings: [] });
      await closeServer(server);
    }
  });

  it('returns a stale count while one refresh runs and caches refresh failures as unknown', async () => {
    const firstCount = deferred<unknown>();
    const staleRefresh = deferred<unknown>();
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return queryCalls === 1 ? firstCount.promise : staleRefresh.promise;
    });

    try {
      const [firstCold, secondCold] = await Promise.all([
        fetchStatus(baseUrl, true),
        fetchStatus(baseUrl, true),
      ]);
      expect(firstCold.body.storeQuads).toBeNull();
      expect(secondCold.body.storeQuads).toBeNull();
      expect(firstCold.body.storeQuadsStatus).toBe('pending');
      expect(secondCold.body.storeQuadsStatus).toBe('pending');
      expect(queryCalls).toBe(1);

      firstCount.resolve({
        type: 'bindings',
        bindings: [{ c: '"123"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const fresh = await fetchStatus(baseUrl, true);
      expect(fresh.body.storeQuads).toBe(123);
      expect(fresh.body.storeQuadsStatus).toBe('ready');
      expect(queryCalls).toBe(1);

      const staleNow = Date.now() + 30_001;
      vi.spyOn(Date, 'now').mockReturnValue(staleNow);
      const [firstStale, secondStale] = await Promise.all([
        fetchStatus(baseUrl, true),
        fetchStatus(baseUrl, true),
      ]);
      expect(firstStale.body.storeQuads).toBe(123);
      expect(secondStale.body.storeQuads).toBe(123);
      expect(firstStale.body.storeQuadsStatus).toBe('ready');
      expect(secondStale.body.storeQuadsStatus).toBe('ready');
      expect(queryCalls).toBe(2);

      staleRefresh.reject(new Error('store unavailable'));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const afterFailure = await fetchStatus(baseUrl, true);
      expect(afterFailure.body.storeQuads).toBeNull();
      expect(afterFailure.body.storeQuadsStatus).toBe('unreachable');
      expect(queryCalls).toBe(2);
    } finally {
      firstCount.resolve({ type: 'bindings', bindings: [] });
      staleRefresh.resolve({ type: 'bindings', bindings: [] });
      await closeServer(server);
    }
  });
});
