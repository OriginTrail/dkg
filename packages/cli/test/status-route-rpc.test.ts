/**
 * /api/status chain sanitization + /api/chain/rpc-health probing — REAL
 * daemon, REAL chain, NO mocks.
 *
 * The retired version replaced ethers' JsonRpcProvider with a module mock
 * whose getBlockNumber() returned canned numbers/errors keyed by URL, and
 * drove `handleStatusRoutes` through a hand-built ctx. That could not notice
 * a real provider behaviour change (e.g. a different failure shape) and the
 * sanitization was asserted against a fabricated config.
 *
 * This version boots a real edge daemon whose chain config carries TWO RPC
 * endpoints: the shared Hardhat node (primary — genuinely healthy) and a
 * dead localhost port (backup — a genuinely unreachable endpoint, so the
 * failure path is a REAL connection error, not an injected one). The same
 * contracts are then proven over real HTTP:
 *   - /api/status returns the sanitized chain summary (no raw rpcUrl /
 *     rpcUrls / hubAddress leaks),
 *   - /api/chain/rpc-health probes BOTH endpoints, reports the healthy one
 *     with a real block number, the dead one with the sanitized
 *     'RPC health probe failed' error, and never echoes an RPC URL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ChainRpcTransportError,
  noteRpcFailover,
  noteRpcExhaustion,
  notePreferredEndpoint,
  noteRpcServed,
  getRpcFailoverStats,
  _resetRpcFailoverStatsForTest,
} from '@origintrail-official/dkg-chain';
import { computeNetworkId } from '../../core/src/genesis.js';
import { getSharedContext } from '../../chain/test/evm-test-context.js';
import { loadNetworkConfig } from '../src/config.js';
import { handleStatusRoutes } from '../src/daemon/routes/status.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { startLiveDaemon, stopLiveDaemon, authHeaders, type LiveDaemon } from './helpers/live-daemon.js';

// A port nothing listens on — connecting to it is a REAL refused connection.
const DEAD_RPC = 'http://127.0.0.1:9';
const DISABLED_PUBLISHER_STATE: RequestContext['publisherState'] = {
  runtime: null,
  availability: {
    available: false,
    reason: 'publisher_disabled',
    retryable: false,
    operatorActionRequired: true,
  },
};

async function requestStatusWithAgent(
  agentOverrides: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
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
        name: 'status-finalization-recovery-test',
        nodeRole: 'edge',
        chain: { type: 'mock' },
      },
      startedAt: Date.now(),
      agent: {
        peerId: 'peer-status-test',
        multiaddrs: [],
        node: {
          libp2p: { getConnections: () => [] },
          getRelayStats: () => null,
        },
        publisher: { getIdentityId: () => 0n },
        ...agentOverrides,
      },
      nodeVersion: '0.0.0-test',
      nodeCommit: '',
      admission: { inFlight: 0, max: 0, rejectedTotal: 0 },
    } as unknown as RequestContext);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/status`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe('/api/status + /api/chain/rpc-health (real daemon, real chain)', () => {
  let daemon: LiveDaemon;

  beforeAll(async () => {
    const { rpcUrl, hubAddress } = getSharedContext();
    daemon = await startLiveDaemon({
      extraConfig: {
        chain: {
          type: 'evm',
          rpcUrl,
          rpcUrls: [rpcUrl, DEAD_RPC],
          hubAddress,
          chainId: 'evm:31337',
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  it('/api/status returns a sanitized chain summary without raw RPC endpoints', async () => {
    const res = await fetch(`${daemon.base}/api/status`, { headers: authHeaders(daemon) });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.chain).toMatchObject({
      chainId: 'evm:31337',
      configured: true,
      rpcEndpointCount: 2,
      hubConfigured: true,
    });
    expect(body.chain).not.toHaveProperty('rpcUrl');
    expect(body.chain).not.toHaveProperty('rpcUrls');
    expect(body.chain).not.toHaveProperty('hubAddress');
    expect(body.asyncPublisher).toEqual({
      available: false,
      reason: 'publisher_disabled',
      retryable: false,
      operatorActionRequired: true,
    });
    // Multi-RPC failover observability (W3): scalar counts + bounded by-class
    // map only — host-only, never a full RPC URL.
    expect(typeof body.chain.rpcFailovers).toBe('number');
    expect(typeof body.chain.rpcExhaustions).toBe('number');
    expect(body.chain.rpcFailoversByClass).toBeDefined();
    // Success-side per-provider distribution (which endpoint served) — host-only.
    expect(body.chain.rpcServedByEndpointHost).toBeDefined();
    expect(body.chain.rpcFailoversByEndpointHost).toBeDefined();
    expect(JSON.stringify(body.chain)).not.toContain('://');
  });

  it('/api/chain/rpc-health probes both endpoints; real block number, sanitized real failure, no URL echo', async () => {
    const res = await fetch(`${daemon.base}/api/chain/rpc-health`, { headers: authHeaders(daemon) });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.configured).toBe(true);
    expect(body.rpcEndpointCount).toBe(2);
    expect(body).not.toHaveProperty('rpcUrl');
    expect(body).not.toHaveProperty('rpcUrls');

    // Primary = the real Hardhat node: ok with a REAL block number.
    const primary = body.rpcs.find((p: any) => p.role === 'primary');
    expect(primary.ok).toBe(true);
    expect(typeof primary.blockNumber).toBe('number');
    expect(primary.blockNumber).toBeGreaterThanOrEqual(0);

    // Backup = the dead endpoint: a REAL connection failure, sanitized.
    const backup = body.rpcs.find((p: any) => p.role === 'backup');
    expect(backup.ok).toBe(false);
    expect(backup.blockNumber).toBeNull();
    expect(backup.error).toBe('RPC health probe failed');

    // The overall probe is healthy (primary up) and no probe leaks a URL.
    expect(body.ok).toBe(true);
    expect(typeof body.blockNumber).toBe('number');
    for (const probe of body.rpcs) {
      expect(probe).not.toHaveProperty('rpcUrl');
    }
  });
});

describe('/api/status finalization recovery health', () => {
  it('includes the exact operator-facing recovery health block', async () => {
    const finalizationRecovery = {
      available: true,
      closed: false,
      ready: false,
      canonicalReceiptCapability: 'unsupported' as const,
      degradedReason: 'canonical-finalization-receipt-unsupported',
      stateCounts: { RECEIVED: 1 },
      liveEntries: 1,
      livePayloadBytes: 4,
    };

    const response = await requestStatusWithAgent({
      getFinalizationRecoveryHealth: async () => finalizationRecovery,
    });

    expect(response.status).toBe(200);
    expect(response.body.finalizationRecovery).toEqual(finalizationRecovery);
  });

  it('keeps status healthy and degrades recovery when the health read throws', async () => {
    const response = await requestStatusWithAgent({
      getFinalizationRecoveryHealth: async () => {
        throw new Error('finalization inbox health read failed');
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.finalizationRecovery).toEqual({
      available: false,
      closed: false,
      ready: false,
      canonicalReceiptCapability: 'unknown',
      degradedReason: 'finalization inbox health read failed',
      stateCounts: {},
      livePayloadBytes: 0,
    });
  });
});

describe('/api/status selected overlay details', () => {
  it('returns the network id and name for the selected overlay genesis', async () => {
    const network = await loadNetworkConfig('mainnet-gnosis');
    expect(network).not.toBeNull();

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleStatusRoutes({
        req,
        res,
        publisherState: DISABLED_PUBLISHER_STATE,
        path: url.pathname,
        url,
        network,
        config: {
          name: 'status-selected-overlay-test',
          networkConfig: 'mainnet-gnosis',
          nodeRole: 'edge',
          chain: { type: 'mock' },
        },
        startedAt: Date.now(),
        agent: {
          peerId: 'peer-status-test',
          multiaddrs: [],
          node: {
            libp2p: { getConnections: () => [] },
            getRelayStats: () => null,
          },
          publisher: { getIdentityId: () => 0n },
        },
        nodeVersion: '0.0.0-test',
        nodeCommit: '',
        // Read-only admission stats view — the daemon supplies this in prod via
        // handleRequest; stubbed here because this hand-built ctx drives the full
        // /api/status body, which now surfaces the admission block.
        admission: { inFlight: 0, max: 0, rejectedTotal: 0 },
      } as unknown as RequestContext);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${address.port}/api/status`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      const selectedNetworkId = await computeNetworkId('gnosis-mainnet');

      expect(body.networkConfig).toBe('mainnet-gnosis');
      expect(body.networkId).toBe(selectedNetworkId);
      expect(body.networkName).toBe('DKG V10 Gnosis Mainnet');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('surfaces LIVE multi-RPC failover counters on /api/status (not hardcoded zero)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const network = await loadNetworkConfig('mainnet-gnosis');
    try {
      // Seed the process-wide failover counters the status route reads, then
      // assert /api/status reflects the exact delta. This would FAIL if the
      // route hardcoded 0 or read the wrong snapshot fields (relative to a
      // baseline so it is robust to any counts left by earlier in-process tests).
      const before = getRpcFailoverStats();
      noteRpcFailover('status-test publish', 'https://primary.example', { status: 429 }, 'https://backup.example');
      noteRpcFailover('status-test publish', 'https://other.example', { status: 503 }, 'https://backup.example');
      noteRpcExhaustion('status-test publish', ['https://primary.example', 'https://backup.example']);
      notePreferredEndpoint('status-test publish', 'https://backup.example');
      noteRpcServed('status-test read', 'https://served.example/key', { mode: 'read', key: 'status-test-read' });

      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        await handleStatusRoutes({
          req,
          res,
          publisherState: DISABLED_PUBLISHER_STATE,
          path: url.pathname,
          url,
          network,
          config: {
            name: 'status-failover-counter-test',
            networkConfig: 'mainnet-gnosis',
            nodeRole: 'edge',
            chain: {
              type: 'evm',
              rpcUrl: 'http://127.0.0.1:9',
              hubAddress: `0x${'ab'.repeat(20)}`,
              chainId: 'evm:31337',
            },
          },
          startedAt: Date.now(),
          agent: {
            peerId: 'peer-status-test',
            multiaddrs: [],
            node: { libp2p: { getConnections: () => [] }, getRelayStats: () => null },
            publisher: { getIdentityId: () => 0n },
          },
          nodeVersion: '0.0.0-test',
          nodeCommit: '',
          admission: { inFlight: 0, max: 0, rejectedTotal: 0 },
        } as unknown as RequestContext);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${address.port}/api/status`);
        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.chain.rpcFailovers).toBe(before.failovers + 2);
        expect(body.chain.rpcExhaustions).toBe(before.exhaustions + 1);
        expect(body.chain.rpcFailoversByClass.THROTTLE_429).toBe((before.byErrorClass.THROTTLE_429 ?? 0) + 1);
        expect(body.chain.rpcFailoversByClass.SERVER_5XX).toBe((before.byErrorClass.SERVER_5XX ?? 0) + 1);
        expect(body.chain.rpcServedByEndpointHost).toEqual({
          ...before.servedByEndpointHost,
          'served.example': (before.servedByEndpointHost['served.example'] ?? 0) + 1,
        });
        expect(body.chain.rpcFailoversByEndpointHost).toEqual({
          ...before.byEndpointHost,
          'primary.example': (before.byEndpointHost['primary.example'] ?? 0) + 1,
          'other.example': (before.byEndpointHost['other.example'] ?? 0) + 1,
        });
        // Endpoint-stickiness establishment counter is wired through /api/status.
        expect(body.chain.rpcPreferredEstablishments).toBe(before.preferredEstablishments + 1);
        // The counter surface stays host-only — never a raw RPC URL.
        expect(JSON.stringify(body.chain)).not.toContain('://');
      } finally {
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      }
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      _resetRpcFailoverStatsForTest();
    }
  });

  it('POST /api/identity/ensure → 503/504 (sanitized) when on-chain identity creation exhausts RPC', async () => {
    const makeServer = (err: any) => createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleStatusRoutes({
        req,
        res,
        publisherState: DISABLED_PUBLISHER_STATE,
        path: url.pathname,
        url,
        network: null,
        config: {
          name: 'identity-ensure-transport-test',
          nodeRole: 'edge',
          chain: { type: 'evm', rpcUrl: 'http://127.0.0.1:9', hubAddress: `0x${'ab'.repeat(20)}`, chainId: 'evm:31337' },
        },
        startedAt: Date.now(),
        agent: { ensureIdentity: async () => { throw err; } },
        nodeVersion: '0.0.0-test',
        nodeCommit: '',
        admission: { inFlight: 0, max: 0, rejectedTotal: 0 },
      } as unknown as RequestContext);
    });

    const cases = [
      {
        err: Object.assign(
          new Error('ensureProfile failed on all configured RPC endpoints (https://rpc.example/v2/SECRETKEY): boom'),
          { code: 'RPC_ENDPOINTS_EXHAUSTED' },
        ),
        status: 503,
      },
      { err: new ChainRpcTransportError('RPC_TIMEOUT', 'tx 0xabc timed out waiting for a receipt'), status: 504 },
    ];

    for (const { err, status } of cases) {
      const server = makeServer(err);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${address.port}/api/identity/ensure`, { method: 'POST' });
        expect(res.status).toBe(status);
        const body: any = await res.json();
        expect(body.hasIdentity).toBe(false);
        expect(body.identityId).toBe('0');
        if (status === 503) expect(body.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
        // Sanitized — no RPC URL or embedded key leaks.
        expect(JSON.stringify(body)).not.toContain('://');
        expect(JSON.stringify(body)).not.toContain('SECRETKEY');
      } finally {
        await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
      }
    }
  });
});
