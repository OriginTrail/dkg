// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  computeNetworkId,
  type AssertionSeal,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '../src/rfc64/open-catalog-policy-v1.js';
import { Rfc64PublicCatalogSuccessorProducerV1 } from
  '../src/rfc64/public-catalog-successor-producer-v1.js';
import type { Rfc64PublicCatalogActivationInputV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID = (
  '0x1111111111111111111111111111111111111111/rollout-authority'
) as ContextGraphIdV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;
const PROJECTION_QUADS: readonly Quad[] = Object.freeze([
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/age',
    object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
    graph: '',
  }),
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/name',
    object: '"Alice"',
    graph: '',
  }),
]);
const agents: DKGAgent[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best effort */ }
  }
  await Promise.all(tempDirs.splice(0).map(
    (path) => rm(path, { recursive: true, force: true }),
  ));
  vi.restoreAllMocks();
});

describe('RFC-64 rollout authority integration', () => {
  it('enforces legacy, shadow, catalog, and kill-switch authority at startup', async () => {
    const legacy = await startAgent('legacy', activation('legacy'));
    expect(legacy.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(legacy.rfc64PublicCatalogStatsV1()).toBeNull();

    const shadow = await startAgent('shadow', activation('shadow'));
    expect(shadow.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(shadow.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });

    const catalog = await startAgent('catalog', activation('catalog'));
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(catalog.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect((catalog as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);

    const stopped = await startAgent('kill-switch', activation('catalog', true));
    expect(stopped.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(stopped.rfc64PublicCatalogStatsV1()).toBeNull();
  });

  it('leaves a persisted member row dormant under exclusive catalog authority', async () => {
    const persisted = new Map<string, any>([[CONTEXT_GRAPH_ID, {
      id: CONTEXT_GRAPH_ID,
      name: 'persisted-before-rfc64',
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      coreHosted: false,
    }]]);
    const catalog = await startAgent(
      'catalog-rehydration-fence',
      activation('catalog'),
      undefined,
      undefined,
      undefined,
      {
        contextGraphSubscriptionStore: {
          loadAll: async () => [...persisted.values()],
          save: async (record) => { persisted.set(record.id, { ...record }); },
          delete: async (contextGraphId) => { persisted.delete(contextGraphId); },
        },
      },
    );
    expect(catalog.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect((catalog as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(catalog.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0,
      dormant: 1,
      dormantIds: [CONTEXT_GRAPH_ID],
    });
    expect(persisted.get(CONTEXT_GRAPH_ID)).toMatchObject({ subscribed: true });
  });

  it('keeps complete-provider recovery live when every selected CG is legacy-mode', async () => {
    const providerPeerId = '12D3KooWAllLegacyCompleteProvider';
    let connect!: ReturnType<typeof vi.spyOn>;
    let queue!: ReturnType<typeof vi.spyOn>;
    const legacy = await startAgent('all-legacy-provider', {
      ...activation('legacy'),
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: policyEnvelope(),
          targets: [],
          completeSwmProviders: [providerPeerId],
        }],
      },
    }, undefined, undefined, (agent) => {
      connect = vi.spyOn(agent, 'connectToPeerId').mockResolvedValue();
      queue = vi.spyOn(agent, 'queueRfc64SwmRecoveryPlanFromPeerOnConnect')
        .mockReturnValue(true);
    });
    await legacy.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(legacy.readRfc64PublicCatalogBootstrapStatusV1()).toMatchObject({
      pass: 1,
      targets: [],
    });
    expect(connect).toHaveBeenCalledWith(providerPeerId, { timeoutMs: 10_000 });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ providerPeerId }),
      expect.any(Function),
      0,
    );
  });

  it.each(['legacy', 'shadow'] as const)(
    'semantically deactivates durable catalog authority before a %s restart',
    async (nextMode) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-rollout-transition-'));
    tempDirs.push(dataDir);
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent(
      'catalog-author',
      {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-restart-guard' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(await authorSeal(81n)),
    });
    expect(applied).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
    await author.stop();
    agents.splice(agents.indexOf(author), 1);
    // Upgrade fixture: prior catalog state exists, but the newly introduced
    // authority sidecar does not. Durable inventory must remain the truth.
    await rm(join(
      dataDir,
      'rfc64-sync',
      'rollout-authority-v1',
      'state.json',
    ));

    const producer = vi.spyOn(
      Rfc64PublicCatalogSuccessorProducerV1.prototype,
      'produceAndStageExactSet',
    );
    const restarted = await startAgent(
      `${nextMode}-after-catalog`,
      activation(nextMode),
      dataDir,
      persistentStorePath,
    );
    expect(restarted.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
    expect(restarted.rfc64PublicCatalogStatsV1()).toEqual(
      nextMode === 'shadow' ? expect.objectContaining({ started: true }) : null,
    );
    expect(producer).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('retains durable catalog authority for pre-activation standalone controls', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-rollout-standalone-'));
    tempDirs.push(dataDir);
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent(
      'standalone-author',
      {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-standalone-compatibility' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(await authorSeal(83n)),
    });
    expect(applied).not.toBeNull();
    await author.stop();
    agents.splice(agents.indexOf(author), 1);

    const restarted = await startAgent(
      'standalone-compatibility',
      undefined,
      dataDir,
      persistentStorePath,
      undefined,
      {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        rfc64PublicCatalogBootstrap: {
          acceptedPublicPolicies: [{ policyEnvelope: policyEnvelope(), targets: [] }],
        },
      },
    );
    expect(restarted.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: applied?.currentCatalogHeadDigest,
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
  }, 30_000);

  it('fails closed on malformed restart authority state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-rollout-malformed-'));
    tempDirs.push(dataDir);
    const persistentStorePath = join(dataDir, 'oxigraph');
    const first = await startAgent(
      'authority-state-writer',
      activation('catalog'),
      dataDir,
      persistentStorePath,
    );
    await first.stop();
    agents.splice(agents.indexOf(first), 1);
    await writeFile(
      join(dataDir, 'rfc64-sync', 'rollout-authority-v1', 'state.json'),
      '{invalid-json',
      'utf8',
    );

    await expect(startAgent(
      'authority-state-reader',
      activation('catalog'),
      dataDir,
      persistentStorePath,
    )).rejects.toThrow('RFC-64 catalog authority state is not valid JSON');
  }, 30_000);

  it('cold-bootstraps a valid shadow head as staged-only with no applied head', async () => {
    const author = await startAgent('shadow-author', {
      ...activation('catalog'),
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const published = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-shadow-bootstrap' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(await authorSeal(82n)),
    });
    const shadow = await startAgent('shadow-receiver', {
      ...activation('shadow'),
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: policyEnvelope(),
          targets: [{ authorAddress: AUTHOR, providers: [author.peerId] }],
        }],
      },
    });
    await connectBothWays(author, shadow);
    await vi.waitFor(() => {
      expect(shadow.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        mode: 'shadow',
        outcome: 'shadow-staged',
        stagedHeadDigest: published?.currentCatalogHeadDigest,
        appliedHeadDigest: null,
      });
    }, { timeout: 20_000, interval: 100 });
    expect(shadow.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
  }, 30_000);
});

