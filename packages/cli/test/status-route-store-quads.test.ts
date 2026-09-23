import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import {
  resolveRfc64CatalogActivationsV1,
  resolveRfc64PublicCatalogActivationChainIdentityV1,
} from '@origintrail-official/dkg-agent/rfc64/public-catalog-activation-config-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api-client.js';
import { registerLifecycleCommands } from '../src/commands/lifecycle.js';
import { handleStatusRoutes } from '../src/daemon/routes/status.js';
import { invalidateExternalStoreQuadsCache } from '../src/daemon/store-quads-cache.js';
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
const DISABLED_RFC64_PUBLIC_CATALOG: RequestContext['rfc64PublicCatalog'] = {
  enabled: false,
  selectedContextGraphs: [],
};
const EPHEMERAL_RFC64_ACTIVATION_STATE = resolveRfc64CatalogActivationsV1({
  persistenceAvailable: false,
}, resolveRfc64PublicCatalogActivationChainIdentityV1(undefined)).activationState;

interface StoreConfig {
  backend: string;
  options?: Record<string, unknown>;
}

const SPARQL_HTTP_STORE: StoreConfig = {
  backend: 'sparql-http',
  options: { url: 'http://127.0.0.1:9/query' },
};
// The 2026-09-23 report: a managed Oxigraph on a fresh edge node.
const MANAGED_OXIGRAPH_STORE: StoreConfig = {
  backend: 'oxigraph-server',
  options: { port: 7880 },
};
const LOCAL_STORE: StoreConfig = { backend: 'oxigraph-worker' };

