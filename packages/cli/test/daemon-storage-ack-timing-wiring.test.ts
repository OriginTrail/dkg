import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  MEMBER_ROSTER_OBJECT_TYPE_V1,
  computeContextGraphPolicyObjectDigestV1,
} from '@origintrail-official/dkg-core';
import { rfc64PublicCatalogPolicy } from './helpers/rfc64-public-catalog.js';
import {
  SyncSemanticStoreV1,
  SyncSharedProjectionStoreV1,
  asChangelogReader,
  createManagedOxigraphRuntimeStoreConfigV1,
  createTripleStore,
} from '@origintrail-official/dkg-storage';

const PRIVATE_RFC64_CONTEXT_GRAPH =
  '0x1111111111111111111111111111111111111111/private-daemon-wiring';
const PRIVATE_RFC64_OWNER = '0x1111111111111111111111111111111111111111';
const PRIVATE_RFC64_LOCAL = '0x2222222222222222222222222222222222222222';
const PRIVATE_RFC64_PROVIDER = '0x3333333333333333333333333333333333333333';
const PRIVATE_RFC64_PROVIDER_PEER = '12D3KooPrivateDaemonProvider';

function rfc64PrivateCatalogActivation() {
  const policyEnvelope = {
    issuer: PRIVATE_RFC64_OWNER,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: {
      networkId: 'evm:100',
      contextGraphId: PRIVATE_RFC64_CONTEXT_GRAPH,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      era: '0',
      version: '0',
      previousPolicyDigest: null,
      accessPolicy: 1,
      publishPolicy: 1,
      publishAuthority: null,
      publishAuthorityAccountId: '0',
      projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
      administrativeDelegationDigest: null,
      source: {
        kind: 'owner-signed-unregistered',
        ownerAddress: PRIVATE_RFC64_OWNER,
        ownerAuthorityEra: '0',
      },
      effectiveAt: '0',
      issuedAt: '0',
    },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as const;
  const rosterEnvelope = {
    issuer: PRIVATE_RFC64_OWNER,
    objectType: MEMBER_ROSTER_OBJECT_TYPE_V1,
    payload: {
      networkId: 'evm:100',
      contextGraphId: PRIVATE_RFC64_CONTEXT_GRAPH,
      ownershipTransitionDigest: null,
      era: '0',
      version: '0',
      previousRosterDigest: null,
      policyDigest: computeContextGraphPolicyObjectDigestV1(policyEnvelope),
      administrativeDelegationDigest: null,
      members: [
        { agentAddress: PRIVATE_RFC64_LOCAL, roles: ['holder'] },
        { agentAddress: PRIVATE_RFC64_PROVIDER, roles: ['holder', 'provider'] },
      ],
      issuedAt: '0',
    },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as const;
  return {
    bootstrap: {
      acceptedPolicies: [{
        policyEnvelope,
        rosterEnvelope,
        targets: [{
          authorAddress: PRIVATE_RFC64_PROVIDER,
          providers: [PRIVATE_RFC64_PROVIDER_PEER],
        }],
        completeSwmProviders: [PRIVATE_RFC64_PROVIDER_PEER],
      }],
    },
    accessPolicyAuthority: {
      localAgentAddress: PRIVATE_RFC64_LOCAL,
      peerAgentBindings: [{
        peerId: PRIVATE_RFC64_PROVIDER_PEER,
        agentAddress: PRIVATE_RFC64_PROVIDER,
      }],
    },
  };
}

const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  chainResetWipe: vi.fn(),
  createServer: vi.fn(),
  checkExternalStoreReachable: vi.fn(),
  checkOrSetStoreIdentity: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
  startPublisherRuntimeWithOutcome: vi.fn(),
  startManagedOxigraph: vi.fn(),
}));

vi.mock('node:http', () => ({
  createServer: mocks.createServer,
}));

vi.mock('@origintrail-official/dkg-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-agent')>();
  return {
    ...actual,
    DKGAgent: { create: mocks.agentCreate },
    loadOpWallets: mocks.loadOpWallets,
    KaNumberAllocator: class KaNumberAllocator {},
  };
});

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadNetworkConfig: mocks.loadNetworkConfig,
  };
});

vi.mock('../src/daemon/chain-reset-wipe.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/chain-reset-wipe.js')>();
  return {
    ...actual,
    chainResetWipe: mocks.chainResetWipe,
  };
});

vi.mock('../src/daemon/oxigraph-managed.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/oxigraph-managed.js')>();
  return { ...actual, startManagedOxigraph: mocks.startManagedOxigraph };
});

