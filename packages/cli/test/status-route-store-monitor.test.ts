/**
 * `/api/status` exposure of the runtime store monitor (#1817 review):
 * the monitor/lifecycle units prove the counters are MAINTAINED, but only a
 * route-level assertion proves operators can actually SEE them. A regression
 * that dropped the field, returned it unconditionally null, or leaked a live
 * stats reference would leave every monitor unit test green.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { handleStatusRoutes } from '../src/daemon/routes/status.js';
import { resolveRfc64CatalogActivationsV1, resolveRfc64PublicCatalogActivationChainIdentityV1 } from '@origintrail-official/dkg-agent/rfc64/public-catalog-activation-config-v1';
import { requestAuthentication } from './_helpers/request-authentication.js';
import { daemonState } from '../src/daemon/state.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import type { StoreMonitorStats } from '../src/daemon/store-runtime-monitor.js';
import { projectStoreStatus } from '../src/daemon/store-status.js';

const DISABLED_PUBLISHER_STATE: RequestContext['publisherState'] = {
  runtime: null,
  availability: {
    available: false,
    reason: 'publisher_disabled',
    retryable: false,
    operatorActionRequired: true,
  },
};

async function startStatusServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try { await handleStatusRoutes({
      req,
      res,
      authentication: requestAuthentication({ kind: 'anonymous' }),
      publisherState: DISABLED_PUBLISHER_STATE,
      path: url.pathname,
      url,
      network: null,
      config: {
        name: 'status-store-monitor-test',
        nodeRole: 'edge',
        chain: { type: 'mock' },
        store: {
          backend: 'blazegraph',
          options: { url: 'http://127.0.0.1:9/bigdata/namespace/dkg/sparql', managedByDkg: true },
        },
      },
      rfc64PublicCatalog: { enabled: false, selectedContextGraphs: [] },
      rfc64CatalogActivationState: resolveRfc64CatalogActivationsV1({ persistenceAvailable: false }, resolveRfc64PublicCatalogActivationChainIdentityV1(undefined)).activationState,
      startedAt: Date.now(),
      agent: {
        peerId: 'peer-status-store-monitor-test',
        multiaddrs: [],
        getSyncContextGraphIds: () => [],
        store: { query: async () => ({ type: 'bindings', bindings: [] }) },
        node: {
          libp2p: { getConnections: () => [] },
          getRelayStats: () => null,
        },
        publisher: { getIdentityId: () => 0n },
      },
      nodeVersion: '0.0.0-test',
      nodeCommit: '',
      admission: { inFlight: 0, max: 0, rejectedTotal: 0 },
    } as unknown as RequestContext); } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('/api/status storeMonitor exposure', () => {
  afterEach(() => {
    daemonState.storeMonitor = null;
  });

  it('exposes the monitor stats counters when a monitor is installed', async () => {
    const stats: StoreMonitorStats = {
      probesTotal: 42,
      failuresTotal: 7,
      consecutiveFailures: 2,
      restartsTotal: 1,
      restartFailuresTotal: 0,
      lastProbeOkAt: 1_800_000_000_000,
      lastRestartAt: 1_799_999_000_000,
      cooldownUntilMs: null,
      managedContainer: 'dkg-blazegraph-dkg',
    };
    daemonState.storeMonitor = { stats, stop: async () => {} };

    const { server, baseUrl } = await startStatusServer();
    try {
      const body = await (await fetch(`${baseUrl}/api/status`)).json() as {
        storeMonitor: Record<string, unknown> | null; error?: string;
      };
      expect(body.error).toBeUndefined();
      expect(body.storeMonitor).toMatchObject({
        probesTotal: 42,
        failuresTotal: 7,
        consecutiveFailures: 2,
        restartsTotal: 1,
        restartFailuresTotal: 0,
        managedContainer: 'dkg-blazegraph-dkg',
      });
    } finally {
      await closeServer(server);
    }
  });

  it('projects independent counters before any HTTP serialization', () => {
    const stats: StoreMonitorStats = {
      probesTotal: 42, failuresTotal: 7, consecutiveFailures: 2, restartsTotal: 1,
      restartFailuresTotal: 0, lastProbeOkAt: 100, lastRestartAt: 90,
      cooldownUntilMs: null, managedContainer: 'dkg-blazegraph-dkg',
    };
    const projection = projectStoreStatus(undefined, { stats });
    expect(projection.storeMonitor).not.toBe(stats);
    projection.storeMonitor!.probesTotal = 900;
    expect(stats.probesTotal).toBe(42);
    stats.failuresTotal = 800;
    expect(projection.storeMonitor!.failuresTotal).toBe(7);
  });

  it('reports storeMonitor: null explicitly for local/pre-boot state', async () => {
    daemonState.storeMonitor = null;
    const { server, baseUrl } = await startStatusServer();
    try {
      const body = await (await fetch(`${baseUrl}/api/status`)).json() as {
        storeMonitor: unknown;
      };
      expect(body).not.toHaveProperty('error');
      expect(body).toHaveProperty('storeMonitor', null);
    } finally {
      await closeServer(server);
    }
  });
});