function activation(
  mode: 'legacy' | 'shadow' | 'catalog',
  killSwitch = false,
): Rfc64PublicCatalogActivationInputV1 {
  return {
    deploymentProfile: DEPLOYMENT,
    rollout: { killSwitch, contextGraphModes: { [CONTEXT_GRAPH_ID]: mode } },
    bootstrap: {
      acceptedPublicPolicies: [{ policyEnvelope: policyEnvelope(), targets: [] }],
      retryIntervalMs: 1_000,
    },
  };
}

function policyEnvelope() {
  return unsignedOpenContextGraphPolicyEnvelopeV1(buildOpenOwnerContextGraphPolicyV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR,
  }));
}

async function startAgent(
  name: string,
  activationInput: Rfc64PublicCatalogActivationInputV1 | undefined,
  existingDataDir?: string,
  persistentStorePath?: string,
  beforeStart?: (agent: DKGAgent) => void | Promise<void>,
  extraConfig: Partial<Parameters<typeof DKGAgent.create>[0]> = {},
): Promise<DKGAgent> {
  const dataDir = existingDataDir ?? await mkdtemp(join(tmpdir(), `dkg-rfc64-${name}-`));
  if (existingDataDir === undefined) tempDirs.push(dataDir);
  const agent = await DKGAgent.create({
    name,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(persistentStorePath),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
    networkIdentity: {
      networkId: await computeNetworkId(),
      chainId: NETWORK_ID,
    },
    rfc64PublicCatalogActivation: activationInput,
    ...extraConfig,
  });
  agents.push(agent);
  await beforeStart?.(agent);
  await agent.start();
  return agent;
}

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  const address = (agent: DKGAgent) => {
    const tcp = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
    if (tcp === undefined) throw new Error('agent has no TCP multiaddr');
    return tcp;
  };
  await a.node.libp2p.dial(multiaddr(address(b)));
  await b.node.libp2p.dial(multiaddr(address(a)));
}

function catalogScopeDigest() {
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0' as never,
    bucketCount: '1' as never,
  });
}

async function authorSeal(kaNumber: bigint): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const assertionMerkleRoot = ethers.hexlify(
    computeFlatKCRootV10([...PROJECTION_QUADS], []),
  ) as Digest32V1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: String(PROJECTION_QUADS.length),
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function assertionSealFromCanonical(seal: CanonicalGraphScopedAuthorSealV1): AssertionSeal {
  return {
    merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
    authorAddress: seal.authorAddress,
    authorAttestationR: ethers.getBytes(seal.authorAttestationR),
    authorAttestationVS: ethers.getBytes(seal.authorAttestationVS),
    authorSchemeVersion: 1,
    chainId: BigInt(seal.assertedAtChainId),
    kav10Address: seal.assertedAtKav10Address,
    reservedKaId: BigInt(seal.reservedKaId),
    finalizedAtIso: seal.assertionFinalizedAt,
    contentScopeVersion: 2,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    publicTripleCount: Number(seal.publicTripleCount),
    privateTripleCount: Number(seal.privateTripleCount),
    rootEntities: [],
  };
}
