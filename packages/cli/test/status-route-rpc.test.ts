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
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import {
  loadNetworkConfig,
  resolveRfc64PublicCatalogActivation,
  resolveRfc64PublicCatalogActivationChainIdentityV1,
} from '../src/config.js';
import {
  buildRfc64CatalogConfigurationEvidenceV1,
  handleStatusRoutes,
} from '../src/daemon/routes/status.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { startLiveDaemon, stopLiveDaemon, authHeaders, type LiveDaemon } from './helpers/live-daemon.js';
import { rfc64PublicCatalogPolicy } from './helpers/rfc64-public-catalog.js';

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
const DISABLED_RFC64_PUBLIC_CATALOG: RequestContext['rfc64PublicCatalog'] = {
  enabled: false,
  selectedContextGraphs: [],
};

async function requestStatusWithAgent(
  agentOverrides: Record<string, unknown>,
  configOverrides: Record<string, unknown> = {},
  requestPath = '/api/status',
  networkOverride: RequestContext['network'] = null,
  rfc64CatalogOverride?: RequestContext['rfc64Catalog'],
): Promise<{ status: number; body: any }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const config = {
      name: 'status-finalization-recovery-test',
      nodeRole: 'edge',
      chain: { type: 'mock' },
      ...configOverrides,
    };
    await handleStatusRoutes({
      req,
      res,
      publisherState: DISABLED_PUBLISHER_STATE,
      path: url.pathname,
      url,
      network: networkOverride,
      config,
      rfc64PublicCatalog: resolveRfc64PublicCatalogActivation(
        config as never,
        resolveRfc64PublicCatalogActivationChainIdentityV1('otp:20430'),
      ),
      ...(rfc64CatalogOverride === undefined
        ? {}
        : { rfc64Catalog: rfc64CatalogOverride }),
      startedAt: Date.now(),
      agent: {
        peerId: 'peer-status-test',
        multiaddrs: [],
        node: {
          libp2p: { getConnections: () => [] },
          getRelayStats: () => null,
        },
        publisher: { getIdentityId: () => 0n },
        getSyncContextGraphIds: () => [],
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
    const response = await fetch(`http://127.0.0.1:${address.port}${requestPath}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe('/api/status RFC-64 private recovery privacy', () => {
  it('projects live mixed edge selection without leaking private ids into public status', async () => {
    const publicContextGraph = 'runtime-selected-public';
    const privateContextGraph =
      '0x1111111111111111111111111111111111111111/runtime-selected-private';
    const response = await requestStatusWithAgent(
      {
        readRfc64CatalogRuntimeSelectionV1: () => ({
          subscriptionDriven: true,
          eligibleContextGraphs: [publicContextGraph, privateContextGraph],
          selectedContextGraphs: [privateContextGraph],
        }),
        readRfc64CatalogResponsibilitiesV1: () => [{
          contextGraphId: privateContextGraph,
          responsible: true,
          responsibilityReason: 'private-membership',
          active: true,
          mode: 'catalog',
          selectionSource: 'default',
        }],
        readRfc64CatalogOperationalStatusV1: async () => [{
          contextGraphId: privateContextGraph,
          responsibilityReason: 'private-membership',
          selectionSource: 'default',
          effectiveMode: 'catalog',
          phase: 'bootstrapping',
          authorityState: 'accepted',
          policySource: 'owner-signed-unregistered',
        }],
      },
      {
        rfc64PublicCatalog: {
          enabled: true,
          bootstrap: {
            acceptedPublicPolicies: [rfc64PublicCatalogPolicy(publicContextGraph)],
          },
        },
      },
      '/api/status',
      null,
      {
        enabled: true,
        selectedContextGraphs: [publicContextGraph, privateContextGraph],
        selectedPublicContextGraphs: [publicContextGraph],
        selectedPrivateContextGraphs: [privateContextGraph],
        rollout: {
          killSwitch: false,
          contextGraphModes: {
            [publicContextGraph]: 'catalog',
            [privateContextGraph]: 'catalog',
          },
        },
      } as never,
    );

    expect(response.status).toBe(200);
    expect(response.body.rfc64Catalog.runtimeSelection).toEqual({
      subscriptionDriven: true,
      eligibleContextGraphs: [publicContextGraph, privateContextGraph],
      selectedContextGraphs: [privateContextGraph],
    });
    expect(response.body.rfc64Catalog.responsibilities).toEqual([{
      contextGraphId: privateContextGraph,
      responsible: true,
      responsibilityReason: 'private-membership',
      active: true,
      mode: 'catalog',
      selectionSource: 'default',
    }]);
    expect(response.body.rfc64Catalog.contextGraphs).toEqual([expect.objectContaining({
      contextGraphId: privateContextGraph,
      responsibilityReason: 'private-membership',
      selectionSource: 'default',
      effectiveMode: 'catalog',
      phase: 'bootstrapping',
      authorityState: 'accepted',
    })]);
    expect(response.body.rfc64Catalog.configuration).toMatchObject({
      schemaVersion: 1,
      source: 'compatibility-seed',
      catalogControlPresent: false,
      deprecatedPublicControlPresent: true,
      activationManifestPresent: true,
      deprecatedDisabledOverride: false,
      killSwitch: false,
    });
    expect(response.body.rfc64Catalog.configuration.digest)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(response.body.rfc64PublicCatalog.runtimeSelection).toEqual({
      subscriptionDriven: true,
      selectedContextGraphs: [],
    });
    expect(response.body.rfc64PublicCatalog.responsibilities).toBeUndefined();
  });

  it('attests rollback configuration without exposing private CG identifiers', () => {
    const privateContextGraph =
      '0x1111111111111111111111111111111111111111/private-config-evidence';
    const evidence = buildRfc64CatalogConfigurationEvidenceV1({
      rfc64Catalog: {
        rollout: { contextGraphModes: { [privateContextGraph]: 'legacy' } },
      },
    }, {
      killSwitch: false,
      contextGraphModes: { [privateContextGraph]: 'legacy' },
    });

    expect(evidence).toMatchObject({
      source: 'operator-override',
      catalogControlPresent: true,
      activationManifestPresent: false,
      legacyOverrideCount: 1,
      shadowOverrideCount: 0,
    });
    expect(JSON.stringify(evidence)).not.toContain(privateContextGraph);

    expect(buildRfc64CatalogConfigurationEvidenceV1({}, {
      killSwitch: false,
      contextGraphModes: {},
    })).toMatchObject({
      source: 'default-omitted',
      catalogControlPresent: false,
      deprecatedPublicControlPresent: false,
      activationManifestPresent: false,
      deprecatedDisabledOverride: false,
      legacyOverrideCount: 0,
      shadowOverrideCount: 0,
    });
  });

  it('reports aggregate telemetry for a private-only catalog activation', async () => {
    const privateContextGraph =
      '0x1111111111111111111111111111111111111111/private-only-telemetry';
    const response = await requestStatusWithAgent(
      {
        rfc64PublicCatalogStatsV1: () => ({
          started: true,
          acceptedPolicies: 1,
          receiver: {
            providerAttempts: 2,
            providerSwitches: 1,
            providerSuccesses: 1,
            providerBackoffMs: 4,
          },
          nativeReceiver: {
            controlObjectCacheHits: 3,
            controlObjectNetworkFetches: 5,
            kaBundleCacheHits: 7,
            kaBundleNetworkFetches: 11,
            kaBundleCacheBytes: 13,
            kaBundleNetworkBytes: 17,
          },
        }),
      },
      {},
      '/api/status',
      null,
      {
        enabled: true,
        selectedContextGraphs: [privateContextGraph],
        selectedPublicContextGraphs: [],
        selectedPrivateContextGraphs: [privateContextGraph],
        accessPolicyAuthority: {
          localAgentAddress: '0x3333333333333333333333333333333333333333',
          peerAgentBindings: [],
        },
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000',
        },
      } as never,
    );

    expect(response.status).toBe(200);
    expect(response.body.rfc64PublicCatalog.enabled).toBe(false);
    expect(response.body.rfc64Catalog.autoPublishEnabled).toBe(true);
    expect(response.body.rfc64Catalog.resourceTelemetry).toEqual({
      providerAttempts: 2,
      providerSwitches: 1,
      providerSuccesses: 1,
      providerBackoffMs: 4,
      controlObjectCacheHits: 3,
      controlObjectNetworkFetches: 5,
      kaBundleCacheHits: 7,
      kaBundleNetworkFetches: 11,
      kaBundleCacheBytes: 13,
      kaBundleNetworkBytes: 17,
    });
    expect(JSON.stringify(response.body)).not.toContain('peerAgentBindings');
  });

  it('reports only aggregate private recovery state and hides provider identities', async () => {
    const privateContextGraph =
      '0x1111111111111111111111111111111111111111/private-release-2';
    const privateProvider = '12D3KooPrivateProviderMustNotLeak';
    const publicContextGraph = 'public-compatibility-surface';
    const publicProvider = '12D3KooPublicProviderMayAppear';
    const response = await requestStatusWithAgent(
      {
        rfc64PublicCatalogStatsV1: () => ({
          started: true,
          acceptedPolicies: 1,
          receiver: {
            providerAttempts: 3,
            providerSwitches: 1,
            providerSuccesses: 1,
            providerBackoffMs: 20,
          },
          nativeReceiver: {
            controlObjectCacheHits: 4,
            controlObjectNetworkFetches: 5,
            kaBundleCacheHits: 6,
            kaBundleNetworkFetches: 7,
            kaBundleCacheBytes: 800,
            kaBundleNetworkBytes: 900,
          },
        }),
        readRfc64PublicCatalogBootstrapStatusV1: () => ({
          running: false,
          pass: 1,
          retryIntervalMs: 1_000,
          lastPassStartedAtMs: 1,
          lastPassCompletedAtMs: 2,
          targets: [{
            scope: {
              networkId: 'otp:20430',
              contextGraphId: privateContextGraph,
              subGraphName: null,
              authorAddress: '0x2222222222222222222222222222222222222222',
              catalogEra: '0',
            },
            providers: [privateProvider],
            outcome: 'known-incomplete',
            completionReason: 'no-authorized-provider',
            attempts: 1,
            providerPeerId: privateProvider,
            appliedHeadDigest: null,
            catalogVersion: null,
            inventoryRowCount: null,
            lastError: `provider ${privateProvider} failed`,
            updatedAtMs: 2,
          }, {
            scope: {
              networkId: 'otp:20430',
              contextGraphId: publicContextGraph,
              subGraphName: null,
              authorAddress: '0x4444444444444444444444444444444444444444',
              catalogEra: '0',
            },
            providers: [publicProvider],
            outcome: 'applied',
            completionReason: null,
            attempts: 1,
            providerPeerId: publicProvider,
            appliedHeadDigest: `0x${'55'.repeat(32)}`,
            catalogVersion: '1',
            inventoryRowCount: '1',
            lastError: null,
            updatedAtMs: 2,
          }],
        }),
      },
      {
        rfc64PublicCatalog: {
          enabled: true,
          bootstrap: {
            acceptedPublicPolicies: [rfc64PublicCatalogPolicy(publicContextGraph)],
          },
        },
      },
      '/api/status',
      null,
      {
        enabled: true,
        selectedContextGraphs: [publicContextGraph, privateContextGraph],
        selectedPublicContextGraphs: [publicContextGraph],
        selectedPrivateContextGraphs: [privateContextGraph],
        accessPolicyAuthority: {
          localAgentAddress: '0x3333333333333333333333333333333333333333',
          peerAgentBindings: [],
        },
        rollout: {
          killSwitch: true,
          contextGraphModes: {
            [publicContextGraph]: 'shadow',
            [privateContextGraph]: 'legacy',
          },
        },
        bootstrap: {
          acceptedPolicies: [rfc64PublicCatalogPolicy(publicContextGraph), {
            policyEnvelope: {
              payload: {
                contextGraphId: privateContextGraph,
                accessPolicy: 1,
                publishPolicy: 1,
                source: { kind: 'finalized-chain' },
              },
            },
          }],
        },
      } as never,
    );

    expect(response.status).toBe(200);
    expect(response.body.rfc64Catalog.privateRecovery).toEqual([{
      contextGraphId: privateContextGraph,
      mode: 'legacy',
      accessPolicy: 1,
      publishPolicy: 1,
      vmRequired: true,
      targetCount: 1,
      outcomeCounts: { 'known-incomplete': 1 },
      completionReasons: ['no-authorized-provider'],
    }]);
    expect(response.body.rfc64Catalog.resourceTelemetry).toEqual({
      providerAttempts: 3,
      providerSwitches: 1,
      providerSuccesses: 1,
      providerBackoffMs: 20,
      controlObjectCacheHits: 4,
      controlObjectNetworkFetches: 5,
      kaBundleCacheHits: 6,
      kaBundleNetworkFetches: 7,
      kaBundleCacheBytes: 800,
      kaBundleNetworkBytes: 900,
    });
    expect(response.body.rfc64PublicCatalog.bootstrap.targets).toHaveLength(1);
    expect(response.body.rfc64PublicCatalog.bootstrap.targets[0]).toMatchObject({
      scope: { contextGraphId: publicContextGraph },
      providers: [publicProvider],
      providerPeerId: publicProvider,
    });
    expect(response.body.rfc64Catalog.rollout).toEqual({
      killSwitch: true,
      contextGraphModes: {
        [publicContextGraph]: 'shadow',
        [privateContextGraph]: 'legacy',
      },
    });
    expect(JSON.stringify(response.body)).toContain(publicProvider);
    expect(JSON.stringify(response.body)).not.toContain(privateProvider);
  });
});

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

describe('/api/status effective sync lifecycle switches', () => {
  it('surfaces the configured reconciler switch', async () => {
    const response = await requestStatusWithAgent(
      {},
      { syncReconcilerEnabled: false },
    );

    expect(response.status).toBe(200);
    expect(response.body.syncLifecycle).toEqual({
      syncReconcilerEnabled: false,
    });
  });

  it('surfaces the environment override that runtime actually honors', async () => {
    const previous = process.env.DKG_SYNC_RECONCILER_ENABLED;
    process.env.DKG_SYNC_RECONCILER_ENABLED = 'true';
    try {
      const response = await requestStatusWithAgent(
        {},
        { syncReconcilerEnabled: false },
      );

      expect(response.status).toBe(200);
      expect(response.body.syncLifecycle).toEqual({
        syncReconcilerEnabled: true,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.DKG_SYNC_RECONCILER_ENABLED;
      } else {
        process.env.DKG_SYNC_RECONCILER_ENABLED = previous;
      }
    }
  });
});

describe('daemon subscription rehydration lifecycle', () => {
  it('honors the environment kill-switch through real startup and leaves durable rows dormant', async () => {
    const contextGraphId = 'persisted-user-context-graph';
    let daemon: LiveDaemon | undefined;

    try {
      daemon = await startLiveDaemon({
        extraConfig: {
          chain: { type: 'mock' },
          contextGraphSubscriptionRehydrationEnabled: true,
        },
        env: {
          DKG_CONTEXT_GRAPH_SUBSCRIPTION_REHYDRATION_ENABLED: 'false',
        },
        prepareHome: async (home) => {
          const db = new DashboardDB({ dataDir: home });
          try {
            db.upsertContextGraphSubscription({
              context_graph_id: contextGraphId,
              name: 'Persisted user Context Graph',
              subscribed: 1,
              synced: 1,
              shared_memory_synced: 1,
              meta_synced: 1,
              sync_scoped: 1,
              updated_at: 1_700_000_000_000,
            });
          } finally {
            db.close();
          }
        },
      });

      const response = await fetch(`${daemon.base}/api/context-graph/subscriptions`, {
        headers: authHeaders(daemon),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        count: 0,
        subscriptions: [],
        rehydration: {
          rehydrationEnabled: false,
          persistedTotal: 1,
          hostedActivated: 0,
          activated: 0,
          dormant: 1,
          dormantIds: [contextGraphId],
        },
      });

      // The daemon must only suppress live activation. The operator's durable
      // intent remains byte-for-byte meaningful for a later enabled restart.
      const db = new DashboardDB({ dataDir: daemon.home });
      try {
        expect(db.getContextGraphSubscription(contextGraphId)).toMatchObject({
          context_graph_id: contextGraphId,
          name: 'Persisted user Context Graph',
          subscribed: 1,
          synced: 1,
          shared_memory_synced: 1,
          meta_synced: 1,
          sync_scoped: 1,
        });
      } finally {
        db.close();
      }
    } finally {
      await stopLiveDaemon(daemon);
    }
  }, 120_000);
});

describe('/api/info chain sanitization', () => {
  it('never serializes configured RPC endpoint credentials when API auth is disabled', async () => {
    const credentialSentinel = 'UNIT_TEST_RPC_CREDENTIAL_MUST_NOT_LEAK';
    const response = await requestStatusWithAgent(
      {},
      {
        auth: { enabled: false },
        chain: {
          type: 'evm',
          rpcUrl: `https://tenant:${credentialSentinel}@primary.invalid/v1/${credentialSentinel}`,
          rpcUrls: [`https://backup.invalid/rpc?token=${credentialSentinel}`],
          hubAddress: `0x${'11'.repeat(20)}`,
          chainId: 'base:84532',
        },
      },
      '/api/info',
    );

    expect(response.status).toBe(200);
    expect(response.body.auth).toBe(false);
    expect(response.body.chain).toEqual({
      chainId: 'base:84532',
      configured: true,
      rpcEndpointCount: 2,
      hubConfigured: true,
      rpcUrl: null,
      rpcUrls: [],
      hubAddress: `0x${'11'.repeat(20)}`,
      rpcEndpointsRedacted: true,
    });
    expect(JSON.stringify(response.body)).not.toContain(credentialSentinel);
    expect(JSON.stringify(response.body.chain)).not.toContain('://');
  });

  it('retains the legacy chain keys while making endpoint redaction explicit', async () => {
    const response = await requestStatusWithAgent(
      {},
      {
        auth: { enabled: true },
        chain: {
          type: 'evm',
          rpcUrl: 'https://primary.invalid/operator-secret',
          rpcUrls: ['https://backup.invalid/operator-secret'],
          hubAddress: `0x${'22'.repeat(20)}`,
          chainId: 'base:84532',
        },
      },
      '/api/info',
    );

    expect(response.status).toBe(200);
    expect(response.body.chain).toMatchObject({
      rpcUrl: null,
      rpcUrls: [],
      hubAddress: `0x${'22'.repeat(20)}`,
      rpcEndpointsRedacted: true,
      rpcEndpointCount: 2,
    });
    expect(JSON.stringify(response.body)).not.toContain('operator-secret');
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
      dueEntries: 1,
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
      dueEntries: 0,
    });
  });
});