const COUNT_123 = {
  type: 'bindings',
  bindings: [{ c: '"123"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
};
const COUNT_66 = {
  type: 'bindings',
  bindings: [{ c: '"66"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
};
const ASK_TRUE = { type: 'boolean', value: true };

function isAsk(sparql: string): boolean {
  return sparql.startsWith('ASK');
}

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

function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function startStatusServer(
  query: (sparql: string) => Promise<unknown>,
  store: StoreConfig = SPARQL_HTTP_STORE,
  // Awaited inside the route after the store fields are read and the
  // reachability check has started, as the real status blocks await I/O: a
  // count can settle meanwhile, and a test can see every request reach it.
  { beforeReply }: { beforeReply?: () => Promise<void> } = {},
): Promise<{
  server: Server;
  baseUrl: string;
}> {
  // One store for every request, as in the daemon.
  const agentStore = { query };
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
        store,
      },
      rfc64PublicCatalog: DISABLED_RFC64_PUBLIC_CATALOG,
      rfc64CatalogActivationState: EPHEMERAL_RFC64_ACTIVATION_STATE,
      startedAt: Date.now(),
      agent: {
        peerId: 'peer-status-store-quads-test',
        multiaddrs: [],
        getSyncContextGraphIds: () => [],
        store: agentStore,
        node: {
          libp2p: { getConnections: () => [] },
          getRelayStats: () => null,
        },
        publisher: { getIdentityId: () => 0n },
        ...(beforeReply
          ? {
              getFinalizationRecoveryHealth: async () => {
                await beforeReply();
                return { available: false };
              },
            }
          : {}),
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

interface StatusBody {
  storeUrl: string | null;
  storeQuads: number | null;
  storeQuadsStatus?: string;
  storeQuadsAgeMs?: number | null;
  storeQuadsRefreshing?: boolean;
  storeReachability?: string;
}

async function fetchStatus(baseUrl: string, includeStoreQuads = false): Promise<{
  status: number;
  body: StatusBody;
}> {
  const suffix = includeStoreQuads ? '?includeStoreQuads=true' : '';
  const response = await fetch(`${baseUrl}/api/status${suffix}`);
  return {
    status: response.status,
    body: await response.json() as StatusBody,
  };
}

async function cleanUpStoreQuads(): Promise<void> {
  // Let a count a test released write its result before the cache is
  // dropped, so a late write cannot warm the next test's cold cache.
  await nextTick();
  invalidateExternalStoreQuadsCache();
  vi.restoreAllMocks();
}

describe('/api/status external-store quad count', () => {
  afterEach(cleanUpStoreQuads);

  it.each([
    ['an external SPARQL store', SPARQL_HTTP_STORE, 'http://127.0.0.1:9/query'],
    ['a managed oxigraph-server', MANAGED_OXIGRAPH_STORE, 'http://127.0.0.1:7880/query'],
  ])('reports a count nobody requested on %s as not-requested, without starting one', async (
    _label,
    store,
    storeUrl,
  ) => {
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return COUNT_123;
    }, store);

    try {
      const first = await fetchStatus(baseUrl);
      const second = await fetchStatus(baseUrl);
      for (const polled of [first, second]) {
        expect(polled).toMatchObject({
          status: 200,
          body: {
            storeUrl,
            storeQuads: null,
            storeQuadsStatus: 'not-requested',
            storeQuadsAgeMs: null,
            storeQuadsRefreshing: false,
          },
        });
      }
      expect(queryCalls).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['yes', false],
  ])('treats includeStoreQuads=%s as a count request: %s', async (spelling, requestsCount) => {
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return COUNT_123;
    });

    try {
      const response = await fetch(`${baseUrl}/api/status?includeStoreQuads=${spelling}`);
      const body = await response.json() as StatusBody;
      expect(body.storeQuadsStatus).toBe(requestsCount ? 'pending' : 'not-requested');
      expect(queryCalls).toBe(requestsCount ? 1 : 0);
    } finally {
      await closeServer(server);
    }
  });

  it('returns a pending cold count without waiting for the store refresh', async () => {
    const countResult = deferred<unknown>();
    const queryStarted = deferred<void>();
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      queryStarted.resolve();
      return countResult.promise;
    });

    try {
      const responsePromise = fetchStatus(baseUrl, true);
      await queryStarted.promise;

      const timeout = Symbol('status timed out');
      const immediate = await Promise.race([
        responsePromise,
        new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 500)),
      ]);

      countResult.resolve(COUNT_123);
      await responsePromise;

      expect(immediate).not.toBe(timeout);
      expect(immediate).toMatchObject({
        status: 200,
        body: {
          storeQuads: null,
          storeQuadsStatus: 'pending',
          storeQuadsAgeMs: null,
          storeQuadsRefreshing: true,
        },
      });
      expect(queryCalls).toBe(1);
    } finally {
      countResult.resolve({ type: 'bindings', bindings: [] });
      await closeServer(server);
    }
  });

  it('reports a count already running as pending to ordinary polling without starting another', async () => {
    const countResult = deferred<unknown>();
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return countResult.promise;
    });

    try {
      const requested = await fetchStatus(baseUrl, true);
      expect(requested.body.storeQuadsStatus).toBe('pending');

      const polled = await fetchStatus(baseUrl);
      expect(polled.body).toMatchObject({
        storeQuads: null,
        storeQuadsStatus: 'pending',
        storeQuadsAgeMs: null,
        storeQuadsRefreshing: true,
      });
      expect(queryCalls).toBe(1);

      countResult.resolve(COUNT_66);
      await nextTick();

      const settled = await fetchStatus(baseUrl);
      expect(settled.body).toMatchObject({
        storeQuads: 66,
        storeQuadsStatus: 'ready',
        storeQuadsRefreshing: false,
      });
      expect(queryCalls).toBe(1);
    } finally {
      countResult.resolve({ type: 'bindings', bindings: [] });
      await closeServer(server);
    }
  });

  it('serves the cached count to ordinary polling with its age and never refreshes it', async () => {
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return COUNT_66;
    });
    const countedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(countedAt);

    try {
      await fetchStatus(baseUrl, true);
      await nextTick();
      expect(queryCalls).toBe(1);

      // An hour later, far past the refresh TTL: polling still must not count.
      clock.mockReturnValue(countedAt + 3_600_000);
      const hourLater = await fetchStatus(baseUrl);
      expect(hourLater.body).toMatchObject({
        storeQuads: 66,
        storeQuadsStatus: 'ready',
        storeQuadsAgeMs: 3_600_000,
      });

      expect(queryCalls).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  it('reports a count from before a backwards clock step with an unknown age and refreshes it on request', async () => {
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return COUNT_66;
    });
    const countedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(countedAt);

    try {
      await fetchStatus(baseUrl, true);
      await nextTick();

      // The wall clock steps back past the count: its age is unknown, not 0.
      clock.mockReturnValue(countedAt - 5_000);
      const polled = await fetchStatus(baseUrl);
      expect(polled.body).toMatchObject({
        storeQuads: 66,
        storeQuadsStatus: 'ready',
        storeQuadsAgeMs: null,
      });
      expect(queryCalls).toBe(1);

      // Nor does it count as fresh: an explicit request refreshes it.
      const requested = await fetchStatus(baseUrl, true);
      expect(requested.body).toMatchObject({ storeQuads: 66, storeQuadsAgeMs: null });
      expect(queryCalls).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it('reports a failed count as unreachable to ordinary polling, with its age', async () => {
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      throw new Error('store unavailable');
    });
    const failedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(failedAt);

    try {
      await fetchStatus(baseUrl, true);
      await nextTick();

      clock.mockReturnValue(failedAt + 120_000);
      const polled = await fetchStatus(baseUrl);
      expect(polled.body).toMatchObject({
        storeQuads: null,
        storeQuadsStatus: 'unreachable',
        storeQuadsAgeMs: 120_000,
      });
      expect(queryCalls).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  it('reports a recount it started as refreshing even when the count settles before the reply', async () => {
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return COUNT_66;
    }, SPARQL_HTTP_STORE, { beforeReply: nextTick });
    const countedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(countedAt);

    try {
      await fetchStatus(baseUrl, true);
      await nextTick();
      expect(queryCalls).toBe(1);

      // Past the cache TTL: this request starts a recount, which settles while
      // the route is still building the rest of the reply.
      clock.mockReturnValue(countedAt + 60_000);
      const requested = await fetchStatus(baseUrl, true);
      expect(queryCalls).toBe(2);
      expect(requested.body).toMatchObject({
        storeQuads: 66,
        storeQuadsStatus: 'ready',
        storeQuadsAgeMs: 60_000,
        storeQuadsRefreshing: true,
      });
    } finally {
      await closeServer(server);
    }
  });

  it('omits count status and age for a local backend, even when a count is requested', async () => {
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return COUNT_123;
    }, LOCAL_STORE);

    try {
      for (const response of [await fetchStatus(baseUrl), await fetchStatus(baseUrl, true)]) {
        expect(response.body).toMatchObject({ storeUrl: null, storeQuads: null });
        expect(response.body).not.toHaveProperty('storeQuadsStatus');
        expect(response.body).not.toHaveProperty('storeQuadsAgeMs');
        expect(response.body).not.toHaveProperty('storeQuadsRefreshing');
      }
      expect(queryCalls).toBe(0);
    } finally {
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
      expect(firstCold.body.storeQuadsAgeMs).toBeNull();
      expect(queryCalls).toBe(1);

      firstCount.resolve(COUNT_123);
      await nextTick();

      const fresh = await fetchStatus(baseUrl, true);
      expect(fresh.body.storeQuads).toBe(123);
      expect(fresh.body.storeQuadsStatus).toBe('ready');
      expect(fresh.body.storeQuadsAgeMs).toBeGreaterThanOrEqual(0);
      expect(fresh.body.storeQuadsAgeMs).toBeLessThan(30_000);
      expect(fresh.body.storeQuadsRefreshing).toBe(false);
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
      expect(firstStale.body.storeQuadsAgeMs).toBeGreaterThanOrEqual(30_001);
      expect(firstStale.body.storeQuadsRefreshing).toBe(true);
      expect(secondStale.body.storeQuadsRefreshing).toBe(true);
      expect(queryCalls).toBe(2);

      staleRefresh.reject(new Error('store unavailable'));
      await nextTick();

      const afterFailure = await fetchStatus(baseUrl, true);
      expect(afterFailure.body.storeQuads).toBeNull();
      expect(afterFailure.body.storeQuadsStatus).toBe('unreachable');
      expect(afterFailure.body.storeQuadsAgeMs).toBe(0);
      expect(afterFailure.body.storeQuadsRefreshing).toBe(false);
      expect(queryCalls).toBe(2);
    } finally {
      firstCount.resolve({ type: 'bindings', bindings: [] });
      staleRefresh.resolve({ type: 'bindings', bindings: [] });
      await closeServer(server);
    }
  });

  it.each([
    ['fails', (count: Deferred<unknown>) => count.reject(new Error('store unavailable'))],
    ['succeeds', (count: Deferred<unknown>) => count.resolve(COUNT_123)],
  ])('drops a count that %s after an invalidation instead of caching its result', async (
    _outcome,
    settle,
  ) => {
    const staleCount = deferred<unknown>();
    const freshCount = deferred<unknown>();
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return queryCalls === 1 ? staleCount.promise : freshCount.promise;
    }, MANAGED_OXIGRAPH_STORE);

    try {
      const requested = await fetchStatus(baseUrl, true);
      expect(requested.body.storeQuadsStatus).toBe('pending');
      expect(queryCalls).toBe(1);

      // The managed Oxigraph goes down while that count runs. The count keeps
      // running but loses the in-flight marker, so nothing that will be
      // published is being counted.
      invalidateExternalStoreQuadsCache();
      const invalidated = await fetchStatus(baseUrl);
      expect(invalidated.body).toMatchObject({
        storeQuads: null,
        storeQuadsStatus: 'not-requested',
        storeQuadsAgeMs: null,
        storeQuadsRefreshing: false,
      });

      // Whatever the count then returns, typically a failure against the
      // dying server, describes a store that is gone.
      settle(staleCount);
      await nextTick();

      const polled = await fetchStatus(baseUrl);
      expect(polled.body).toMatchObject({
        storeQuads: null,
        storeQuadsStatus: 'not-requested',
        storeQuadsAgeMs: null,
        storeQuadsRefreshing: false,
      });
      expect(queryCalls).toBe(1);

      const rerequested = await fetchStatus(baseUrl, true);
      expect(rerequested.body).toMatchObject({
        storeQuads: null,
        storeQuadsStatus: 'pending',
        storeQuadsRefreshing: true,
      });
      expect(queryCalls).toBe(2);

      freshCount.resolve(COUNT_66);
      await nextTick();

      const counted = await fetchStatus(baseUrl);
      expect(counted.body).toMatchObject({
        storeQuads: 66,
        storeQuadsStatus: 'ready',
        storeQuadsRefreshing: false,
      });
    } finally {
      staleCount.resolve({ type: 'bindings', bindings: [] });
      freshCount.resolve({ type: 'bindings', bindings: [] });
      await closeServer(server);
    }
  });

  it('keeps a count started after an invalidation pending when the older count settles', async () => {
    const staleCount = deferred<unknown>();
    const freshCount = deferred<unknown>();
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async () => {
      queryCalls += 1;
      return queryCalls === 1 ? staleCount.promise : freshCount.promise;
    }, MANAGED_OXIGRAPH_STORE);

    try {
      await fetchStatus(baseUrl, true);
      invalidateExternalStoreQuadsCache();
      const restarted = await fetchStatus(baseUrl, true);
      expect(restarted.body.storeQuadsStatus).toBe('pending');
      expect(queryCalls).toBe(2);

      staleCount.reject(new Error('store unavailable'));
      await nextTick();

      // The newer count still holds the marker, so it is the one refreshing.
      const polled = await fetchStatus(baseUrl);
      expect(polled.body).toMatchObject({
        storeQuads: null,
        storeQuadsStatus: 'pending',
        storeQuadsAgeMs: null,
        storeQuadsRefreshing: true,
      });
      const rerequested = await fetchStatus(baseUrl, true);
      expect(rerequested.body.storeQuadsStatus).toBe('pending');
      expect(queryCalls).toBe(2);

      freshCount.resolve(COUNT_66);
      await nextTick();

      const counted = await fetchStatus(baseUrl);
      expect(counted.body).toMatchObject({
        storeQuads: 66,
        storeQuadsStatus: 'ready',
        storeQuadsRefreshing: false,
      });
      expect(queryCalls).toBe(2);
    } finally {
      staleCount.resolve({ type: 'bindings', bindings: [] });
      freshCount.resolve({ type: 'bindings', bindings: [] });
      await closeServer(server);
    }
  });
});