vi.mock('../src/daemon/store-health-check.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/store-health-check.js')>();
  return {
    ...actual,
    checkExternalStoreReachable: mocks.checkExternalStoreReachable,
    checkOrSetStoreIdentity: mocks.checkOrSetStoreIdentity,
  };
});

vi.mock('../src/publisher-runner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/publisher-runner.js')>();
  return {
    ...actual,
    startPublisherRuntimeWithOutcome: mocks.startPublisherRuntimeWithOutcome,
  };
});

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');

function createFakeServer() {
  const server = {
    listen: vi.fn((_port: number, _host: string, cb?: () => void) => {
      cb?.();
      return server;
    }),
    address: vi.fn(() => ({ port: 43123 })),
    close: vi.fn((cb?: () => void) => {
      cb?.();
      return server;
    }),
    on: vi.fn(() => server),
    once: vi.fn(() => server),
  };
  return server;
}

function closeDashboardDbFromAgentCreateArg(createArg: any): void {
  const db =
    createArg?.chainEventCursorStore?.cursors?.db ??
    createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
  db?.close?.();
}

describe('runDaemonInner StorageACK timing wiring', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let stdoutWrite: typeof process.stdout.write = process.stdout.write;
  let stderrWrite: typeof process.stderr.write = process.stderr.write;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  let exitListeners: NodeJS.ExitListener[] = [];
  let sigintListeners: NodeJS.SignalsListener[] = [];
  let sigtermListeners: NodeJS.SignalsListener[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-storage-ack-timing-wiring-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];
    exitListeners = process.listeners('exit') as NodeJS.ExitListener[];
    sigintListeners = process.listeners('SIGINT') as NodeJS.SignalsListener[];
    sigtermListeners = process.listeners('SIGTERM') as NodeJS.SignalsListener[];

    mocks.createServer.mockImplementation(createFakeServer);
    mocks.startPublisherRuntimeWithOutcome.mockResolvedValue({
      runtime: null,
      availability: {
        available: false,
        reason: 'no_publisher_wallets',
        retryable: false,
        operatorActionRequired: true,
      },
    });
    mocks.startManagedOxigraph.mockResolvedValue(null);
    mocks.checkExternalStoreReachable.mockResolvedValue({
      ok: true,
      backend: 'sparql-http',
      endpoint: 'http://127.0.0.1:7878/query',
    });
    mocks.checkOrSetStoreIdentity.mockResolvedValue({
      ok: true,
      action: 'matched',
      nodeName: 'storage-ack-timing-core-test',
    });
    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: ['/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M'],
      defaultNodeRole: 'core',
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    mocks.chainResetWipe.mockResolvedValue({
      wiped: false,
      skipped: false,
      prevMarker: null,
      removedFiles: [],
      backedUpFiles: [],
      failedFiles: [],
    });
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.removeAllListeners('uncaughtException');
    for (const listener of uncaughtExceptionListeners) process.on('uncaughtException', listener);
    process.removeAllListeners('unhandledRejection');
    for (const listener of unhandledRejectionListeners) process.on('unhandledRejection', listener);
    process.removeAllListeners('exit');
    for (const listener of exitListeners) process.on('exit', listener);
    process.removeAllListeners('SIGINT');
    for (const listener of sigintListeners) process.on('SIGINT', listener);
    process.removeAllListeners('SIGTERM');
    for (const listener of sigtermListeners) process.on('SIGTERM', listener);
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    if (tempHome) await rm(tempHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
    tempHome = undefined;
  });

  async function captureCreateArg(
    configOverrides: Record<string, unknown> = {},
    inspectDuringCreate?: (createArg: any) => Promise<void>,
  ): Promise<any> {
    if (inspectDuringCreate) {
      mocks.agentCreate.mockImplementationOnce(async (createArg: any) => {
        await inspectDuringCreate(createArg);
        throw new Error('after-agent-create');
      });
    }
    await expect(runDaemonInner(true, {
      name: 'storage-ack-timing-core-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'core',
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
        receiptTimeoutMs: 1_200_000,
      },
      ...configOverrides,
    } as any, Date.now())).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    closeDashboardDbFromAgentCreateArg(createArg);
    return createArg;
  }

  it('round-trips deployment-scoped selected VM cursors through the daemon DashboardDB wiring', async () => {
    const record = {
      deploymentId: 'evm:100:hub=0x1234567890123456789012345678901234567890',
      contextGraphId: 'rfc64-selected-daemon-wiring',
      onChainContextGraphId: '298',
      nameHash: `0x${'ab'.repeat(32)}`,
      watermark: 47,
    };

    await captureCreateArg({}, async (createArg) => {
      const store = createArg.selectedVmReconcileCursorStore;
      expect(store).toBeDefined();
      await store.saveSelectedVmReconcileCursor(record);
      await expect(store.loadSelectedVmReconcileCursor(
        record.deploymentId,
        record.contextGraphId,
        record.onChainContextGraphId,
      )).resolves.toEqual(record);
      await expect(store.loadSelectedVmReconcileCursor(
        `${record.deploymentId}:other`,
        record.contextGraphId,
        record.onChainContextGraphId,
      )).resolves.toBeNull();
    });
  });

  it('passes resolved default StorageACK timing into DKGAgent.create when config is unset', async () => {
    const createArg = await captureCreateArg();

    expect(createArg.storageAckTiming).toEqual({
      handlerDeadlineMs: 15_000,
      sendTimeoutMs: 20_000,
      maxConcurrentCollections: 1,
    });
    expect(createArg.chainConfig).toMatchObject({
      rpcUrl: 'https://private-rpc.example',
      hubAddress: '0x1234567890123456789012345678901234567890',
      receiptTimeoutMs: 1_200_000,
    });
  });

  it.each([false, true])(
    'preserves managed RFC-64 store authority through DKGAgent.create when changelog=%s',
    async (changelog) => {
      const managedStore = createManagedOxigraphRuntimeStoreConfigV1({
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://127.0.0.1:7878/query',
          updateEndpoint: 'http://127.0.0.1:7878/update',
          managedByDkg: true,
        },
        graphSetIndex: true,
      });
      mocks.startManagedOxigraph.mockResolvedValue({
        handle: {
          queryEndpoint: 'http://127.0.0.1:7878/query',
          updateEndpoint: 'http://127.0.0.1:7878/update',
          getRecoveryState: () => ({ recovering: false }),
          killSync: vi.fn(),
        },
        storeConfig: managedStore,
        largeLiteralStorage: {
          enabled: true,
          directory: join(tempHome!, 'literal-blobs'),
        },
      });

      const createArg = await captureCreateArg({
        store: {
          backend: 'oxigraph-server',
          options: {},
          changelog,
        },
      });
      const store = await createTripleStore(createArg.storeConfig);
      try {
        expect(() => new SyncSharedProjectionStoreV1(store)).not.toThrow();
        expect(() => new SyncSemanticStoreV1(store)).not.toThrow();
        expect(asChangelogReader(store) !== null).toBe(changelog);
      } finally {
        await store.close();
      }
    },
  );

  it('merges configured and network-default context graphs into the automatic sync scope', async () => {
    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: ['/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M'],
      defaultNodeRole: 'core',
      defaultContextGraphs: ['network-default-cg', 'shared-default-cg'],
    });

    const createArg = await captureCreateArg({
      contextGraphs: ['configured-cg', 'shared-default-cg'],
    });

    expect(createArg.syncContextGraphs).toEqual([
      'configured-cg',
      'shared-default-cg',
      'network-default-cg',
    ]);
  });

  it('activates only manifest-selected RFC-64 public CGs and forwards the exact controls', async () => {
    const deploymentProfile = {
      networkId: 'evm:100',
      assertedAtChainId: '100',
      assertedAtKav10Address: `0x${'11'.repeat(20)}`,
    };
    const bootstrap = {
      acceptedPublicPolicies: [
        rfc64PublicCatalogPolicy('rfc64-selected-a', 'evm:100'),
        rfc64PublicCatalogPolicy('rfc64-selected-b', 'evm:100'),
      ],
      retryIntervalMs: 30_000,
    };
    const createArg = await captureCreateArg({
      contextGraphs: ['ordinary-selection'],
      rfc64PublicCatalog: {
        enabled: true,
        deploymentProfile,
        autoPublish: {
          peers: ['12D3KooReceiver'],
          catalogIssuerDelegationExpiresAt: '1893456000000',
        },
        bootstrap,
      },
    });

    expect(createArg.syncContextGraphs).toEqual([
      'ordinary-selection',
      'rfc64-selected-a',
      'rfc64-selected-b',
    ]);
    expect(createArg.rfc64PublicCatalogActivation).toMatchObject({
      enabled: true,
      deploymentProfile,
      autoPublish: {
        peers: ['12D3KooReceiver'],
        catalogIssuerDelegationExpiresAt: '1893456000000',
      },
      bootstrap,
    });
    expect(createArg.rfc64CatalogDeploymentProfile).toBeUndefined();
    expect(createArg.rfc64PublicCatalogAutoPublish).toBeUndefined();
    expect(createArg.rfc64PublicCatalogBootstrap).toBeUndefined();
  });

  it('keeps a private-only RFC-64 catalog selection out of generic sync wiring', async () => {
    const rfc64Catalog = rfc64PrivateCatalogActivation();
    const createArg = await captureCreateArg({
      contextGraphs: ['legacy-explicit-cg'],
      rfc64Catalog,
    });

    expect(createArg.syncContextGraphs).toEqual(['legacy-explicit-cg']);
    expect(createArg.syncContextGraphs).not.toContain(PRIVATE_RFC64_CONTEXT_GRAPH);
    expect(createArg.rfc64CatalogActivation).toEqual(rfc64Catalog);
  });

  it('keeps receiver-only RFC-64 bootstrap active without enabling auto-publish', async () => {
    const createArg = await captureCreateArg({
      rfc64PublicCatalog: {
        enabled: true,
        bootstrap: {
          acceptedPublicPolicies: [
            rfc64PublicCatalogPolicy('rfc64-receiver-only', 'evm:100'),
          ],
        },
      },
    });

    expect(createArg.syncContextGraphs).toContain('rfc64-receiver-only');
    expect(createArg.rfc64PublicCatalogActivation.autoPublish).toBeUndefined();
    expect(
      createArg.rfc64PublicCatalogActivation.bootstrap.acceptedPublicPolicies[0]
        .policyEnvelope.payload.contextGraphId,
    ).toBe('rfc64-receiver-only');
  });

  it('rejects a cross-network RFC-64 manifest before DKGAgent.create', async () => {
    await expect(runDaemonInner(true, {
      name: 'storage-ack-timing-core-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'core',
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
      rfc64PublicCatalog: {
        enabled: true,
        bootstrap: {
          acceptedPublicPolicies: [
            rfc64PublicCatalogPolicy('rfc64-wrong-network', 'base:84532'),
          ],
        },
      },
    } as any, Date.now())).rejects.toThrow(/policy network differs/u);

    expect(mocks.agentCreate).not.toHaveBeenCalled();
    expect(mocks.chainResetWipe).not.toHaveBeenCalled();
    expect(mocks.loadOpWallets).not.toHaveBeenCalled();
    expect(mocks.startPublisherRuntimeWithOutcome).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('keeps RFC-64 activation fully absent from agent inputs when disabled', async () => {
    const createArg = await captureCreateArg({
      rfc64PublicCatalog: { enabled: false },
    });

    expect(createArg.rfc64PublicCatalogActivation).toEqual({ enabled: false });
    expect(createArg.rfc64CatalogDeploymentProfile).toBeUndefined();
    expect(createArg.rfc64PublicCatalogAutoPublish).toBeUndefined();
    expect(createArg.rfc64PublicCatalogBootstrap).toBeUndefined();
  });

  it('strips stale controls from an explicitly disabled RFC-64 activation', async () => {
    const createArg = await captureCreateArg({
      rfc64PublicCatalog: {
        enabled: false,
        autoPublish: {
          peers: ['12D3KooIgnored'],
          catalogIssuerDelegationExpiresAt: '1893456000000',
        },
        bootstrap: {
          acceptedPublicPolicies: [
            rfc64PublicCatalogPolicy('rfc64-ignored-disabled', 'evm:100'),
          ],
        },
      },
    });

    expect(createArg.syncContextGraphs).not.toContain('rfc64-ignored-disabled');
    expect(createArg.rfc64PublicCatalogActivation).toEqual({ enabled: false });
    expect(createArg.rfc64PublicCatalogAutoPublish).toBeUndefined();
    expect(createArg.rfc64PublicCatalogBootstrap).toBeUndefined();
  });

  it('passes configured StorageACK timing into DKGAgent.create', async () => {
    const createArg = await captureCreateArg({
      storageAck: { handlerDeadlineMs: 55_000, sendTimeoutMs: 60_000 },
    });

    expect(createArg.storageAckTiming).toEqual({
      handlerDeadlineMs: 55_000,
      sendTimeoutMs: 60_000,
      maxConcurrentCollections: 1,
    });
  });

  it('passes disabled StorageACK handler deadlines into DKGAgent.create', async () => {
    const createArg = await captureCreateArg({
      storageAck: { handlerDeadlineMs: 0, sendTimeoutMs: 20_000 },
    });

    expect(createArg.storageAckTiming).toEqual({
      handlerDeadlineMs: 0,
      sendTimeoutMs: 20_000,
      maxConcurrentCollections: 1,
    });
  });

  it('validates malformed StorageACK timing before chain-reset wipe can run', async () => {
    await expect(runDaemonInner(true, {
      name: 'storage-ack-invalid-before-wipe-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'core',
      storageAck: '60000',
    } as any, Date.now())).rejects.toThrow(/storageAck must be an object/);

    expect(mocks.chainResetWipe).not.toHaveBeenCalled();
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('passes the resolved send timeout through the daemon async publisher startup handoff', async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: any[]) => {
      const handle = realSetTimeout(handler, timeout, ...args);
      if ((timeout ?? 0) > 0) handle.unref?.();
      return handle;
    }) as typeof setTimeout);
    const response = new Uint8Array([7]);
    const sendReliable = vi.fn(async () => ({
      delivered: true,
      response,
    }));
    const payload = new Uint8Array([1, 2, 3]);
    const createACKTransportFactory = vi.fn(({ sendTimeoutMs, log }: {
      sendTimeoutMs?: number;
      log?: (message: string) => void;
    }) => () => ({
      publisherPeerId: 'self-peer',
      gossipPublish: vi.fn(async () => undefined),
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        const result = await sendReliable(peerId, protocol, data, {
          timeoutMs: sendTimeoutMs,
        });
        if (!result.delivered) throw new Error(`substrate queued (transport): ${result.error}`);
        if (!result.response) throw new Error('substrate delivered (transport) without response');
        return result.response;
      },
      getConnectedCorePeers: vi.fn(() => ['peer-a']),
      log,
    }));
    const fakeAgent = {
      peerId: 'self-peer',
      multiaddrs: [],
      wallet: {
        keypair: {
          publicKey: new Uint8Array([1]),
          secretKey: new Uint8Array([2]),
        },
      },
      store: {},
      node: { libp2p: { getMultiaddrs: vi.fn(() => []) } },
      eventBus: { on: vi.fn() },
      assertion: {
        create: vi.fn(),
        write: vi.fn(),
      },
      setChatAcl: vi.fn(),
      setSkillAcl: vi.fn(),
      onChat: vi.fn(),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      publishProfile: vi.fn(async () => undefined),
      ensureProfilePublished: vi.fn(async () => undefined),
      publishRelayRegistry: vi.fn(async () => undefined),
      ensureContextGraphLocal: vi.fn(async () => undefined),
      getSubscribedContextGraphs: vi.fn(() => new Map()),
      subscribeToContextGraph: vi.fn(),
      pingPeers: vi.fn(async () => undefined),
      listLocalAgents: vi.fn(() => []),
      registerImportedArtifactByteStore: vi.fn(),
      getDefaultAgentAddress: vi.fn(() => undefined),
      query: vi.fn(async () => ({ type: 'bindings', bindings: [] })),
      createContextGraph: vi.fn(),
      listContextGraphs: vi.fn(async () => []),
      createACKTransportFactory,
      drainRpcUsage: vi.fn(() => ({
        calls: 0,
        errors: 0,
        throttledMs: 0,
        byEndpoint: {},
      })),
    };
    mocks.agentCreate.mockResolvedValue(fakeAgent);

    await runDaemonInner(true, {
      name: 'storage-ack-async-publisher-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'edge',
      apiPort: 0,
      auth: { enabled: false },
      promoteQueue: { enabled: false },
      publisher: { enabled: true },
      source: 'monorepo',
      storageAck: { handlerDeadlineMs: 55_000, sendTimeoutMs: 60_000 },
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
        receiptTimeoutMs: 1_200_000,
      },
    } as any, Date.now());

    await new Promise((resolve) => realSetTimeout(resolve, 0));
    await new Promise((resolve) => realSetTimeout(resolve, 0));

    expect(mocks.startPublisherRuntimeWithOutcome).toHaveBeenCalledTimes(1);
    expect(createACKTransportFactory).toHaveBeenCalledWith(expect.objectContaining({
      sendTimeoutMs: 60_000,
      log: expect.any(Function),
    }));

    const startupArg = mocks.startPublisherRuntimeWithOutcome.mock.calls[0]?.[0] as any;
    expect(startupArg.chainBase).toMatchObject({ receiptTimeoutMs: 1_200_000 });
    const transport = startupArg.ackTransportFactory();

    await expect(transport.sendP2P('peer-a', '/dkg/test/storage-ack', payload)).resolves.toEqual(response);
    expect(sendReliable).toHaveBeenCalledWith('peer-a', '/dkg/test/storage-ack', payload, {
      timeoutMs: 60_000,
    });
    expect(transport.getConnectedCorePeers('/dkg/test/storage-ack')).toEqual(['peer-a']);
  });
});