describe('/api/status RFC-64 selected-public activation', () => {
  it('reports RFC-64 selected public scheduling as the default for explicit subscriptions', async () => {
    const response = await requestStatusWithAgent({
      // Runtime subscribe mutates the agent scope, not the startup CLI config.
      getSyncContextGraphIds: () => ['explicit-public-cg'],
    });

    expect(response.status).toBe(200);
    expect(response.body.rfc64SelectedPublicSync).toEqual({
      defaultEnabled: true,
      requestedContextGraphs: ['explicit-public-cg'],
      catalogBackedContextGraphs: [],
    });
  });

  it('reports mixed requested scopes without classifying a network-default graph as public', async () => {
    const response = await requestStatusWithAgent(
      { getSyncContextGraphIds: () => ['explicit-public-cg'] },
      {},
      '/api/status',
      { defaultContextGraphs: ['private-network-default-cg', 'explicit-public-cg'] } as never,
    );

    expect(response.status).toBe(200);
    expect(response.body.rfc64SelectedPublicSync).toEqual({
      defaultEnabled: true,
      requestedContextGraphs: ['explicit-public-cg', 'private-network-default-cg'],
      catalogBackedContextGraphs: [],
    });
  });

  it('reports the fail-closed disabled state without invoking catalog controls', async () => {
    const catalogStats = vi.fn(() => {
      throw new Error('disabled status must not read catalog service state');
    });
    const bootstrapStatus = vi.fn(() => {
      throw new Error('disabled status must not read catalog bootstrap state');
    });
    const response = await requestStatusWithAgent({
      rfc64PublicCatalogStatsV1: catalogStats,
      readRfc64PublicCatalogBootstrapStatusV1: bootstrapStatus,
    });

    expect(response.status).toBe(200);
    expect(response.body.rfc64PublicCatalog).toEqual({
      enabled: false,
      selectedContextGraphs: [],
      runtimeSelection: { subscriptionDriven: false, selectedContextGraphs: [] },
      rollout: { killSwitch: false, contextGraphModes: {} },
      autoPublishEnabled: false,
      completeSwmProviders: [],
      service: null,
      bootstrap: null,
    });
    expect(catalogStats).not.toHaveBeenCalled();
    expect(bootstrapStatus).not.toHaveBeenCalled();
  });

  it('exposes selected scopes and exact per-target applied-head evidence', async () => {
    const service = {
      started: true,
      acceptedPolicies: 1,
      receiver: { queued: 0, applied: 1, failed: 0 },
    };
    const bootstrap = {
      running: false,
      pass: 2,
      retryIntervalMs: 30_000,
      targets: [{
        scope: { contextGraphId: 'selected-public-cg', authorAddress: `0x${'22'.repeat(20)}` },
        outcome: 'applied',
        appliedHeadDigest: `0x${'33'.repeat(32)}`,
        inventoryRowCount: '50',
      }],
    };
    const response = await requestStatusWithAgent(
      {
        rfc64PublicCatalogStatsV1: () => service,
        readRfc64PublicCatalogBootstrapStatusV1: () => bootstrap,
        getSyncContextGraphIds: () => ['selected-public-cg'],
      },
      {
        rfc64PublicCatalog: {
          enabled: true,
          rollout: {
            killSwitch: true,
            contextGraphModes: { 'selected-public-cg': 'shadow' },
          },
          autoPublish: {
            peers: ['12D3KooReceiver'],
            catalogIssuerDelegationExpiresAt: '1893456000000',
          },
          bootstrap: {
            acceptedPublicPolicies: [{
              ...rfc64PublicCatalogPolicy('selected-public-cg'),
              completeSwmProviders: ['12D3KooCompleteSwm'],
            }],
          },
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.rfc64PublicCatalog).toEqual({
      enabled: true,
      selectedContextGraphs: ['selected-public-cg'],
      runtimeSelection: {
        subscriptionDriven: false,
        selectedContextGraphs: ['selected-public-cg'],
      },
      rollout: {
        killSwitch: true,
        contextGraphModes: { 'selected-public-cg': 'shadow' },
      },
      autoPublishEnabled: true,
      completeSwmProviders: [{
        contextGraphId: 'selected-public-cg',
        accessPolicy: 0,
        publishPolicy: 1,
        providers: ['12D3KooCompleteSwm'],
      }],
      service,
      bootstrap,
    });
    expect(response.body.rfc64SelectedPublicSync).toEqual({
      defaultEnabled: true,
      requestedContextGraphs: ['selected-public-cg'],
      catalogBackedContextGraphs: ['selected-public-cg'],
    });
  });

  it('reports receiver-only activation without claiming auto-publish is enabled', async () => {
    const bootstrap = {
      running: true,
      pass: 1,
      retryIntervalMs: 30_000,
      targets: [],
    };
    const response = await requestStatusWithAgent(
      {
        rfc64PublicCatalogStatsV1: () => ({ started: true }),
        readRfc64PublicCatalogBootstrapStatusV1: () => bootstrap,
      },
      {
        rfc64PublicCatalog: {
          enabled: true,
          bootstrap: {
            acceptedPublicPolicies: [rfc64PublicCatalogPolicy('receiver-only-cg')],
          },
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.rfc64PublicCatalog).toMatchObject({
      enabled: true,
      selectedContextGraphs: ['receiver-only-cg'],
      autoPublishEnabled: false,
      completeSwmProviders: [],
      bootstrap,
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
        rfc64PublicCatalog: DISABLED_RFC64_PUBLIC_CATALOG,
        startedAt: Date.now(),
        agent: {
          peerId: 'peer-status-test',
          multiaddrs: [],
          getSyncContextGraphIds: () => [],
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
          rfc64PublicCatalog: DISABLED_RFC64_PUBLIC_CATALOG,
          startedAt: Date.now(),
          agent: {
            peerId: 'peer-status-test',
            multiaddrs: [],
            getSyncContextGraphIds: () => [],
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
        rfc64PublicCatalog: DISABLED_RFC64_PUBLIC_CATALOG,
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