describe('dkg status against the status route', () => {
  afterEach(cleanUpStoreQuads);

  async function runStatusCommand(baseUrl: string): Promise<string> {
    const lines: string[] = [];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      }),
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`dkg status exited with ${code}`);
      }) as never),
      vi.spyOn(ApiClient, 'connect').mockResolvedValue(new ApiClient(baseUrl)),
    ];

    try {
      const program = new Command();
      program.exitOverride();
      registerLifecycleCommands(program);
      await program.parseAsync(['node', 'dkg', 'status']);
      return lines.join('\n');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  it('shows a cold, healthy managed Oxigraph as CHECKING and then its count, never UNREACHABLE', async () => {
    const countResult = deferred<unknown>();
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async (sparql) => {
      if (isAsk(sparql)) return ASK_TRUE;
      queryCalls += 1;
      return countResult.promise;
    }, MANAGED_OXIGRAPH_STORE);

    try {
      const cold = await runStatusCommand(baseUrl);
      expect(cold).toContain('Store:     oxigraph-server (http://127.0.0.1:7880/query) — CHECKING');
      expect(cold).not.toContain('UNREACHABLE');
      expect(queryCalls).toBe(1);

      countResult.resolve(COUNT_66);
      await nextTick();

      const counted = await runStatusCommand(baseUrl);
      expect(counted).toContain('Store:     oxigraph-server (http://127.0.0.1:7880/query) — 66 quads');
      expect(queryCalls).toBe(1);
    } finally {
      countResult.resolve({ type: 'bindings', bindings: [] });
      await closeServer(server);
    }
  });

  it('starts no count while the cached one is under ten minutes old, then refreshes it', async () => {
    let queryCalls = 0;
    const { server, baseUrl } = await startStatusServer(async (sparql) => {
      if (isAsk(sparql)) return ASK_TRUE;
      queryCalls += 1;
      return COUNT_66;
    }, MANAGED_OXIGRAPH_STORE);
    const countedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(countedAt);

    try {
      expect(await runStatusCommand(baseUrl)).toContain('— CHECKING');
      await nextTick();
      expect(queryCalls).toBe(1);

      clock.mockReturnValue(countedAt + 9 * 60_000);
      const nineMinutes = await runStatusCommand(baseUrl);
      expect(nineMinutes).toContain('— 66 quads (checked 9m 0s ago)');
      expect(nineMinutes).not.toContain('refreshing');
      expect(queryCalls).toBe(1);

      // The daemon answers with the count it has while the recount runs.
      clock.mockReturnValue(countedAt + 10 * 60_000);
      expect(await runStatusCommand(baseUrl)).toContain('— 66 quads (checked 10m 0s ago), refreshing');
      expect(queryCalls).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it('shows an external store that stopped answering as UNREACHABLE on the next run, without a count', async () => {
    let storeUp = true;
    let asks = 0;
    let counts = 0;
    const { server, baseUrl } = await startStatusServer(async (sparql) => {
      if (isAsk(sparql)) asks += 1;
      else counts += 1;
      if (!storeUp) throw new Error('connect ECONNREFUSED 127.0.0.1:9');
      return isAsk(sparql) ? ASK_TRUE : COUNT_66;
    });
    const countedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(countedAt);

    try {
      expect(await runStatusCommand(baseUrl)).toContain('— CHECKING');
      await nextTick();
      expect(counts).toBe(1);

      // Two minutes later, well inside the ten-minute count reuse, the store
      // is down: this run's check says so, and no count is started for it.
      storeUp = false;
      clock.mockReturnValue(countedAt + 2 * 60_000);
      expect(await runStatusCommand(baseUrl))
        .toContain('Store:     sparql-http (http://127.0.0.1:9/query) — UNREACHABLE');
      expect(counts).toBe(1);

      // Back up: the cached count shows again, with its age.
      storeUp = true;
      clock.mockReturnValue(countedAt + 3 * 60_000);
      expect(await runStatusCommand(baseUrl)).toContain('— 66 quads (checked 3m 0s ago)');
      expect(counts).toBe(1);
      expect(asks).toBe(3);
    } finally {
      await closeServer(server);
    }
  });
});

describe('/api/status store reachability check', () => {
  afterEach(cleanUpStoreQuads);

  async function fetchProbed(baseUrl: string): Promise<StatusBody> {
    const response = await fetch(`${baseUrl}/api/status?probeStore=true`);
    return await response.json() as StatusBody;
  }

  it('checks with one ASK when asked, and starts no count', async () => {
    const queries: string[] = [];
    const { server, baseUrl } = await startStatusServer(async (sparql) => {
      queries.push(sparql);
      return isAsk(sparql) ? ASK_TRUE : COUNT_66;
    });

    try {
      expect(await fetchProbed(baseUrl)).toMatchObject({
        storeReachability: 'reachable',
        storeQuadsStatus: 'not-requested',
      });
      expect(queries).toEqual(['ASK { ?s ?p ?o }']);
    } finally {
      await closeServer(server);
    }
  });

  it('reports a store whose ASK fails as unreachable', async () => {
    const { server, baseUrl } = await startStatusServer(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9');
    });

    try {
      expect((await fetchProbed(baseUrl)).storeReachability).toBe('unreachable');
    } finally {
      await closeServer(server);
    }
  });

  it('never checks during ordinary polling or for a local backend', async () => {
    const queries: string[] = [];
    const record = async (sparql: string) => {
      queries.push(sparql);
      return ASK_TRUE;
    };
    const external = await startStatusServer(record);
    const local = await startStatusServer(record, LOCAL_STORE);

    try {
      expect((await fetchStatus(external.baseUrl)).body).not.toHaveProperty('storeReachability');
      expect(await fetchProbed(local.baseUrl)).not.toHaveProperty('storeReachability');
      expect(queries).toEqual([]);
    } finally {
      await closeServer(external.server);
      await closeServer(local.server);
    }
  });

  it('runs one ASK for concurrent requests', async () => {
    const answer = deferred<unknown>();
    const bothArrived = deferred<void>();
    let arrived = 0;
    let asks = 0;
    const { server, baseUrl } = await startStatusServer(async (sparql) => {
      if (isAsk(sparql)) asks += 1;
      return answer.promise;
    }, SPARQL_HTTP_STORE, {
      // Each request has started or joined the check by the time it gets here.
      beforeReply: async () => {
        arrived += 1;
        if (arrived === 2) bothArrived.resolve();
      },
    });

    try {
      const both = Promise.all([fetchProbed(baseUrl), fetchProbed(baseUrl)]);
      await bothArrived.promise;
      answer.resolve(ASK_TRUE);
      const [first, second] = await both;
      expect(first.storeReachability).toBe('reachable');
      expect(second.storeReachability).toBe('reachable');
      expect(asks).toBe(1);
    } finally {
      answer.resolve(ASK_TRUE);
      await closeServer(server);
    }
  });
});
