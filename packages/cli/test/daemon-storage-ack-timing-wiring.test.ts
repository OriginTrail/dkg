import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  MEMBER_ROSTER_OBJECT_TYPE_V1,
  computeContextGraphPolicyObjectDigestV1,
} from '@origintrail-official/dkg-core';
import { rfc64PublicCatalogPolicy } from './helpers/rfc64-public-catalog.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import type { ChainResetWipeResult } from '../src/daemon/chain-reset-wipe.js';
import type { StoreIdentityTagResult } from '../src/daemon/store-health-check.js';

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

import {
  daemonWiringMocks as mocks, runDaemonInner, closeDashboardDbFromAgentCreateArg,
  installDaemonLifecycleWiringFixture,
} from './helpers/daemon-lifecycle-wiring.js';

describe('runDaemonInner StorageACK timing wiring', () => {
  const fixture = installDaemonLifecycleWiringFixture();
  const { captureCreateArg } = fixture;

  it('re-tags managed store ownership after an incomplete wipe requests it', async () => {
    mocks.chainResetWipe.mockResolvedValueOnce({
      status: 'incomplete',
      attempted: true,
      requiresStoreRetag: true,
      prevMarker: 'old-chain',
      removedFiles: ['<sparql:drop-all http://127.0.0.1:7878/update>'],
      backedUpFiles: [],
      failedFiles: [{ file: '<external-wipe>', error: 'response lost after DROP' }],
    });
    mocks.checkOrSetStoreIdentity
      .mockResolvedValueOnce({ ok: true, action: 'matched', nodeName: 'storage-ack-timing-core-test' })
      .mockResolvedValueOnce({ ok: true, action: 'tagged', nodeName: 'storage-ack-timing-core-test' });

    await captureCreateArg({
      store: {
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://127.0.0.1:7878/query',
          updateEndpoint: 'http://127.0.0.1:7878/update',
          managedByDkg: true,
        },
      },
    });

    expect(mocks.checkOrSetStoreIdentity).toHaveBeenCalledTimes(2);
    expect(mocks.checkOrSetStoreIdentity.mock.calls[1]?.[0]).toMatchObject({
      nodeName: 'storage-ack-timing-core-test',
      storeConfig: { options: { managedByDkg: true } },
    });
  });

  it.each([
    {
      failure: { ok: false, action: 'transport-error', error: 'endpoint unavailable after DROP' },
      diagnostic: '[STORE-IDENTITY] failed to re-tag: endpoint unavailable after DROP',
    },
    {
      failure: {
        ok: false, action: 'mismatch', existingNodeName: 'another-node',
        expectedNodeName: 'storage-ack-timing-core-test', error: 'ownership changed after DROP',
      },
      diagnostic: '[STORE-IDENTITY] external triple-store is owned by a different node.',
    },
  ] satisfies Array<{ failure: StoreIdentityTagResult; diagnostic: string }>)(
    'refuses startup after post-wipe ownership $failure.action',
    async ({ failure, diagnostic }) => {
      mocks.chainResetWipe.mockResolvedValueOnce({
        status: 'incomplete',
        attempted: true,
        requiresStoreRetag: true,
        prevMarker: 'old-chain',
        removedFiles: [],
        backedUpFiles: [],
        failedFiles: [{ file: '<external-wipe>', error: 'response lost after DROP' }],
      } satisfies ChainResetWipeResult);
      mocks.checkOrSetStoreIdentity
        .mockResolvedValueOnce({ ok: true, action: 'matched', nodeName: 'storage-ack-timing-core-test' })
        .mockResolvedValueOnce(failure);

      try {
        await expect(runDaemonInner(true, {
          name: 'storage-ack-timing-core-test',
          networkConfig: 'mainnet-gnosis',
          listenPort: 0,
          apiPort: 0,
          nodeRole: 'core',
          chain: {
            type: 'evm', rpcUrl: 'https://private-rpc.example',
            hubAddress: '0x1234567890123456789012345678901234567890',
            chainId: 'evm:100',
          },
          store: {
            backend: 'sparql-http',
            options: {
              queryEndpoint: 'http://127.0.0.1:7878/query',
              updateEndpoint: 'http://127.0.0.1:7878/update',
              managedByDkg: true,
            },
          },
        }, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('process.exit:1');

        expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(mocks.chainResetWipe).toHaveBeenCalledTimes(1);
        expect(mocks.checkOrSetStoreIdentity).toHaveBeenCalledTimes(2);
        const identityOrder = mocks.checkOrSetStoreIdentity.mock.invocationCallOrder;
        const wipeOrder = mocks.chainResetWipe.mock.invocationCallOrder[0]!;
        expect(identityOrder[0]).toBeLessThan(wipeOrder);
        expect(identityOrder[1]).toBeGreaterThan(wipeOrder);
        expect(mocks.agentCreate).not.toHaveBeenCalled();
        expect(mocks.loadOpWallets).not.toHaveBeenCalled();
        expect(mocks.startPublisherRuntimeWithOutcome).not.toHaveBeenCalled();
        const log = await readFile(join(fixture.tempHome!, 'daemon.log'), 'utf8');
        expect(log).toContain(diagnostic);
        expect(fixture.stdoutLines.join('')).toContain(diagnostic);
        expect(log).not.toContain('Re-tagged triple-store namespace');
        if (failure.action === 'mismatch') {
          expect(log).toContain(failure.existingNodeName);
          expect(log).toContain(failure.expectedNodeName);
        }
        expect(process.listeners('uncaughtException')).toEqual(fixture.uncaughtExceptionListeners);
        expect(process.listeners('unhandledRejection')).toEqual(fixture.unhandledRejectionListeners);
      } finally {
        closeDashboardDbFromAgentCreateArg(mocks.agentCreate.mock.calls[0]?.[0]);
      }
    },
  );

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

  it('round-trips durable local context-graph origins through the daemon DashboardDB wiring', async () => {
    const record = {
      contextGraphId: 'rfc64-local-origin-daemon-wiring',
      source: 'local-create',
      createdAt: 1_789_386_000_000,
    };

    await captureCreateArg({}, async (createArg) => {
      const store = createArg.contextGraphMembershipStore;
      expect(store).toBeDefined();
      expect(store?.localOrigins).toBeDefined();
      await expect(store.localOrigins?.loadLocalOrigins()).resolves.toEqual([]);
      await store.localOrigins?.recordLocalOrigin(record);
      await expect(store.localOrigins?.loadLocalOrigins()).resolves.toEqual([record]);
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
    expect(createArg.rfc64CatalogActivations.publicCatalog).toMatchObject({
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

  it('keeps an eligible public manifest dormant on an edge without an explicit subscription', async () => {
    const manifestContextGraph = 'rfc64-edge-eligible-only';
    const createArg = await captureCreateArg({
      nodeRole: 'edge',
      rfc64PublicCatalog: {
        enabled: true,
        bootstrap: {
          acceptedPublicPolicies: [
            rfc64PublicCatalogPolicy(manifestContextGraph, 'evm:100'),
          ],
        },
      },
    });

    expect(createArg.syncContextGraphs).toEqual([]);
    expect(createArg.rfc64CatalogActivations.publicCatalog.bootstrap.acceptedPublicPolicies[0]
      .policyEnvelope.payload.contextGraphId).toBe(manifestContextGraph);
  });

  it('keeps a private-only RFC-64 catalog selection out of generic sync wiring', async () => {
    const rfc64Catalog = rfc64PrivateCatalogActivation();
    const createArg = await captureCreateArg({
      contextGraphs: ['legacy-explicit-cg'],
      rfc64Catalog,
    });

    expect(createArg.syncContextGraphs).toEqual(['legacy-explicit-cg']);
    expect(createArg.syncContextGraphs).not.toContain(PRIVATE_RFC64_CONTEXT_GRAPH);
    expect(createArg.rfc64CatalogActivations.catalog).toMatchObject({
      enabled: true,
      selectedPrivateContextGraphs: [PRIVATE_RFC64_CONTEXT_GRAPH],
      accessPolicyAuthority: rfc64Catalog.accessPolicyAuthority,
    });
    expect(createArg.rfc64CatalogActivations.activationState).toMatchObject({
      configuration: { source: 'unified' },
      execution: { mode: 'catalog' },
    });
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
    expect(createArg.rfc64CatalogActivations.publicCatalog.autoPublish).toBeUndefined();
    expect(
      createArg.rfc64CatalogActivations.publicCatalog.bootstrap.acceptedPublicPolicies[0]
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
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow(/policy network differs/u);

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

    expect(createArg.rfc64CatalogActivations.publicCatalog.enabled).toBe(false);
    expect(createArg.rfc64CatalogActivations.activationState).toMatchObject({
      configuration: { source: 'deprecated-public' },
      execution: { mode: 'compatibility-rollback' },
    });
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
    expect(createArg.rfc64CatalogActivations.publicCatalog).toMatchObject({
      enabled: false,
      selectedContextGraphs: [],
    });
    expect(createArg.rfc64CatalogActivations.publicCatalog.bootstrap).toBeUndefined();
    expect(createArg.rfc64CatalogActivations.activationState).toMatchObject({
      execution: { mode: 'compatibility-rollback' },
    });
    expect(createArg.rfc64PublicCatalogAutoPublish).toBeUndefined();
    expect(createArg.rfc64PublicCatalogBootstrap).toBeUndefined();
  });

  it('lets unified RFC-64 disable suppress deprecated public selection and runtime controls', async () => {
    const createArg = await captureCreateArg({
      contextGraphs: ['ordinary-legacy-sync'],
      rfc64Catalog: { enabled: false },
      // The unified gate is authoritative, so even stale deprecated controls
      // that would be invalid if active must neither extend generic sync nor
      // reach the agent runtime.
      rfc64PublicCatalog: {
        enabled: true,
        autoPublish: {
          peers: ['12D3KooIgnoredDeprecatedProvider'],
          catalogIssuerDelegationExpiresAt: '1893456000000',
        },
        bootstrap: {
          acceptedPublicPolicies: [
            rfc64PublicCatalogPolicy('rfc64-deprecated-selection', 'base:84532'),
          ],
        },
      },
    });

    expect(createArg.syncContextGraphs).toEqual(['ordinary-legacy-sync']);
    expect(createArg.rfc64CatalogActivations.catalog).toMatchObject({
      enabled: false,
      selectedContextGraphs: [],
    });
    expect(createArg.rfc64CatalogActivations.publicCatalog).toMatchObject({
      enabled: false,
      selectedContextGraphs: [],
    });
    expect(createArg.rfc64CatalogActivations.activationState).toMatchObject({
      configuration: {
        source: 'unified',
        deprecatedPublicControlPresent: true,
      },
      execution: { mode: 'compatibility-rollback' },
    });
    expect(createArg.rfc64CatalogDeploymentProfile).toBeUndefined();
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
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow(/storageAck must be an object/);

    expect(mocks.chainResetWipe).not.toHaveBeenCalled();
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('passes the resolved send timeout through the daemon async publisher startup handoff', async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: any[]) => {
      const handle = realSetTimeout(handler, timeout, ...args);
      const timer: unknown = handle;
      if ((timeout ?? 0) > 0 && typeof timer === 'object' && timer !== null
        && 'unref' in timer && typeof timer.unref === 'function') timer.unref();
      return handle;
    }) as typeof setTimeout);
    const response = new Uint8Array([7]);
    const sendReliable = vi.fn<(
      peerId: string, protocol: string, data: Uint8Array, options: { timeoutMs?: number },
    ) => Promise<{ delivered: boolean; response?: Uint8Array; error?: unknown }>>(async () => ({
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
    const currentChainEventLogBinding = { scope: 'evm:100:hub=test:test' };
    const getChainEventLogBinding = vi.fn(() => currentChainEventLogBinding);
    const fakeAgent = {
      configurePromoteQueue: vi.fn(),
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
      getChainEventLogBinding,
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
    } as any, Date.now(), resolveShutdownPolicy(undefined));

    await new Promise((resolve) => realSetTimeout(resolve, 0));
    await new Promise((resolve) => realSetTimeout(resolve, 0));

    expect(mocks.startPublisherRuntimeWithOutcome).toHaveBeenCalledTimes(1);
    expect(createACKTransportFactory).toHaveBeenCalledWith(expect.objectContaining({
      sendTimeoutMs: 60_000,
      log: expect.any(Function),
    }));

    const startupArg = mocks.startPublisherRuntimeWithOutcome.mock.calls[0]?.[0] as any;
    expect(startupArg.chainBase).toMatchObject({ receiptTimeoutMs: 1_200_000 });
    expect(startupArg.chainEventLogBindingSource()).toBe(currentChainEventLogBinding);
    expect(getChainEventLogBinding).toHaveBeenCalledTimes(1);
    const agentCreateArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    expect(agentCreateArg.chainConfig.rpcRequestAdmission).toBe(
      startupArg.chainBase.rpcRequestAdmission,
    );
    const transport = startupArg.ackTransportFactory();

    await expect(transport.sendP2P('peer-a', '/dkg/test/storage-ack', payload)).resolves.toEqual(response);
    expect(sendReliable).toHaveBeenCalledWith('peer-a', '/dkg/test/storage-ack', payload, {
      timeoutMs: 60_000,
    });
    expect(transport.getConnectedCorePeers('/dkg/test/storage-ack')).toEqual(['peer-a']);
  });
});
