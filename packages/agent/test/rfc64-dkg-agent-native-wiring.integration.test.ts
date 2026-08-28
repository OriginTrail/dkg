import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  ASSERTION_SEAL_PREDICATES,
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  MEMBER_ROSTER_OBJECT_TYPE_V1,
  MemoryLayer,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAssertionSealQuads,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeContextGraphPolicyObjectDigestV1,
  computeKaProjectionDigestV1,
  computeNetworkId,
  computeSwmAuthorInventoryScopeDigestV1,
  createOperationContext,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  contextGraphLayerUri,
  createGraphKnowledgeAssetScope,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  knowledgeAssetLayerGraphUri,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type AssertionSeal,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterV1,
  type NetworkIdV1,
  type TimestampMsV1,
  type UnsignedContextGraphPolicyEnvelopeV1,
  type UnsignedMemberRosterEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  OxigraphStore,
  readSwmMaterializationWitness,
  writeSwmMaterializationWitness,
  type Quad,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DKGAgent,
  Rfc64CatalogReconciliationTerminalErrorV1,
} from '../src/index.js';
import {
  snapshotRfc64CatalogAccessPolicyAuthorityV1,
  snapshotRfc64CatalogDeploymentProfileV1,
  snapshotRfc64PublicCatalogAutoPublishConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
} from '../src/dkg-agent-rfc64-catalog.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '../src/rfc64/open-catalog-policy-v1.js';
import {
  resolveRfc64PublicCatalogActivationChainIdentityV1,
  resolveRfc64PublicCatalogActivationConfigV1,
  resolveRfc64PublicCatalogControlsV1,
  type Rfc64CatalogActivationInputV1,
  type Rfc64PublicCatalogActivationInputV1,
} from '../src/rfc64/public-catalog-activation-config-v1.js';
import type {
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
  Rfc64CatalogAccessPolicyAuthorityConfigV1,
  Rfc64PublicCatalogAutoPublishConfigV1,
  Rfc64PublicCatalogBootstrapConfigV1,
} from '../src/dkg-agent-types.js';
import {
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError,
  sendJsonRpcResult,
} from '../../chain/test/loopback-rpc-harness.js';
import {
  FinalizedVmLoopbackMockChainAdapterV1,
  createFinalizedVmLoopbackRpcV1,
  type FinalizedVmLoopbackFixtureConfigV1,
} from './support/rfc64-finalized-vm-loopback-fixture.js';
import { RFC64_M0_RECOVERY_SCENARIO_MANIFEST } from '../scripts/rfc64-m0-recovery-manifest.mjs';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-wiring' as ContextGraphIdV1;
const FIXED_HEAD_ISSUED_AT = '1773900000000' as TimestampMsV1;
const DELEGATION_EFFECTIVE_AT = '1773899999999' as TimestampMsV1;
const DELEGATION_EXPIRES_AT = '1773900000001' as TimestampMsV1;
const MULTI_DELEGATION_EXPIRES_AT = '1774000000000' as TimestampMsV1;
const SUCCESSOR_ISSUED_AT = '1773900001000' as TimestampMsV1;
const SECOND_SUCCESSOR_ISSUED_AT = '1773900002000' as TimestampMsV1;
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const KA_STORAGE = '0x5555555555555555555555555555555555555555' as EvmAddressV1;
const CONTEXT_GRAPH_STORAGE =
  '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const ON_CHAIN_CONTEXT_GRAPH_ID = '14';
const FINALIZED_BLOCK_HASH = `0x${'77'.repeat(32)}` as Digest32V1;
const FINALIZED_POLICY_DIGEST = `0x${'cd'.repeat(32)}` as Digest32V1;
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
const PROJECTION = new TextEncoder().encode(
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
);
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
const NATIVE_DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

const agents: DKGAgent[] = [];
const tempDirs: string[] = [];
const rpcHarness = createLoopbackJsonRpcTestHarness();
const RFC64_M0_RECOVERY_SCENARIOS = Object.freeze(
  RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map(({ id }) => id),
);
const rfc64M0RecoveryScenarioById = new Map(
  RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map((scenario) => [scenario.id, scenario]),
);
type Rfc64M0RecoveryScenario = string;
interface Rfc64M0RecoveryScenarioSpec {
  readonly title: string;
  readonly handler: () => void | Promise<void>;
  readonly timeout?: number;
}
const activeRfc64M0RecoveryScenario = process.env.DKG_RFC64_M0_RECOVERY_SCENARIO;
if (
  activeRfc64M0RecoveryScenario !== undefined
  && !(RFC64_M0_RECOVERY_SCENARIOS as readonly string[])
    .includes(activeRfc64M0RecoveryScenario)
) {
  throw new Error(
    `Unknown DKG_RFC64_M0_RECOVERY_SCENARIO: ${activeRfc64M0RecoveryScenario}`,
  );
}
const registeredRfc64M0RecoveryScenarios = new Map<
  Rfc64M0RecoveryScenario,
  Rfc64M0RecoveryScenarioSpec
>();
const ordinaryNativeWiringDescribe = describe.skipIf(
  activeRfc64M0RecoveryScenario !== undefined,
);

function registerM0RecoveryScenario(
  scenario: Rfc64M0RecoveryScenario,
  title: string,
  handler: () => void | Promise<void>,
  timeout?: number,
): void {
  if (registeredRfc64M0RecoveryScenarios.has(scenario)) {
    throw new Error(`Duplicate RFC-64 M0 recovery scenario registration: ${scenario}`);
  }
  registeredRfc64M0RecoveryScenarios.set(scenario, { title, handler, timeout });
}

function rfc64M0RecoveryTitle(scenario: Rfc64M0RecoveryScenario): string {
  const metadata = rfc64M0RecoveryScenarioById.get(scenario);
  if (metadata === undefined) {
    throw new Error(`Missing RFC-64 M0 recovery scenario metadata: ${scenario}`);
  }
  return metadata.title;
}

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best-effort */ }
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  await rpcHarness.stopAll();
});

async function startNativeAgent(
  name: string,
  deployment: CatalogSealDeploymentProfileV1 = NATIVE_DEPLOYMENT,
  existingDataDir?: string,
  accessPolicyAuthority?: Rfc64CatalogAccessPolicyAuthorityConfigV1,
  finalizedRuntime?: Readonly<{
    rpcUrl: string;
    chainAdapter: FinalizedVmLoopbackMockChainAdapterV1;
    initialSubscription?: ContextGraphIdV1;
  }>,
  autoPublish?: Rfc64PublicCatalogAutoPublishConfigV1,
): Promise<DKGAgent> {
  return startNativeAgentWithOptions({
    name,
    deployment,
    existingDataDir,
    accessPolicyAuthority,
    finalizedRuntime,
    autoPublish,
  });
}

interface NativeAgentStartOptionsV1 {
  readonly name: string;
  readonly deployment?: CatalogSealDeploymentProfileV1;
  readonly existingDataDir?: string;
  readonly accessPolicyAuthority?: Rfc64CatalogAccessPolicyAuthorityConfigV1;
  readonly finalizedRuntime?: Readonly<{
    rpcUrl: string;
    chainAdapter: FinalizedVmLoopbackMockChainAdapterV1;
    initialSubscription?: ContextGraphIdV1;
  }>;
  readonly autoPublish?: Rfc64PublicCatalogAutoPublishConfigV1;
  readonly bootstrap?: Rfc64PublicCatalogBootstrapConfigV1;
  readonly catalogActivation?: Rfc64CatalogActivationInputV1;
  readonly activation?: Rfc64PublicCatalogActivationInputV1;
  readonly persistentStorePath?: string;
  readonly networkIdentityChainId?: NetworkIdV1;
  readonly beforeStart?: (agent: DKGAgent) => void | Promise<void>;
}

async function startNativeAgentWithOptions(
  options: NativeAgentStartOptionsV1,
): Promise<DKGAgent> {
  const {
    name,
    deployment = NATIVE_DEPLOYMENT,
    existingDataDir,
    accessPolicyAuthority,
    finalizedRuntime,
    autoPublish,
    bootstrap,
    catalogActivation,
    activation,
    persistentStorePath,
    beforeStart,
    networkIdentityChainId = activation === undefined && catalogActivation === undefined
      ? undefined
      : deployment.networkId,
  } = options;
  const dataDir = existingDataDir
    ?? await mkdtemp(join(tmpdir(), `dkg-rfc64-native-${name}-`));
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
    rfc64CatalogAccessPolicyAuthority: accessPolicyAuthority,
    ...(networkIdentityChainId === undefined ? {} : {
      networkIdentity: {
        networkId: await computeNetworkId(),
        chainId: networkIdentityChainId,
      },
    }),
    ...(activation === undefined && catalogActivation === undefined ? {
      rfc64CatalogDeploymentProfile: deployment,
      rfc64PublicCatalogAutoPublish: autoPublish,
      rfc64PublicCatalogBootstrap: bootstrap,
    } : catalogActivation !== undefined ? {
      rfc64CatalogActivation: catalogActivation,
    } : {
      rfc64PublicCatalogActivation: activation,
    }),
    ...(finalizedRuntime === undefined ? {} : {
      chainAdapter: finalizedRuntime.chainAdapter,
      chainConfig: {
        rpcUrl: finalizedRuntime.rpcUrl,
        hubAddress: CONTEXT_GRAPH_STORAGE,
        operationalKeys: [`0x${'12'.repeat(32)}`],
      },
      ...(finalizedRuntime.initialSubscription === undefined ? {} : {
        contextGraphSubscriptionStore: seededSubscriptionStore(
          finalizedRuntime.initialSubscription,
        ),
      }),
    }),
  });
  agents.push(agent);
  await beforeStart?.(agent);
  await agent.start();
  return agent;
}

async function seedPreexistingFinalizedTwinV1(
  agent: DKGAgent,
  seal: CanonicalGraphScopedAuthorSealV1,
): Promise<Readonly<{ swmGraph: string; vmGraph: string; publicQuadsDigest: string }>> {
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  const swmGraph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.SharedWorkingMemory,
    scope,
  );
  const vmGraph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.VerifiableMemory,
    scope,
  );
  const vmMetadata = generateGraphKnowledgeAssetMetadata({
    contextGraphId: CONTEXT_GRAPH_ID,
    ual: seal.kaUal,
    merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
    publisherPeerId: 'rfc64-finalized-catalog-v1',
    accessPolicy: 'ownerOnly',
    allowedPeers: [],
    timestamp: new Date(seal.assertionFinalizedAt),
    assertionVersion: seal.assertionVersion,
    authorAddress: seal.authorAddress,
    publicTripleCount: Number(seal.publicTripleCount),
    privateTripleCount: Number(seal.privateTripleCount),
    assertionGraph: vmGraph,
  }, {
    status: 'confirmed',
    confirmation: {
      kind: 'finalized-materialization',
      provenance: {
        batchId: BigInt(seal.reservedKaId),
        materializedVersion: { blockNumber: 124, txIndex: 0 },
      },
    },
  });
  await agent.store.insert([
    ...PROJECTION_QUADS.map((quad) => ({ ...quad, graph: vmGraph })),
    ...vmMetadata,
    ...PROJECTION_QUADS.map((quad) => ({ ...quad, graph: swmGraph })),
  ]);

  const graphManager = new GraphManager(agent.store);
  const shareOperationId = 'preexisting-finalized-twin-v1';
  await storeKnowledgeAssetOperationPublicQuads({
    store: agent.store,
    graphManager,
    contextGraphId: CONTEXT_GRAPH_ID,
    shareOperationId,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    quads: PROJECTION_QUADS,
    privateTripleCount: Number(seal.privateTripleCount),
    publisherPeerId: 'preexisting-finalized-provider',
    accessPolicy: 'ownerOnly',
    agentAddress: seal.authorAddress,
    timestamp: new Date(seal.assertionFinalizedAt),
  });
  await storeKnowledgeAssetWorkspaceHead({
    store: agent.store,
    graphManager,
    contextGraphId: CONTEXT_GRAPH_ID,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    shareOperationId,
  });
  const publicQuadsDigest = workspacePublicQuadsDigest(PROJECTION_QUADS);
  expect(await writeSwmMaterializationWitness(
    agent.store,
    swmGraph,
    publicQuadsDigest,
  )).toBe(true);
  return Object.freeze({ swmGraph, vmGraph, publicQuadsDigest });
}

function seededSubscriptionStore(contextGraphId: string): ContextGraphSubscriptionStore {
  const records = new Map<string, ContextGraphSubscriptionRecord>([[contextGraphId, {
    id: contextGraphId,
    subscribed: true,
    synced: false,
    syncScoped: true,
  }]]);
  return {
    loadAll: async () => [...records.values()].map((record) => ({ ...record })),
    load: async (id) => {
      const record = records.get(id);
      return record === undefined ? null : { ...record };
    },
    save: async (record) => { records.set(record.id, { ...record }); },
    delete: async (id) => { records.delete(id); },
  };
}

function tcpMultiaddr(agent: DKGAgent): string {
  const address = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('agent has no TCP multiaddr');
  return address;
}

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  await a.node.libp2p.dial(multiaddr(tcpMultiaddr(b)));
  await b.node.libp2p.dial(multiaddr(tcpMultiaddr(a)));
}

function catalogScopeDigest() {
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    era: '0' as never,
    bucketCount: '1' as never,
  });
}

function privateCatalogPolicy(): ContextGraphPolicyV1 {
  return {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
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
      ownerAddress: AUTHOR,
      ownerAuthorityEra: '0',
    },
    effectiveAt: '0',
    issuedAt: '0',
  };
}

function finalizedPublicCatalogPolicy(options: Readonly<{
  publishPolicy: ContextGraphPolicyV1['publishPolicy'];
  publishAuthority: EvmAddressV1 | null;
}> = { publishPolicy: 1, publishAuthority: null }): ContextGraphPolicyV1 {
  return {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: '20430',
    governanceContractAddress: CONTEXT_GRAPH_STORAGE,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 0,
    publishPolicy: options.publishPolicy,
    publishAuthority: options.publishAuthority,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'finalized-chain',
      chainId: '20430',
      contractAddress: CONTEXT_GRAPH_STORAGE,
      blockNumber: '120',
      blockHash: `0x${'76'.repeat(32)}`,
    },
    effectiveAt: '1773900000000',
    issuedAt: '1773900000000',
  };
}

function privateCatalogRoster(
  policy: ContextGraphPolicyV1,
  policyDigest: Digest32V1,
): MemberRosterV1 {
  return {
    networkId: policy.networkId,
    contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: policy.ownershipTransitionDigest,
    era: policy.era,
    version: '0',
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest: policy.administrativeDelegationDigest,
    members: [{ agentAddress: AUTHOR, roles: ['holder', 'provider'] }],
    issuedAt: '0',
  };
}

ordinaryNativeWiringDescribe('RFC-64 DKGAgent production native catalog wiring', () => {
  it('preserves the EVM default chain identity for a no-admin chain config', async () => {
    const operational = ethers.Wallet.createRandom();
    const agent = await DKGAgent.create({
      name: 'rfc64-no-admin-default-chain',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:0',
        hubAddress: ethers.ZeroAddress,
        operationalKeys: [operational.privateKey],
      },
      nodeRole: 'core',
    });
    agents.push(agent);

    expect(agent).toBeInstanceOf(DKGAgent);
    const internals = agent as unknown as {
      chain: { chainId: string };
      config: { networkIdentity?: { chainId?: string } };
    };
    expect(internals.chain.chainId).toBe('evm:31337');
    expect(internals.config.networkIdentity?.chainId).toBe('evm:31337');
  });

  it('snapshots and canonicalizes the deterministic local deployment override', () => {
    const callerOwned = {
      networkId: NETWORK_ID,
      assertedAtChainId: '20430',
      assertedAtKav10Address: ethers.getAddress(
        '0x4444444444444444444444444444444444444444',
      ),
    } as CatalogSealDeploymentProfileV1;
    const snapshot = snapshotRfc64CatalogDeploymentProfileV1(callerOwned)!;
    (callerOwned as { networkId: NetworkIdV1 }).networkId = 'hostile:1' as NetworkIdV1;
    expect(snapshot).toEqual(NATIVE_DEPLOYMENT);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => snapshotRfc64CatalogDeploymentProfileV1({
      ...NATIVE_DEPLOYMENT,
      assertedAtKav10Address: `0x${'00'.repeat(20)}` as never,
    })).toThrow(/non-zero EVM address/);
  });

  it('snapshots the opt-in normal-publication catalog producer configuration', () => {
    const callerOwned = {
      peers: ['12D3KooReceiver'],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };
    const snapshot = snapshotRfc64PublicCatalogAutoPublishConfigV1(callerOwned)!;
    callerOwned.peers.push('hostile-late-mutation');
    expect(snapshot).toEqual({
      peers: ['12D3KooReceiver'],
      catalogIssuerDelegationEffectiveAt: '0',
      catalogIssuerDelegationExpiresAt: '1893456000000',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.peers)).toBe(true);
    expect(() => snapshotRfc64PublicCatalogAutoPublishConfigV1({
      peers: ['duplicate', 'duplicate'],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    })).toThrow(/duplicated/u);
  });

  it('keeps direct legacy agent auto-publish configuration source-compatible', async () => {
    const agent = await startNativeAgent(
      'legacy-direct-agent-config',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    expect(agent).toBeInstanceOf(DKGAgent);
  });

  it('excludes restricted shares, restarts the public SWM-only inventory, then removes VM-confirmed rows', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-swm-shadow-restart-'));
    tempDirs.push(dataDir);
    const autoPublish = {
      peers: [],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };
    const author = await startNativeAgent(
      'swm-shadow-author',
      NATIVE_DEPLOYMENT,
      dataDir,
      undefined,
      undefined,
      autoPublish,
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const publicQuads: Quad[] = [
      {
        subject: 'https://example.org/swm-only',
        predicate: 'https://schema.org/name',
        object: '"SWM only"',
        graph: '',
      },
      {
        subject: 'https://example.org/swm-only',
        predicate: 'https://schema.org/version',
        object: '"1"',
        graph: '',
      },
    ];
    const canonicalSeal = await authorSeal(21n, publicQuads);
    const seal = assertionSealFromCanonical(canonicalSeal);
    const assertionCoordinate = 'swm-only-shadow';
    const shareOperationId = 'swm-only-shadow-operation';
    const assertionUri = contextGraphAssertionUri(
      CONTEXT_GRAPH_ID,
      AUTHOR,
      assertionCoordinate,
    );
    await author.store.insert(buildAssertionSealQuads({
      assertionUri,
      metaGraph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      merkleRoot: seal.merkleRoot,
      authorAddress: seal.authorAddress,
      authorAttestationR: seal.authorAttestationR,
      authorAttestationVS: seal.authorAttestationVS,
      authorSchemeVersion: seal.authorSchemeVersion,
      chainId: seal.chainId,
      kav10Address: seal.kav10Address,
      reservedKaId: seal.reservedKaId!,
      finalizedAtIso: seal.finalizedAtIso,
      contentScopeVersion: seal.contentScopeVersion!,
      kaUal: seal.kaUal!,
      assertionVersion: seal.assertionVersion!,
      publicTripleCount: seal.publicTripleCount!,
      privateTripleCount: seal.privateTripleCount!,
    }));
    const graphManager = new GraphManager(author.store);
    await storeKnowledgeAssetOperationPublicQuads({
      store: author.store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId,
      kaUal: canonicalSeal.kaUal,
      assertionVersion: canonicalSeal.assertionVersion,
      quads: publicQuads,
      privateTripleCount: 0,
      publisherPeerId: author.peerId,
      accessPolicy: 'ownerOnly',
      agentAddress: AUTHOR,
      timestamp: new Date('2026-07-19T12:35:00.000Z'),
    });
    await storeKnowledgeAssetWorkspaceHead({
      store: author.store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: canonicalSeal.kaUal,
      assertionVersion: canonicalSeal.assertionVersion,
      shareOperationId,
    });

    const scopeDigest = computeSwmAuthorInventoryScopeDigestV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
    });
    await expect(author.recordRfc64SwmAuthorInventoryShadowV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate,
      lifecycleAgentAddress: AUTHOR,
      shareOperationId,
    })).resolves.toMatchObject({ status: 'dormant', action: 'upsert', attempts: 0 });
    expect(author.readRfc64SwmAuthorInventorySnapshotV1({
      inventoryScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toBeNull();

    await storeKnowledgeAssetOperationPublicQuads({
      store: author.store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId,
      kaUal: canonicalSeal.kaUal,
      assertionVersion: canonicalSeal.assertionVersion,
      quads: publicQuads,
      privateTripleCount: 0,
      publisherPeerId: author.peerId,
      accessPolicy: 'public',
      agentAddress: AUTHOR,
      timestamp: new Date('2026-07-19T12:35:00.000Z'),
    });

    const conflictingAuthorQuad: Quad = {
      subject: assertionUri,
      predicate: ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS,
      object: '"0x9999999999999999999999999999999999999999"',
      graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
    };
    await author.store.insert([conflictingAuthorQuad]);
    await expect(author.recordRfc64SwmAuthorInventoryShadowV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate,
      lifecycleAgentAddress: AUTHOR,
      shareOperationId,
    })).resolves.toMatchObject({ status: 'failed', action: 'upsert', attempts: 0 });
    expect(author.readRfc64SwmAuthorInventorySnapshotV1({
      inventoryScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toBeNull();
    await author.store.deleteByPattern(conflictingAuthorQuad);

    const first = await author.recordRfc64SwmAuthorInventoryShadowV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate,
      lifecycleAgentAddress: AUTHOR,
      shareOperationId,
    });
    expect(first).toMatchObject({ status: 'applied', action: 'upsert', attempts: 1 });
    expect(author.readRfc64SwmAuthorInventorySnapshotV1({
      inventoryScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toMatchObject({
      head: { payload: { version: '0', totalRows: '1' } },
      rows: [{
        assertionCoordinate,
        assertionVersion: canonicalSeal.assertionVersion,
        kaUal: canonicalSeal.kaUal,
        shareOperationId,
        projectionDigest: computeKaProjectionDigestV1(
          encodeCanonicalCgSharedPublicRootProjectionV1(publicQuads),
        ),
        publicTripleCount: canonicalSeal.publicTripleCount,
        privateTripleCount: canonicalSeal.privateTripleCount,
        sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalSeal),
        sharedAt: new Date('2026-07-19T12:35:00.000Z').getTime().toString(),
        expiresAt: null,
      }],
    });
    await expect(author.recordRfc64SwmAuthorInventoryShadowV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate,
      lifecycleAgentAddress: AUTHOR,
      shareOperationId,
    })).resolves.toMatchObject({ status: 'existing', attempts: 1 });
    const firstCatalogReconcile = await author
      .reconcileRfc64PublicCatalogFromSwmInventoryV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress: AUTHOR,
      });
    expect(firstCatalogReconcile).toMatchObject({
      status: 'advanced',
      successorsApplied: 1,
      targetAssetCount: 1,
      appliedHead: { catalogVersion: '1', inventoryRowCount: '1' },
    });
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({
      status: 'existing',
      successorsApplied: 0,
      targetAssetCount: 1,
      appliedHead: { catalogVersion: '1', inventoryRowCount: '1' },
    });
    expect(author.rfc64SwmAuthorInventoryShadowStatusV1()).toMatchObject({
      attemptedUpserts: 3,
      appliedUpserts: 1,
      existingUpserts: 1,
      failed: 1,
    });

    const appliedBeforeWorkspaceDrift = author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    });
    await storeKnowledgeAssetWorkspaceHead({
      store: author.store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: canonicalSeal.kaUal,
      assertionVersion: canonicalSeal.assertionVersion,
      shareOperationId: 'different-durable-workspace-operation',
    });
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).rejects.toThrow(/durable catalog asset could not be resolved/u);
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toEqual(appliedBeforeWorkspaceDrift);
    await storeKnowledgeAssetWorkspaceHead({
      store: author.store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: canonicalSeal.kaUal,
      assertionVersion: canonicalSeal.assertionVersion,
      shareOperationId,
    });

    await author.stop();
    agents.splice(agents.indexOf(author), 1);
    const restarted = await startNativeAgent(
      'swm-shadow-author-restarted',
      NATIVE_DEPLOYMENT,
      dataDir,
      undefined,
      undefined,
      autoPublish,
    );
    vi.spyOn(restarted, 'getCustodialAgentPrivateKey').mockReturnValue(
      AUTHOR_WALLET.privateKey,
    );
    restarted.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    expect(restarted.readRfc64SwmAuthorInventorySnapshotV1({
      inventoryScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })?.rows).toHaveLength(1);
    await expect(restarted.removeRfc64SwmAuthorInventoryShadowV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      seal,
    })).resolves.toMatchObject({ status: 'applied', action: 'remove', attempts: 1 });
    expect(restarted.readRfc64SwmAuthorInventorySnapshotV1({
      inventoryScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toMatchObject({
      head: { payload: { version: '1', totalRows: '0' } },
      rows: [],
    });
    await expect(restarted.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({
      status: 'advanced',
      successorsApplied: 1,
      targetAssetCount: 0,
      appliedHead: { catalogVersion: '2', inventoryRowCount: '0' },
    });
    await expect(restarted.removeRfc64SwmAuthorInventoryShadowV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      seal,
    })).resolves.toMatchObject({ status: 'absent', action: 'remove', attempts: 1 });
    expect(restarted.rfc64SwmAuthorInventoryShadowStatusV1()).toMatchObject({
      attemptedRemovals: 2,
      appliedRemovals: 1,
      absentRemovals: 1,
      failed: 0,
    });

    const originalRecord = restarted.recordRfc64SwmAuthorInventoryShadowV1.bind(restarted);
    let releaseDelayedUpsert!: () => void;
    let markDelayedUpsertEntered!: () => void;
    const delayedUpsertGate = new Promise<void>((resolve) => {
      releaseDelayedUpsert = resolve;
    });
    const delayedUpsertEntered = new Promise<void>((resolve) => {
      markDelayedUpsertEntered = resolve;
    });
    const recordSpy = vi.spyOn(restarted, 'recordRfc64SwmAuthorInventoryShadowV1')
      .mockImplementation(async (params) => {
        markDelayedUpsertEntered();
        await delayedUpsertGate;
        return originalRecord(params);
      });
    const ctx = createOperationContext('share');
    await restarted.afterDurableSwmPromotionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate,
      lifecycleAgentAddress: AUTHOR,
      shareOperationId,
      ctx,
    });
    await delayedUpsertEntered;
    const confirmed = restarted.observeRfc64ConfirmedVmV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate,
      seal,
      assertionUri,
      ctx,
      publicationLabel: 'publish',
    });
    releaseDelayedUpsert();
    await confirmed;
    await restarted.awaitInFlightRfc64SwmInventoryObserversV1();
    recordSpy.mockRestore();
    expect(restarted.readRfc64SwmAuthorInventorySnapshotV1({
      inventoryScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })?.rows).toEqual([]);

    // A catalog reconciliation must fence the complete inventory snapshot it
    // resolved. Otherwise a slow one-row pass can land after a newer two-row
    // pass and regress the signed applied head back to the stale set.
    await restarted.store.insert(buildAssertionSealQuads({
      assertionUri,
      metaGraph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      merkleRoot: seal.merkleRoot,
      authorAddress: seal.authorAddress,
      authorAttestationR: seal.authorAttestationR,
      authorAttestationVS: seal.authorAttestationVS,
      authorSchemeVersion: seal.authorSchemeVersion,
      chainId: seal.chainId,
      kav10Address: seal.kav10Address,
      reservedKaId: seal.reservedKaId!,
      finalizedAtIso: seal.finalizedAtIso,
      contentScopeVersion: seal.contentScopeVersion!,
      kaUal: seal.kaUal!,
      assertionVersion: seal.assertionVersion!,
      publicTripleCount: seal.publicTripleCount!,
      privateTripleCount: seal.privateTripleCount!,
    }));
    const restartedGraphManager = new GraphManager(restarted.store);
    await storeKnowledgeAssetOperationPublicQuads({
      store: restarted.store,
      graphManager: restartedGraphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId,
      kaUal: canonicalSeal.kaUal,
      assertionVersion: canonicalSeal.assertionVersion,
      quads: publicQuads,
      privateTripleCount: 0,
      publisherPeerId: restarted.peerId,
      accessPolicy: 'public',
      agentAddress: AUTHOR,
      timestamp: new Date('2026-07-19T12:35:00.000Z'),
    });
    await storeKnowledgeAssetWorkspaceHead({
      store: restarted.store,
      graphManager: restartedGraphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: canonicalSeal.kaUal,
      assertionVersion: canonicalSeal.assertionVersion,
      shareOperationId,
    });
    await expect(restarted.recordRfc64SwmAuthorInventoryShadowV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate,
      lifecycleAgentAddress: AUTHOR,
      shareOperationId,
    })).resolves.toMatchObject({ status: 'applied' });
    await expect(restarted.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({ targetAssetCount: 1 });

    const secondAssertionCoordinate = 'swm-only-shadow-second';
    const secondShareOperationId = 'swm-only-shadow-operation-second';
    const secondCanonicalSeal = await authorSeal(22n, publicQuads);
    const secondSeal = assertionSealFromCanonical(secondCanonicalSeal);
    const secondAssertionUri = contextGraphAssertionUri(
      CONTEXT_GRAPH_ID,
      AUTHOR,
      secondAssertionCoordinate,
    );
    await restarted.store.insert(buildAssertionSealQuads({
      assertionUri: secondAssertionUri,
      metaGraph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      merkleRoot: secondSeal.merkleRoot,
      authorAddress: secondSeal.authorAddress,
      authorAttestationR: secondSeal.authorAttestationR,
      authorAttestationVS: secondSeal.authorAttestationVS,
      authorSchemeVersion: secondSeal.authorSchemeVersion,
      chainId: secondSeal.chainId,
      kav10Address: secondSeal.kav10Address,
      reservedKaId: secondSeal.reservedKaId!,
      finalizedAtIso: secondSeal.finalizedAtIso,
      contentScopeVersion: secondSeal.contentScopeVersion!,
      kaUal: secondSeal.kaUal!,
      assertionVersion: secondSeal.assertionVersion!,
      publicTripleCount: secondSeal.publicTripleCount!,
      privateTripleCount: secondSeal.privateTripleCount!,
    }));
    await storeKnowledgeAssetOperationPublicQuads({
      store: restarted.store,
      graphManager: restartedGraphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: secondShareOperationId,
      kaUal: secondCanonicalSeal.kaUal,
      assertionVersion: secondCanonicalSeal.assertionVersion,
      quads: publicQuads,
      privateTripleCount: 0,
      publisherPeerId: restarted.peerId,
      accessPolicy: 'public',
      agentAddress: AUTHOR,
      timestamp: new Date('2026-07-19T12:36:00.000Z'),
    });
    await storeKnowledgeAssetWorkspaceHead({
      store: restarted.store,
      graphManager: restartedGraphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: secondCanonicalSeal.kaUal,
      assertionVersion: secondCanonicalSeal.assertionVersion,
      shareOperationId: secondShareOperationId,
    });

    const originalResolveCatalogAsset = (restarted as any)
      .resolveRfc64SwmInventoryCatalogAssetV1.bind(restarted);
    let releaseStaleReconcile!: () => void;
    let markStaleReconcileEntered!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStaleReconcile = resolve; });
    const staleEntered = new Promise<void>((resolve) => { markStaleReconcileEntered = resolve; });
    const resolveCatalogAssetSpy = vi.spyOn(
      restarted as any,
      'resolveRfc64SwmInventoryCatalogAssetV1',
    ).mockImplementationOnce(async (...args: unknown[]) => {
      markStaleReconcileEntered();
      await staleGate;
      return originalResolveCatalogAsset(...args);
    });
    const staleReconcile = restarted.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    });
    await staleEntered;
    let secondRecordSettled = false;
    const secondRecord = restarted.recordRfc64SwmAuthorInventoryShadowV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: secondAssertionCoordinate,
      lifecycleAgentAddress: AUTHOR,
      shareOperationId: secondShareOperationId,
    }).finally(() => { secondRecordSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondRecordSettled).toBe(false);
    const currentReconcile = secondRecord.then(() => (
      restarted.reconcileRfc64PublicCatalogFromSwmInventoryV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress: AUTHOR,
      })
    ));
    releaseStaleReconcile();
    await expect(staleReconcile).resolves.toMatchObject({ targetAssetCount: 1 });
    await expect(secondRecord).resolves.toMatchObject({ status: 'applied' });
    await expect(currentReconcile).resolves.toMatchObject({
      targetAssetCount: 2,
      appliedHead: { inventoryRowCount: '2' },
    });
    resolveCatalogAssetSpy.mockRestore();
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({ inventoryRowCount: '2' });
  }, 60_000);

  it('normalizes legacy and selected auto-publish into one internal policy', () => {
    const chainIdentity = resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID);
    const selectedPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const activation = resolveRfc64PublicCatalogActivationConfigV1({
      enabled: true,
      autoPublish: {
        peers: ['12D3KooSelected'],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(selectedPolicy),
          targets: [],
        }],
      },
    }, chainIdentity);

    expect(resolveRfc64PublicCatalogControlsV1({ activation }, chainIdentity))
      .toMatchObject({
        autoPublishPolicy: {
          mode: 'selected-public',
          selectedContextGraphs: [CONTEXT_GRAPH_ID],
          config: { peers: ['12D3KooSelected'] },
        },
        requiresDataDir: true,
      });
    expect(resolveRfc64PublicCatalogControlsV1({
      legacyAutoPublish: {
        peers: ['12D3KooLegacy'],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    }, resolveRfc64PublicCatalogActivationChainIdentityV1(undefined)))
      .toMatchObject({
        autoPublishPolicy: {
          mode: 'all-accepted-public',
          config: { peers: ['12D3KooLegacy'] },
        },
        requiresDataDir: false,
      });
  });

  it('rejects a direct resolved activation whose selection differs from its manifest', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const activation = resolveRfc64PublicCatalogActivationConfigV1({
      enabled: true,
      deploymentProfile: NATIVE_DEPLOYMENT,
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
        }],
      },
    }, resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID));

    await expect(DKGAgent.create({
      name: 'split-selected-agent-config',
      networkIdentity: { networkId: 'rfc64-test', chainId: NETWORK_ID },
      rfc64PublicCatalogActivation: {
        ...activation,
        selectedContextGraphs: ['different-selection'],
      } as never,
    })).rejects.toThrow(/selected graphs differ from the bootstrap manifest/u);
  });

  it('projects raw selected activation into direct agent durable sync scope', async () => {
    const selectedPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const agent = await startNativeAgentWithOptions({
      name: 'direct-selected-sync-scope',
      activation: {
        enabled: true,
        deploymentProfile: NATIVE_DEPLOYMENT,
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(selectedPolicy),
            targets: [],
          }],
        },
      },
    });

    expect((agent as any).config.syncContextGraphs).toContain(CONTEXT_GRAPH_ID);
  });

  it('keeps a private catalog selection out of the legacy durable sync scope', async () => {
    const policy = privateCatalogPolicy();
    const policyEnvelope = {
      issuer: AUTHOR,
      objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
      payload: policy,
      signatureEvidence: { kind: 'none' },
      signatureSuite: 'eip191-personal-sign-digest-v1',
    } as UnsignedContextGraphPolicyEnvelopeV1;
    const policyDigest = computeContextGraphPolicyObjectDigestV1(policyEnvelope);
    const rosterEnvelope = {
      issuer: AUTHOR,
      objectType: MEMBER_ROSTER_OBJECT_TYPE_V1,
      payload: privateCatalogRoster(policy, policyDigest),
      signatureEvidence: { kind: 'none' },
      signatureSuite: 'eip191-personal-sign-digest-v1',
    } as UnsignedMemberRosterEnvelopeV1;
    const providerPeerId = '12D3KooPrivateCatalogProvider';
    const agent = await startNativeAgentWithOptions({
      name: 'direct-private-catalog-scope',
      catalogActivation: {
        enabled: true,
        deploymentProfile: NATIVE_DEPLOYMENT,
        accessPolicyAuthority: {
          localAgentAddress: AUTHOR,
          peerAgentBindings: [{ peerId: providerPeerId, agentAddress: AUTHOR }],
        },
        bootstrap: {
          acceptedPolicies: [{
            policyEnvelope,
            rosterEnvelope,
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
            completeSwmProviders: [providerPeerId],
          }],
        },
      },
    });

    expect((agent as any).config.syncContextGraphs).not.toContain(CONTEXT_GRAPH_ID);
  });

  it('projects a manifest-selected activation without an explicit enabled switch', async () => {
    const selectedPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const agent = await startNativeAgentWithOptions({
      name: 'direct-manifest-selected-sync-scope',
      activation: {
        deploymentProfile: NATIVE_DEPLOYMENT,
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(selectedPolicy),
            targets: [],
          }],
        },
      },
    });

    expect((agent as any).config.syncContextGraphs).toContain(CONTEXT_GRAPH_ID);
    expect((agent as any).config.rfc64PublicCatalogBootstrap).toBeDefined();
  });

  it('keeps direct disabled activation fail-closed even when stale controls are present', async () => {
    const ignoredPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const agent = await startNativeAgentWithOptions({
      name: 'direct-disabled-stale-controls',
      activation: {
        enabled: false,
        deploymentProfile: NATIVE_DEPLOYMENT,
        autoPublish: {
          peers: ['12D3KooIgnored'],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(ignoredPolicy),
            targets: [],
          }],
        },
      },
    });

    expect((agent as any).config.syncContextGraphs).not.toContain(CONTEXT_GRAPH_ID);
    expect((agent as any).config.rfc64PublicCatalogBootstrap).toBeUndefined();
    expect((agent as any).config.rfc64PublicCatalogAutoPublishPolicy).toBeUndefined();
  });

  it('snapshots a bounded public-root bootstrap manifest', () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const policyEnvelope = unsignedOpenContextGraphPolicyEnvelopeV1(policy);
    const providers = ['12D3KooPrimary'];
    const completeSwmProviders = ['12D3KooCompleteSwm'];
    const callerOwned: Rfc64PublicCatalogBootstrapConfigV1 = {
      acceptedPublicPolicies: [{
        policyEnvelope,
        targets: [{ authorAddress: AUTHOR, providers }],
        completeSwmProviders,
      }],
      retryIntervalMs: 1_000,
    };
    const snapshot = snapshotRfc64PublicCatalogBootstrapConfigV1(callerOwned)!;
    providers.push('12D3KooLateMutation');
    completeSwmProviders.push('12D3KooLateSwmMutation');

    expect(snapshot.acceptedPublicPolicies[0]?.targets[0]?.providers)
      .toEqual(['12D3KooPrimary']);
    expect(snapshot.acceptedPublicPolicies[0]?.completeSwmProviders)
      .toEqual(['12D3KooCompleteSwm']);
    expect(snapshot.acceptedPublicPolicies[0]?.policyEnvelope.payload).toEqual(policy);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.acceptedPublicPolicies[0]?.targets)).toBe(true);
    expect(Object.isFrozen(snapshot.acceptedPublicPolicies[0]?.targets[0]?.providers)).toBe(true);
    expect(Object.isFrozen(snapshot.acceptedPublicPolicies[0]?.completeSwmProviders)).toBe(true);
    expect(Object.isFrozen(snapshot.acceptedPublicPolicies[0]?.policyEnvelope.payload.source))
      .toBe(true);
    const providerResolver = DKGAgent.prototype.resolveRfc64CompleteSwmProviderPeerIdsV1;
    const resolverAgent = {
      config: { rfc64PublicCatalogBootstrap: snapshot },
    } as unknown as DKGAgent;
    expect(providerResolver.call(resolverAgent, CONTEXT_GRAPH_ID))
      .toEqual(['12D3KooCompleteSwm']);
    expect(providerResolver.call(
      resolverAgent,
      '0x2222222222222222222222222222222222222222/other' as ContextGraphIdV1,
    )).toEqual([]);
    expect(() => snapshotRfc64PublicCatalogBootstrapConfigV1({
      acceptedPublicPolicies: [{
        ...callerOwned.acceptedPublicPolicies[0]!,
        policyDigest: `0x${'11'.repeat(32)}`,
      }],
    } as unknown as Rfc64PublicCatalogBootstrapConfigV1)).toThrow(/unknown or missing fields/u);
  });

  it('dials and schedules every graph-complete SWM provider during bootstrap', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-complete-provider-bootstrap-'));
    tempDirs.push(dataDir);
    const receiver = await DKGAgent.create({
      name: 'complete-provider-bootstrap-receiver',
      dataDir,
      listenHost: '127.0.0.1',
      listenPort: 0,
      bootstrapPeers: [],
      store: new OxigraphStore(),
      syncOnConnectEnabled: false,
      syncReconcilerEnabled: false,
      syncContextGraphs: [CONTEXT_GRAPH_ID],
      agentProfileHeartbeatMs: 0,
      rfc64CatalogDeploymentProfile: NATIVE_DEPLOYMENT,
      rfc64PublicCatalogBootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
          completeSwmProviders: ['12D3KooWCompleteSwmProvider'],
        }],
      },
    });
    agents.push(receiver);
    const connect = vi.spyOn(receiver, 'connectToPeerId').mockResolvedValue();
    const queue = vi.spyOn(receiver, 'queueRfc64SwmRecoveryPlanFromPeerOnConnect')
      .mockReturnValue(true);

    await receiver.start();
    await receiver.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(connect).toHaveBeenCalledWith('12D3KooWCompleteSwmProvider', {
      timeoutMs: 10_000,
    });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPeerId: '12D3KooWCompleteSwmProvider',
        targets: [{ contextGraphId: CONTEXT_GRAPH_ID, lane: 'selected-public' }],
      }),
      expect.any(Function),
      0,
    );
  });

  it('schedules a pre-connected private complete provider on the ordinary SWM lane', async () => {
    const policy = privateCatalogPolicy();
    const policyEnvelope = {
      issuer: AUTHOR,
      objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
      payload: policy,
      signatureEvidence: { kind: 'none' },
      signatureSuite: 'eip191-personal-sign-digest-v1',
    } as UnsignedContextGraphPolicyEnvelopeV1;
    const rosterEnvelope = {
      issuer: AUTHOR,
      objectType: MEMBER_ROSTER_OBJECT_TYPE_V1,
      payload: privateCatalogRoster(
        policy,
        computeContextGraphPolicyObjectDigestV1(policyEnvelope),
      ),
      signatureEvidence: { kind: 'none' },
      signatureSuite: 'eip191-personal-sign-digest-v1',
    } as UnsignedMemberRosterEnvelopeV1;
    const providerPeerId = '12D3KooWPrivateCompleteProvider';
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-private-complete-provider-bootstrap-'));
    tempDirs.push(dataDir);
    const receiver = await DKGAgent.create({
      name: 'private-complete-provider-bootstrap-receiver',
      dataDir,
      listenHost: '127.0.0.1',
      listenPort: 0,
      bootstrapPeers: [],
      store: new OxigraphStore(),
      syncOnConnectEnabled: true,
      syncReconcilerEnabled: false,
      syncContextGraphs: [],
      agentProfileHeartbeatMs: 0,
      networkIdentity: {
        networkId: await computeNetworkId(),
        chainId: NATIVE_DEPLOYMENT.networkId,
      },
      rfc64CatalogActivation: {
        enabled: true,
        deploymentProfile: NATIVE_DEPLOYMENT,
        accessPolicyAuthority: {
          localAgentAddress: AUTHOR,
          peerAgentBindings: [{ peerId: providerPeerId, agentAddress: AUTHOR }],
        },
        bootstrap: {
          acceptedPolicies: [{
            policyEnvelope,
            rosterEnvelope,
            targets: [],
            completeSwmProviders: [providerPeerId],
          }],
        },
      },
    });
    agents.push(receiver);
    const connect = vi.spyOn(receiver, 'connectToPeerId').mockResolvedValue();
    const queue = vi.spyOn(receiver, 'queueRfc64SwmRecoveryPlanFromPeerOnConnect')
      .mockReturnValue(true);

    await receiver.start();
    await receiver.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(connect).toHaveBeenCalledWith(providerPeerId, { timeoutMs: 10_000 });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPeerId,
        targets: [{ contextGraphId: policy.contextGraphId, lane: 'ordinary-private' }],
      }),
      expect.any(Function),
      0,
    );
    await expect(receiver.planSharedMemorySyncContextGraphs(
      providerPeerId,
      [policy.contextGraphId],
      createOperationContext('sync'),
      { requireCompleteProviderMatch: true },
    )).resolves.toEqual({
      targets: [{ contextGraphId: policy.contextGraphId, lane: 'ordinary-private' }],
    });
  });

  it('does not reseed a plane-proven SWM provider on periodic bootstrap refresh', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-complete-provider-refresh-'));
    tempDirs.push(dataDir);
    const providerPeerId = '12D3KooWCompleteSwmProvider';
    const receiver = await DKGAgent.create({
      name: 'complete-provider-refresh-receiver',
      dataDir,
      listenHost: '127.0.0.1',
      listenPort: 0,
      bootstrapPeers: [],
      store: new OxigraphStore(),
      syncOnConnectEnabled: false,
      syncReconcilerEnabled: false,
      syncContextGraphs: [CONTEXT_GRAPH_ID],
      agentProfileHeartbeatMs: 0,
      rfc64CatalogDeploymentProfile: NATIVE_DEPLOYMENT,
      rfc64PublicCatalogBootstrap: {
        retryIntervalMs: 1_000,
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
          completeSwmProviders: [providerPeerId],
        }],
      },
    });
    agents.push(receiver);
    vi.spyOn(receiver, 'connectToPeerId').mockResolvedValue();
    const authorizedPlans: unknown[] = [];
    vi.spyOn(receiver, 'queueRfc64SwmRecoveryPlanFromPeerOnConnect')
      .mockImplementation((plan) => {
        const authorized = (receiver as any).rfc64SwmRecoveryCoordinatorV1.authorize(plan);
        if (authorized === null) return false;
        authorizedPlans.push(authorized);
        return true;
      });

    await receiver.start();
    await receiver.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(authorizedPlans).toHaveLength(1);
    expect((receiver as any).selectedSwmBootstrapAdmission.isRetryRequired(providerPeerId))
      .toBe(true);

    // Exact plane proof terminates only this peer + selected-graph scope.
    const completeOwner = (receiver as any).selectedSwmBootstrapAdmission.beginTransfer(
      providerPeerId,
      [CONTEXT_GRAPH_ID],
    );
    (receiver as any).selectedSwmBootstrapAdmission.markTransferTerminal(completeOwner);
    expect((receiver as any).selectedSwmBootstrapAdmission.isRetryRequired(providerPeerId))
      .toBe(false);
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.pass).toBeGreaterThanOrEqual(2);
    }, { timeout: 2_500, interval: 25 });
    await receiver.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(authorizedPlans).toHaveLength(1);
    expect((receiver as any).selectedSwmBootstrapAdmission.isRetryRequired(providerPeerId))
      .toBe(false);
  });

  it('re-admits an incomplete selected SWM provider on periodic bootstrap refresh', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-incomplete-provider-refresh-'));
    tempDirs.push(dataDir);
    const providerPeerId = '12D3KooWIncompleteSwmProvider';
    const receiver = await DKGAgent.create({
      name: 'incomplete-provider-refresh-receiver',
      dataDir,
      listenHost: '127.0.0.1',
      listenPort: 0,
      bootstrapPeers: [],
      store: new OxigraphStore(),
      syncOnConnectEnabled: false,
      syncReconcilerEnabled: false,
      syncContextGraphs: [CONTEXT_GRAPH_ID],
      agentProfileHeartbeatMs: 0,
      rfc64CatalogDeploymentProfile: NATIVE_DEPLOYMENT,
      rfc64PublicCatalogBootstrap: {
        retryIntervalMs: 1_000,
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
          completeSwmProviders: [providerPeerId],
        }],
      },
    });
    agents.push(receiver);
    vi.spyOn(receiver, 'connectToPeerId').mockResolvedValue();
    const authorizedPlans: unknown[] = [];
    vi.spyOn(receiver, 'queueRfc64SwmRecoveryPlanFromPeerOnConnect')
      .mockImplementation((plan) => {
        const authorized = (receiver as any).rfc64SwmRecoveryCoordinatorV1.authorize(plan);
        if (authorized === null) return false;
        authorizedPlans.push(authorized);
        return true;
      });

    await receiver.start();
    await receiver.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(authorizedPlans).toHaveLength(1);
    expect((receiver as any).selectedSwmBootstrapAdmission.isRetryRequired(providerPeerId))
      .toBe(true);

    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.pass).toBeGreaterThanOrEqual(2);
    }, { timeout: 2_500, interval: 25 });
    await receiver.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(authorizedPlans).toHaveLength(2);
    expect((receiver as any).selectedSwmBootstrapAdmission.isRetryRequired(providerPeerId))
      .toBe(true);
  });

  it('re-admits the same provider when a selected Context Graph is added later', async () => {
    const secondContextGraphId = (
      '0x2222222222222222222222222222222222222222/selected-later'
    ) as ContextGraphIdV1;
    const firstPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const secondPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: secondContextGraphId,
      ownerAddress: AUTHOR,
    });
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-provider-scope-growth-'));
    tempDirs.push(dataDir);
    const providerPeerId = '12D3KooWScopeAwareCompleteSwmProvider';
    const receiver = await DKGAgent.create({
      name: 'complete-provider-scope-growth-receiver',
      dataDir,
      listenHost: '127.0.0.1',
      listenPort: 0,
      bootstrapPeers: [],
      store: new OxigraphStore(),
      syncOnConnectEnabled: false,
      syncReconcilerEnabled: false,
      syncContextGraphs: [CONTEXT_GRAPH_ID],
      agentProfileHeartbeatMs: 0,
      rfc64CatalogDeploymentProfile: NATIVE_DEPLOYMENT,
      rfc64PublicCatalogBootstrap: {
        retryIntervalMs: 1_000,
        acceptedPublicPolicies: [firstPolicy, secondPolicy].map((policy) => ({
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
          completeSwmProviders: [providerPeerId],
        })),
      },
    });
    agents.push(receiver);
    vi.spyOn(receiver, 'connectToPeerId').mockResolvedValue();
    const authorizedPlans: Array<{
      targets: readonly Readonly<{ contextGraphId: string }>[];
    }> = [];
    vi.spyOn(receiver, 'queueRfc64SwmRecoveryPlanFromPeerOnConnect')
      .mockImplementation((plan) => {
        const authorized = (receiver as any).rfc64SwmRecoveryCoordinatorV1.authorize(plan);
        if (authorized === null) return false;
        authorizedPlans.push(authorized);
        return true;
      });

    await receiver.start();
    await receiver.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(authorizedPlans).toHaveLength(1);
    const firstScopeOwner = (receiver as any).selectedSwmBootstrapAdmission.beginTransfer(
      providerPeerId,
      [CONTEXT_GRAPH_ID],
    );
    (receiver as any).selectedSwmBootstrapAdmission.markTransferTerminal(firstScopeOwner);

    expect(receiver.trackSyncContextGraph(secondContextGraphId)).toBe(true);
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.pass).toBeGreaterThanOrEqual(2);
    }, { timeout: 2_500, interval: 25 });
    await receiver.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(authorizedPlans).toHaveLength(2);
    expect(authorizedPlans[1]?.targets.map(({ contextGraphId }) => contextGraphId)).toEqual(
      [CONTEXT_GRAPH_ID, secondContextGraphId].sort(),
    );
    expect((receiver as any).selectedSwmBootstrapAdmission.snapshot(providerPeerId)).toEqual({
      contextGraphIds: [CONTEXT_GRAPH_ID, secondContextGraphId].sort(),
      phase: 'retry-required',
    });
  });

  it('rejects bootstrap without persistence before node startup', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await expect(DKGAgent.create({
      name: 'ephemeral-bootstrap-is-invalid',
      rfc64PublicCatalogBootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [{ authorAddress: AUTHOR, providers: ['12D3KooProvider'] }],
        }],
      },
    })).rejects.toThrow(/rfc64PublicCatalogBootstrap requires dataDir/u);
  });

  it('rejects selected activation bootstrap without persistence before node startup', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const activation = resolveRfc64PublicCatalogActivationConfigV1({
      enabled: true,
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
        }],
      },
    }, resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID));
    await expect(DKGAgent.create({
      name: 'ephemeral-selected-activation-is-invalid',
      networkIdentity: { networkId: 'rfc64-test', chainId: NETWORK_ID },
      rfc64PublicCatalogActivation: activation,
    })).rejects.toThrow(/rfc64PublicCatalogBootstrap requires dataDir/u);
  });

  it('rejects selected activation mixed with a legacy catalog control', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const activation = resolveRfc64PublicCatalogActivationConfigV1({
      enabled: true,
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
        }],
      },
    }, resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID));
    await expect(DKGAgent.create({
      name: 'mixed-selected-and-legacy-controls',
      networkIdentity: { networkId: 'rfc64-test', chainId: NETWORK_ID },
      rfc64PublicCatalogActivation: activation,
      rfc64PublicCatalogAutoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    })).rejects.toThrow(/mutually exclusive/u);
  });

  it('does not let an activation deployment profile supply its own chain identity', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const activation = resolveRfc64PublicCatalogActivationConfigV1({
      enabled: true,
      deploymentProfile: NATIVE_DEPLOYMENT,
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
        }],
      },
    }, resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID));
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-self-bound-chain-'));
    tempDirs.push(dataDir);
    await expect(DKGAgent.create({
      name: 'self-bound-deployment-is-invalid',
      dataDir,
      rfc64PublicCatalogActivation: activation,
    })).rejects.toThrow(/requires an effective network id/u);
  });

  it('authors one explicit public catalog row and applies it on one cold receiver', async () => {
    const acceptedButUnselectedContextGraphId = (
      '0x1111111111111111111111111111111111111111/accepted-not-selected'
    ) as ContextGraphIdV1;
    const receiver = await startNativeAgentWithOptions({
      name: 'auto-publish-receiver',
      networkIdentityChainId: NETWORK_ID,
    });
    const selectedPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const author = await startNativeAgentWithOptions({
      name: 'auto-publish-author',
      activation: resolveRfc64PublicCatalogActivationConfigV1({
        enabled: true,
        deploymentProfile: NATIVE_DEPLOYMENT,
        autoPublish: {
          peers: [receiver.peerId],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(selectedPolicy),
            targets: [],
          }],
        },
      }, resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID)),
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    for (const agent of [author, receiver]) {
      agent.acceptOpenContextGraphPolicyV1({
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        ownerAddress: AUTHOR,
      });
    }
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: acceptedButUnselectedContextGraphId,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(author, receiver);

    const seal = assertionSealFromCanonical(await authorSeal(11n));
    const ignored = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: acceptedButUnselectedContextGraphId,
      assertionCoordinate: 'ordinary-confirmed-publication-other-cg' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: '',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: '',
        },
      ],
      seal,
    });
    expect(ignored).toBeNull();
    const acceptedButUnselectedScopeDigest = computeAuthorCatalogScopeDigestV1({
      networkId: NETWORK_ID,
      contextGraphId: acceptedButUnselectedContextGraphId,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0' as never,
      bucketCount: '1' as never,
    });
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: acceptedButUnselectedScopeDigest,
      authorAddress: AUTHOR,
    })).toBeNull();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: acceptedButUnselectedScopeDigest,
      authorAddress: AUTHOR,
    })).toBeNull();

    const first = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'ordinary-confirmed-publication' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: 'urn:ignored-local-graph',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: 'urn:ignored-local-graph',
        },
      ],
      seal,
    });
    expect(first).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const scopeDigest = catalogScopeDigest();
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toEqual(first);
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: first?.currentCatalogHeadDigest,
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 1,
      failed: 0,
    });

    const replay = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'ordinary-confirmed-publication' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: '',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: '',
        },
      ],
      seal,
    });
    expect(replay).toEqual(first);
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver.applied).toBe(1);

    const second = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'second-ordinary-confirmed-publication' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: '',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: '',
        },
      ],
      seal: assertionSealFromCanonical(await authorSeal(12n)),
    });
    expect(second).toMatchObject({ catalogVersion: '2', inventoryRowCount: '2' });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: second?.currentCatalogHeadDigest,
      catalogVersion: '2',
      inventoryRowCount: '2',
    });
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 2,
      failed: 0,
    });
  }, 60_000);

  it('canonicalizes literal lexical forms before explicit catalog projection verification', async () => {
    const author = await startNativeAgent(
      'auto-publish-canonical-literal',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const publicQuads = [{
      subject: 'https://example.org/alice',
      predicate: 'https://schema.org/age',
      object: '"042"^^<http://www.w3.org/2001/XMLSchema#integer>',
      graph: 'urn:ignored-local-graph',
    }];

    await expect(author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'ordinary-noncanonical-literal' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(13n, publicQuads)),
    })).resolves.toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
  }, 60_000);

  it('uses the chain signer for explicit catalog authoring when no custodial key is available', async () => {
    const author = await startNativeAgent(
      'auto-publish-chain-signer',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(undefined);
    const chain = (author as unknown as {
      chain: {
        signMessageAs?: (
          address: string,
          message: Uint8Array,
        ) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
      };
    }).chain;
    const signMessageAs = vi.fn(async (address: string, message: Uint8Array) => {
      expect(address).toBe(AUTHOR);
      const signature = ethers.Signature.from(await AUTHOR_WALLET.signMessage(message));
      return {
        r: ethers.getBytes(signature.r),
        vs: ethers.getBytes(signature.yParityAndS),
      };
    });
    chain.signMessageAs = signMessageAs;
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });

    await expect(author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'ordinary-chain-signed-publication' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: '',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: '',
        },
      ],
      seal: assertionSealFromCanonical(await authorSeal(14n)),
    })).resolves.toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
    expect(signMessageAs).toHaveBeenCalled();
  }, 60_000);

  it('does not expose an empty applied head when first-asset successor staging fails', async () => {
    const author = await startNativeAgent(
      'auto-publish-first-asset-retry',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const publicQuads = [
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
        graph: '',
      },
    ];
    const params = {
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'first-asset-retry' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(60n, publicQuads)),
    };
    const publishSuccessor = vi.spyOn(author, 'publishAuthorCatalogExactSetSuccessorV1')
      .mockRejectedValueOnce(new Error('simulated successor staging failure'));
    await expect(author.recordRfc64PublicCatalogAssetV1(params))
      .rejects.toThrow('simulated successor staging failure');
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();

    publishSuccessor.mockRestore();
    await expect(author.recordRfc64PublicCatalogAssetV1(params)).resolves.toMatchObject({
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
  }, 60_000);

  it('atomically serializes concurrent first-asset catalog upserts without losing a row', async () => {
    const receiver = await startNativeAgent('auto-publish-concurrent-receiver');
    const author = await startNativeAgent(
      'auto-publish-concurrent-author',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [receiver.peerId],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    for (const agent of [author, receiver]) {
      agent.acceptOpenContextGraphPolicyV1({
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        ownerAddress: AUTHOR,
      });
    }
    await connectBothWays(author, receiver);

    const publicQuads = [
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
        graph: '',
      },
    ];
    const kaNumbers = [61n, 62n] as const;
    const results = await Promise.all(kaNumbers.map(async (kaNumber, index) => (
      author.recordRfc64PublicCatalogAssetV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        assertionCoordinate: `concurrent-confirmed-${index + 1}` as never,
        publicQuads,
        seal: assertionSealFromCanonical(await authorSeal(kaNumber, publicQuads)),
      })
    )));
    expect(results).not.toContain(null);
    const first = results.find((result) => result?.catalogVersion === '1');
    const final = results.find((result) => result?.catalogVersion === '2');
    expect(final).toMatchObject({ catalogVersion: '2', inventoryRowCount: '2' });
    if (first === undefined || first === null || final === undefined || final === null) {
      throw new Error('concurrent catalog upserts did not produce both successors');
    }

    const scopeDigest = catalogScopeDigest();
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toEqual(final);
    await vi.waitFor(() => {
      expect(receiver.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: scopeDigest,
        authorAddress: AUTHOR,
      })?.currentCatalogHeadDigest).toBe(final.currentCatalogHeadDigest);
    }, { timeout: 20_000, interval: 100 });
    const evidence = receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      final.currentCatalogHeadDigest,
    );
    expect(evidence).toMatchObject({
      inventoryRowCount: 2,
      appliedHeadStatus: 'applied',
    });
    expect(new Set(evidence?.rows.map(({ kaId }) => kaId))).toEqual(new Set(
      kaNumbers.map((kaNumber) => ((BigInt(AUTHOR) << 96n) | kaNumber).toString()),
    ));
  }, 60_000);

  it('reconciles deterministic multi-step add, replacement, removal, and replay targets', async () => {
    const author = await startNativeAgent('r1-1-exact-reconcile-author');
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const scope = Object.freeze({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    }) as const;
    const firstSeal = await authorSeal(71n);
    const secondSeal = await authorSeal(72n);
    const firstAsset = Object.freeze({
      assertionCoordinate: 'r1-1-first' as never,
      projectionBytes: PROJECTION,
      seal: firstSeal,
    });
    const secondAsset = Object.freeze({
      assertionCoordinate: 'r1-1-second' as never,
      projectionBytes: PROJECTION,
      seal: secondSeal,
    });
    const common = {
      scope,
      author: AUTHOR_WALLET,
      deployment: NATIVE_DEPLOYMENT,
      peers: [],
      catalogIssuerDelegationEffectiveAt: '0' as TimestampMsV1,
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };

    await expect(author.reconcileRfc64PublicRootCatalogExactSetV1({
      ...common,
      assets: [secondAsset, firstAsset],
    })).resolves.toMatchObject({
      status: 'advanced',
      successorsApplied: 2,
      targetAssetCount: 2,
      appliedHead: { catalogVersion: '2', inventoryRowCount: '2' },
    });
    await expect(author.reconcileRfc64PublicRootCatalogExactSetV1({
      ...common,
      assets: [firstAsset, secondAsset],
    })).resolves.toMatchObject({
      status: 'existing',
      successorsApplied: 0,
      appliedHead: { catalogVersion: '2', inventoryRowCount: '2' },
    });

    const firstV2 = Object.freeze({
      ...firstAsset,
      seal: Object.freeze({ ...firstSeal, assertionVersion: '2' }) as never,
    });
    const appliedBeforeInvalidReplacement = author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    });
    await expect(author.reconcileRfc64PublicRootCatalogExactSetV1({
      ...common,
      assets: [{
        ...firstAsset,
        seal: Object.freeze({ ...firstSeal, assertionVersion: '3' }) as never,
      }, secondAsset],
    })).rejects.toThrow(/not the next assertion version/u);
    await expect(author.reconcileRfc64PublicRootCatalogExactSetV1({
      ...common,
      assets: [{
        ...firstV2,
        assertionCoordinate: 'r1-1-renamed-first' as never,
      }, secondAsset],
    })).rejects.toThrow(/not the next assertion version/u);
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toEqual(appliedBeforeInvalidReplacement);
    await expect(author.reconcileRfc64PublicRootCatalogExactSetV1({
      ...common,
      assets: [firstV2, secondAsset],
    })).resolves.toMatchObject({
      status: 'advanced',
      successorsApplied: 1,
      appliedHead: { catalogVersion: '3', inventoryRowCount: '2' },
    });
    await expect(author.reconcileRfc64PublicRootCatalogExactSetV1({
      ...common,
      assets: [firstV2],
    })).resolves.toMatchObject({
      status: 'advanced',
      successorsApplied: 1,
      appliedHead: { catalogVersion: '4', inventoryRowCount: '1' },
    });
    await expect(author.reconcileRfc64PublicRootCatalogExactSetV1({
      ...common,
      assets: [],
    })).resolves.toMatchObject({
      status: 'advanced',
      successorsApplied: 1,
      targetAssetCount: 0,
      appliedHead: { catalogVersion: '5', inventoryRowCount: '0' },
    });
  }, 60_000);

  registerM0RecoveryScenario('cold-restart', rfc64M0RecoveryTitle('cold-restart'), async () => {
    const author = await startNativeAgent(
      'bootstrap-author',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const accepted = author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const publicQuads = [
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
        graph: '',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
    ] as const;
    await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'bootstrap-publication-1' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(21n)),
    });
    const published = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'bootstrap-publication-2' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(22n)),
    });
    expect(published).toMatchObject({ catalogVersion: '2', inventoryRowCount: '2' });

    const bootstrap: Rfc64PublicCatalogBootstrapConfigV1 = {
      acceptedPublicPolicies: [{
        policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(accepted.policy),
        targets: [{ authorAddress: AUTHOR, providers: [author.peerId] }],
      }],
      retryIntervalMs: 1_000,
    };
    const receiverDataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-native-bootstrap-'));
    tempDirs.push(receiverDataDir);
    const persistentStorePath = join(receiverDataDir, 'oxigraph');
    const receiver = await startNativeAgentWithOptions({
      name: 'bootstrap-receiver',
      existingDataDir: receiverDataDir,
      bootstrap,
      persistentStorePath,
    });
    await connectBothWays(author, receiver);
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'applied',
        providerPeerId: author.peerId,
        appliedHeadDigest: published?.currentCatalogHeadDigest,
        catalogVersion: '2',
        inventoryRowCount: '2',
      });
    }, { timeout: 20_000, interval: 100 });
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: published?.currentCatalogHeadDigest,
      catalogVersion: '2',
      inventoryRowCount: '2',
    });

    await receiver.stop();
    agents.splice(agents.indexOf(receiver), 1);
    const restarted = await startNativeAgentWithOptions({
      name: 'bootstrap-receiver',
      existingDataDir: receiverDataDir,
      bootstrap,
      persistentStorePath,
    });
    await connectBothWays(author, restarted);
    await vi.waitFor(() => {
      expect(restarted.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'applied',
        providerPeerId: author.peerId,
        appliedHeadDigest: published?.currentCatalogHeadDigest,
        catalogVersion: '2',
        inventoryRowCount: '2',
      });
    }, { timeout: 20_000, interval: 100 });
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: published?.currentCatalogHeadDigest,
      catalogVersion: '2',
      inventoryRowCount: '2',
    });
  }, 60_000);

  registerM0RecoveryScenario('provider-failover', rfc64M0RecoveryTitle('provider-failover'), async () => {
    const emptyProvider = await startNativeAgent('bootstrap-empty-provider');
    const author = await startNativeAgent(
      'bootstrap-retry-author',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const accepted = author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    emptyProvider.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const bootstrap: Rfc64PublicCatalogBootstrapConfigV1 = {
      acceptedPublicPolicies: [{
        policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(accepted.policy),
        targets: [{
          authorAddress: AUTHOR,
          providers: [emptyProvider.peerId, author.peerId],
        }],
      }],
      retryIntervalMs: 1_000,
    };
    const receiver = await startNativeAgentWithOptions({
      name: 'bootstrap-retry-receiver',
      bootstrap,
    });
    await Promise.all([
      connectBothWays(emptyProvider, receiver),
      connectBothWays(author, receiver),
    ]);
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'not-found',
        attempts: 2,
        providerPeerId: null,
        appliedHeadDigest: null,
      });
    }, { timeout: 20_000, interval: 100 });

    const publicQuads = [
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
        graph: '',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
    ];
    const published = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'bootstrap-retry-publication' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(23n, publicQuads)),
    });
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()).toMatchObject({
        pass: expect.any(Number),
        targets: [expect.objectContaining({
          outcome: 'applied',
          attempts: 2,
          providerPeerId: author.peerId,
          appliedHeadDigest: published?.currentCatalogHeadDigest,
          inventoryRowCount: '1',
        })],
      });
    }, { timeout: 20_000, interval: 100 });
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })?.currentCatalogHeadDigest).toBe(published?.currentCatalogHeadDigest);
  }, 60_000);

  it('retains the last completed target while refreshing, then clears it on a miss', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const appliedHeadDigest = `0x${'a1'.repeat(32)}` as Digest32V1;
    const providerPeerId = '12D3KooStatusProvider';
    let resolveSecond!: (value: null) => void;
    const secondAttempt = new Promise<null>((resolve) => {
      resolveSecond = resolve;
    });
    const synchronize = vi.spyOn(
      DKGAgent.prototype,
      'synchronizeRfc64CatalogFromProvidersV1',
    ).mockResolvedValueOnce({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
      currentCatalogHeadDigest: appliedHeadDigest,
      appliedInventoryDigest: `0x${'b2'.repeat(32)}` as Digest32V1,
      catalogVersion: '2' as never,
      inventoryRowCount: '3' as never,
      providerPeerIds: [providerPeerId],
      appliedProviderPeerId: providerPeerId,
      providerAttempts: 1,
      signatureVariantDigest: `0x${'c3'.repeat(32)}` as Digest32V1,
    }).mockReturnValueOnce(secondAttempt);
    const bootstrap: Rfc64PublicCatalogBootstrapConfigV1 = {
      acceptedPublicPolicies: [{
        policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
        targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
      }],
      retryIntervalMs: 1_000,
    };
    const receiver = await startNativeAgentWithOptions({
      name: 'bootstrap-status-reset',
      bootstrap,
    });
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'applied',
        appliedHeadDigest,
        catalogVersion: '2',
        inventoryRowCount: '3',
      });
    }, { timeout: 10_000, interval: 50 });
    await vi.waitFor(() => {
      expect(synchronize).toHaveBeenCalledTimes(2);
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()).toMatchObject({
        running: true,
        targets: [expect.objectContaining({
          outcome: 'applied',
          appliedHeadDigest,
          catalogVersion: '2',
          inventoryRowCount: '3',
        })],
      });
    }, { timeout: 10_000, interval: 50 });
    resolveSecond(null);
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'not-found',
        attempts: 1,
        providerPeerId: null,
        appliedHeadDigest: null,
        catalogVersion: null,
        inventoryRowCount: null,
      });
    }, { timeout: 10_000, interval: 50 });
    expect(synchronize).toHaveBeenCalledTimes(2);
    synchronize.mockRestore();
  }, 30_000);

  it('reports configured provider attempts when bootstrap synchronization fails', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const synchronize = vi.spyOn(
      DKGAgent.prototype,
      'synchronizeRfc64CatalogFromProvidersV1',
    ).mockRejectedValue(new Error('simulated bootstrap synchronization failure'));
    const providers = ['12D3KooFailedProviderA', '12D3KooFailedProviderB'];
    const receiver = await startNativeAgentWithOptions({
      name: 'bootstrap-failed-attempt-count',
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [{ authorAddress: AUTHOR, providers }],
        }],
        retryIntervalMs: 60_000,
      },
    });

    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'failed',
        attempts: providers.length,
        providerPeerId: null,
        appliedHeadDigest: null,
      });
    }, { timeout: 10_000, interval: 50 });
    expect(synchronize).toHaveBeenCalledTimes(1);
    synchronize.mockRestore();
  }, 30_000);


  it('serializes mixed-case projection terms in raw UTF-8 order', async () => {
    const author = await startNativeAgent(
      'auto-publish-byte-order',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const publicQuads = [
      {
        subject: 'urn:a',
        predicate: 'https://schema.org/name',
        object: '"lowercase"',
        graph: '',
      },
      {
        subject: 'urn:Z',
        predicate: 'https://schema.org/name',
        object: '"uppercase"',
        graph: '',
      },
    ];
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'mixed-case-byte-order' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(31n, publicQuads)),
    });
    expect(applied).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
  }, 60_000);

  it('explicitly skips private-bearing assets in the public-only V1 authoring entrypoint', async () => {
    const author = await startNativeAgent(
      'auto-publish-private-skip',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const privateBearingSeal: AssertionSeal = {
      ...assertionSealFromCanonical(await authorSeal(32n)),
      privateTripleCount: 1,
      privateMerkleRoot: ethers.getBytes(`0x${'99'.repeat(32)}`),
    };
    await expect(author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'private-bearing-skip' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: '',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: '',
        },
      ],
      seal: privateBearingSeal,
    })).resolves.toBeNull();
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
  }, 60_000);


  it('snapshots the explicit access authority and fails closed before private activation', async () => {
    const resolver = async () => AUTHOR;
    const callerOwned = {
      localAgentAddress: ethers.getAddress(AUTHOR) as EvmAddressV1,
      resolveRemoteAgentAddress: resolver,
    };
    const snapshot = snapshotRfc64CatalogAccessPolicyAuthorityV1(callerOwned)!;
    callerOwned.localAgentAddress = ethers.ZeroAddress as EvmAddressV1;
    expect(snapshot).toEqual({
      localAgentAddress: AUTHOR,
      resolveRemoteAgentAddress: resolver,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => snapshotRfc64CatalogAccessPolicyAuthorityV1({
      localAgentAddress: ethers.ZeroAddress as EvmAddressV1,
      resolveRemoteAgentAddress: resolver,
    })).toThrow(/localAgentAddress is invalid/);

    const policy = privateCatalogPolicy();
    const policyDigest = `0x${'ab'.repeat(32)}` as Digest32V1;
    const roster = privateCatalogRoster(policy, policyDigest);
    const legacyOpenOnly = await startNativeAgent('private-denied');
    expect(() => legacyOpenOnly.acceptRfc64CatalogAccessSnapshotV1({
      policy,
      policyDigest,
      roster,
    })).toThrow(/requires explicit access-policy authority/);

    const configured = await startNativeAgent(
      'private-configured',
      NATIVE_DEPLOYMENT,
      undefined,
      {
        localAgentAddress: AUTHOR,
        resolveRemoteAgentAddress: resolver,
      },
    );
    expect(configured.acceptRfc64CatalogAccessSnapshotV1({
      policy,
      policyDigest,
      roster,
    })).toMatchObject({ policyDigest, roster: { policyDigest } });

    const privateGenesis = {
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: 'service-lane',
        authorAddress: AUTHOR,
        era: '0',
        bucketCount: '1',
      },
      author: AUTHOR_WALLET,
      peers: [],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    } as const;
    const published = await configured.publishAuthorCatalogGenesisV1({
      ...privateGenesis,
      peers: ['12D3KooPrivateReceiver'],
    });
    expect(published.announcedPeers).toEqual([]);
    expect(published.failedPeers).toHaveLength(1);
    expect(published.announcement).toMatchObject({
      policyDigest,
      subGraphName: 'service-lane',
      catalogEra: '0',
    });

    const privateSuccessor = {
      previousHead: {
        objectDigest: published.headObjectDigest,
        signatureVariantDigest: published.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: published.catalogIssuerAuthorization,
      assets: [{
        assertionCoordinate: 'private-subgraph-object' as never,
        projectionBytes: PROJECTION,
        seal: await authorSeal(7n),
      }],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [],
    } as const;
    await expect(configured.publishOpenAuthorCatalogExactSetSuccessorV1(privateSuccessor))
      .rejects.toThrow(/public\/open compatibility successor requires the root lane/u);
    const successor = await configured.publishAuthorCatalogExactSetSuccessorV1({
      ...privateSuccessor,
      peers: ['12D3KooPrivateReceiver'],
    });
    expect(successor.announcedPeers).toEqual([]);
    expect(successor.failedPeers).toHaveLength(1);
    expect(successor).toMatchObject({
      announcement: {
        policyDigest,
        subGraphName: 'service-lane',
        catalogEra: '0',
      },
      catalogScope: {
        subGraphName: 'service-lane',
        era: '0',
      },
      inventoryRowCount: '1',
    });
  }, 60_000);

  it('uses the trusted override to fetch provider content and durably apply native genesis', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('author'),
      startNativeAgent('receiver'),
    ]);
    const receiverPolicy = receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, receiver);

    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    expect(published.announcement.policyDigest).toBe(receiverPolicy.policyDigest);
    expect(published.announcedPeers).toEqual([]);
    const delivery = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [receiver.peerId],
    });
    expect(delivery.announcedPeers).toEqual([receiver.peerId]);
    expect(delivery.failedPeers).toEqual([]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const scopeDigest = catalogScopeDigest();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })).toMatchObject({
      catalogScopeDigest: scopeDigest,
      currentCatalogHeadDigest: published.headObjectDigest,
      catalogVersion: '0',
      inventoryRowCount: '0',
    });
    expect(receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toMatchObject({
      catalogHeadDigest: published.headObjectDigest,
      inventoryRowCount: 0,
      activatedTripleCount: 0,
      stagedObjectCount: 3,
      appliedHeadStatus: 'applied',
    });
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 1,
      stagedOnly: 0,
      failed: 0,
    });

    const replay = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [receiver.peerId],
    });
    expect(replay.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 1,
      dedupedAlreadyApplied: 1,
    });
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
  }, 60_000);

  it('reads the exact staged head variant to dedupe a durably applied multi-row set', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('multi-author'),
      startNativeAgent('multi-receiver'),
    ]);
    receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(author, receiver);

    const genesis = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const firstAsset = {
      assertionCoordinate: 'gate-2-object-1' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(7n),
    };
    const firstSuccessor = await author.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      ...firstAsset,
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [receiver.peerId],
    });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const successor = await author.publishAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: firstSuccessor.headObjectDigest,
        signatureVariantDigest: firstSuccessor.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [
        {
          assertionCoordinate: 'gate-2-object-2' as never,
          projectionBytes: PROJECTION,
          seal: await authorSeal(8n),
        },
        firstAsset,
      ],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SECOND_SUCCESSOR_ISSUED_AT,
      peers: [receiver.peerId],
    });
    expect(successor.inventoryRowCount).toBe('2');
    expect(successor.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const evidence = receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      successor.headObjectDigest,
    );
    expect(evidence).toMatchObject({
      catalogHeadDigest: successor.headObjectDigest,
      inventoryRowCount: 2,
      appliedHeadStatus: 'applied',
    });
    expect(evidence?.rows.map(({ kaId, bundleDigest }) => ({ kaId, bundleDigest }))).toEqual(
      successor.assets.map(({ kaId, bundleDigest }) => ({ kaId, bundleDigest })),
    );
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 3,
      dedupedAlreadyApplied: 0,
    });

    const replay = await author.announceRfc64PublicCatalogHeadV1({
      announcement: successor.announcement,
      peers: [receiver.peerId],
    });
    expect(replay.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 3,
      dedupedAlreadyApplied: 1,
    });

    const oneRow = await author.publishAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: successor.headObjectDigest,
        signatureVariantDigest: successor.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [firstAsset],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: '1773900003000' as TimestampMsV1,
      peers: [receiver.peerId],
    });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    const empty = await author.publishAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: oneRow.headObjectDigest,
        signatureVariantDigest: oneRow.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: '1773900004000' as TimestampMsV1,
      peers: [receiver.peerId],
    });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(empty).toMatchObject({
      inventoryRowCount: '0',
      signedBucketRowCount: '0',
      assets: [],
    });
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      empty.headObjectDigest,
    )).toBeNull();
    expect(receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      empty.headObjectDigest,
    )).toMatchObject({
      catalogHeadDigest: empty.headObjectDigest,
      inventoryRowCount: 0,
      activatedTripleCount: 0,
      rows: [],
      removedRowCount: 1,
      appliedHeadStatus: 'applied',
    });
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: empty.headObjectDigest,
      catalogVersion: '4',
      inventoryRowCount: '0',
    });
    for (const kaNumber of [7, 8]) {
      const swmGraph = contextGraphLayerUri(
        CONTEXT_GRAPH_ID,
        MemoryLayer.SharedWorkingMemory,
        AUTHOR,
        kaNumber,
      );
      await expect(receiver.store.query(
        `SELECT ?s WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } } LIMIT 1`,
      )).resolves.toMatchObject({ type: 'bindings', bindings: [] });
    }
  }, 60_000);

  it('preserves a single-provider discovery error without aggregation', async () => {
    class ProviderDiscoveryError extends Error {}
    const discoveryFailure = new ProviderDiscoveryError('provider discovery failed');
    const synchronizeCurrentCatalogHead = vi.fn().mockRejectedValue(discoveryFailure);
    const agentLike = {
      rfc64PublicCatalogServiceV1: { synchronizeCurrentCatalogHead },
    };

    await expect(DKGAgent.prototype.synchronizeRfc64PublicCatalogFromProviderV1.call(
      agentLike as never,
      {
        remotePeerId: 'provider-peer',
        scope: {
          networkId: NETWORK_ID,
          contextGraphId: CONTEXT_GRAPH_ID,
          subGraphName: null,
          authorAddress: AUTHOR,
          catalogEra: '0',
        },
      },
    )).rejects.toBe(discoveryFailure);
  });

  it('rejects every stale durable postcondition without a registered receiver failure', async () => {
    const selectedHeadDigest = `0x${'a1'.repeat(32)}` as Digest32V1;
    const selectedVersion = '3';
    const synchronized = {
      announcement: {
        authorAddress: AUTHOR,
        catalogHeadObjectDigest: selectedHeadDigest,
        catalogVersion: selectedVersion,
        signatureVariantDigest: `0x${'a2'.repeat(32)}`,
      },
      head: {
        envelope: {
          payload: {
            networkId: NETWORK_ID,
            contextGraphId: CONTEXT_GRAPH_ID,
            governanceChainId: null,
            governanceContractAddress: null,
            ownershipTransitionDigest: null,
            subGraphName: null,
            authorAddress: AUTHOR,
            era: '0',
            bucketCount: '1',
            catalogIssuerDelegationDigest: `0x${'a3'.repeat(32)}`,
            version: selectedVersion,
            previousHeadDigest: null,
            totalRows: '0',
            directoryHeight: '0',
            directoryRootDigest: `0x${'a4'.repeat(32)}`,
            issuedAt: FIXED_HEAD_ISSUED_AT,
          },
        },
      },
    };
    const staleAppliedSnapshots = [
      null,
      {
        currentCatalogHeadDigest: `0x${'a5'.repeat(32)}`,
        catalogVersion: selectedVersion,
      },
      {
        currentCatalogHeadDigest: selectedHeadDigest,
        catalogVersion: '2',
      },
    ];

    for (const applied of staleAppliedSnapshots) {
      const agentLike = {
        rfc64PublicCatalogServiceV1: {
          synchronizeCurrentCatalogHead: vi.fn().mockResolvedValue(synchronized),
        },
        rfc64PersistenceV1: {
          inventory: { readAppliedCatalogHeadV1: vi.fn(() => applied) },
        },
      };

      await expect(DKGAgent.prototype.synchronizeRfc64PublicCatalogFromProviderV1.call(
        agentLike as never,
        {
          remotePeerId: 'provider-peer',
          scope: {
            networkId: NETWORK_ID,
            contextGraphId: CONTEXT_GRAPH_ID,
            subGraphName: null,
            authorAddress: AUTHOR,
            catalogEra: '0',
          },
        },
      )).rejects.toThrow(/durable applied postcondition/u);
      expect(agentLike.rfc64PublicCatalogServiceV1.synchronizeCurrentCatalogHead)
        .toHaveBeenCalledOnce();
    }
  });

  it('cold-starts after publication from a provider current-head snapshot', async () => {
    const [author, provider] = await Promise.all([
      startNativeAgent('cold-author'),
      startNativeAgent('cold-provider'),
    ]);
    provider.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(author, provider);

    const genesis = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [provider.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    await provider.whenRfc64PublicCatalogReceiverIdleV1();
    const successor = await author.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assertionCoordinate: 'cold-current-snapshot' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(7n),
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [provider.peerId],
    });
    await provider.whenRfc64PublicCatalogReceiverIdleV1();
    expect(provider.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })?.currentCatalogHeadDigest).toBe(successor.headObjectDigest);

    // The third agent does not exist until after the successor is durable on
    // the provider, so it cannot have observed either publication hint.
    const cold = await startNativeAgent('cold-late-receiver');
    cold.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    expect(cold.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
    await connectBothWays(provider, cold);

    const synchronized = await cold.synchronizeRfc64PublicCatalogFromProviderV1({
      remotePeerId: provider.peerId,
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        catalogEra: '0',
      },
    });
    expect(synchronized).toMatchObject({
      providerPeerId: provider.peerId,
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
      currentCatalogHeadDigest: successor.headObjectDigest,
      signatureVariantDigest: successor.signatureVariantDigest,
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
    expect(cold.readRfc64PublicCatalogReconciliationFailureV1(
      successor.headObjectDigest,
    )).toBeNull();
    expect(cold.readRfc64PublicCatalogSynchronizationEvidenceV1(
      successor.headObjectDigest,
    )).toMatchObject({
      catalogHeadDigest: successor.headObjectDigest,
      inventoryRowCount: 1,
      activatedTripleCount: 2,
      removedRowCount: 0,
      appliedHeadStatus: 'applied',
    });
    expect(cold.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      scheduled: 1,
      applied: 1,
      failed: 0,
    });

    const swmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.SharedWorkingMemory,
      AUTHOR,
      7,
    );
    await expect((cold as any).store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
    )).resolves.toMatchObject({
      type: 'bindings',
      bindings: expect.arrayContaining([
        expect.objectContaining({ s: 'https://example.org/alice' }),
      ]),
    });
  }, 60_000);

  it('rejects the provider-sync API when scheduled semantic activation fails', async () => {
    const [author, provider] = await Promise.all([
      startNativeAgent('failure-author'),
      startNativeAgent('failure-provider'),
    ]);
    provider.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(author, provider);
    const genesis = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [provider.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    await provider.whenRfc64PublicCatalogReceiverIdleV1();
    const successor = await author.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assertionCoordinate: 'failure-current-snapshot' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(7n),
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [provider.peerId],
    });
    await provider.whenRfc64PublicCatalogReceiverIdleV1();

    const cold = await startNativeAgent('failure-late-receiver');
    cold.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(provider, cold);
    const replaceGraphAndSubject = vi.spyOn(
      (cold as any).store,
      'replaceGraphAndSubject',
    ).mockRejectedValue(new Error('simulated receiver semantic-activation failure'));

    const synchronizationFailure: unknown = await cold
      .synchronizeRfc64PublicCatalogFromProviderV1({
        remotePeerId: provider.peerId,
        scope: {
          networkId: NETWORK_ID,
          contextGraphId: CONTEXT_GRAPH_ID,
          subGraphName: null,
          authorAddress: AUTHOR,
          catalogEra: '0',
        },
      }).catch((error: unknown) => error);
    expect(synchronizationFailure).toBeInstanceOf(
      Rfc64CatalogReconciliationTerminalErrorV1,
    );
    expect(synchronizationFailure).toMatchObject({
      outcome: 'failed',
      terminalReason: null,
    });
    expect(replaceGraphAndSubject).toHaveBeenCalled();
    expect(cold.readRfc64PublicCatalogReconciliationFailureV1(
      successor.headObjectDigest,
    )).toEqual({
      catalogHeadDigest: successor.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-activation',
    });
    expect(cold.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
  }, 60_000);

  it('awaits production private retirement and reports a real finalized missing-placement path', async () => {
    const providerAgentAddress = `0x${'91'.repeat(20)}` as EvmAddressV1;
    const coldAgentAddress = `0x${'92'.repeat(20)}` as EvmAddressV1;
    const authorizedColdAgentAddress = `0x${'93'.repeat(20)}` as EvmAddressV1;
    const nonRosterAgentAddress = `0x${'94'.repeat(20)}` as EvmAddressV1;
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase();
    const firstAsset = Object.freeze({
      assertionRoot: ASSERTION_ROOT,
      assertionVersion: '1',
      authorAddress: AUTHOR,
      kaId: ((BigInt(AUTHOR) << 96n) | 41n).toString(),
      publisherAddress: AUTHOR,
    });
    const secondAsset = Object.freeze({
      assertionRoot: ASSERTION_ROOT,
      assertionVersion: '1',
      authorAddress: AUTHOR,
      kaId: ((BigInt(AUTHOR) << 96n) | 42n).toString(),
      publisherAddress: AUTHOR,
    });
    const fixture = (assets: readonly typeof firstAsset[]) => Object.freeze({
      accessPolicy: 1 as const,
      active: true,
      assertedAtChainId: NATIVE_DEPLOYMENT.assertedAtChainId,
      assertedAtKav10Address: KAV10,
      knowledgeAssetStorageAddress: KA_STORAGE,
      assets: Object.freeze([...assets]),
      blockHash: FINALIZED_BLOCK_HASH,
      blockNumberQuantity: '0x7c',
      contextGraphStorageAddress: CONTEXT_GRAPH_STORAGE,
      nameHash: nameHash as Digest32V1,
      networkId: NETWORK_ID,
      onChainContextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
      publishPolicy: 0 as const,
    } satisfies FinalizedVmLoopbackFixtureConfigV1);
    const emptyFixture = fixture([]);
    const providerFixture = fixture([firstAsset]);
    const coldFixture = fixture([firstAsset, secondAsset]);
    let providerRpc = createFinalizedVmLoopbackRpcV1(emptyFixture);
    const providerRpcServer = await rpcHarness.start((call, response) => {
      try {
        sendJsonRpcResult(response, call, providerRpc.respond(call.method, call.params));
      } catch (cause) {
        sendJsonRpcError(
          response,
          call,
          -32602,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    });
    const coldRpc = createFinalizedVmLoopbackRpcV1(coldFixture);
    const coldRpcServer = await rpcHarness.start((call, response) => {
      try {
        sendJsonRpcResult(response, call, coldRpc.respond(call.method, call.params));
      } catch (cause) {
        sendJsonRpcError(
          response,
          call,
          -32602,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    });

    const policy: ContextGraphPolicyV1 = {
      ...finalizedPublicCatalogPolicy({ publishPolicy: 0, publishAuthority: AUTHOR }),
      accessPolicy: 1,
    };
    const policyEnvelope = {
      issuer: CONTEXT_GRAPH_STORAGE,
      objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
      payload: policy,
      signatureEvidence: { kind: 'none' },
      signatureSuite: 'eip191-personal-sign-digest-v1',
    } as UnsignedContextGraphPolicyEnvelopeV1;
    const policyDigest = computeContextGraphPolicyObjectDigestV1(policyEnvelope);
    const roster: MemberRosterV1 = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownershipTransitionDigest: null,
      era: '0',
      version: '0',
      previousRosterDigest: null,
      policyDigest,
      administrativeDelegationDigest: null,
      members: [AUTHOR, providerAgentAddress, coldAgentAddress, authorizedColdAgentAddress]
        .map((agentAddress) => ({
        agentAddress,
        roles: ['holder', 'provider'] as const,
        })),
      issuedAt: policy.issuedAt,
    };
    const rosterEnvelope = {
      issuer: CONTEXT_GRAPH_STORAGE,
      objectType: MEMBER_ROSTER_OBJECT_TYPE_V1,
      payload: roster,
      signatureEvidence: { kind: 'none' },
      signatureSuite: 'eip191-personal-sign-digest-v1',
    } as UnsignedMemberRosterEnvelopeV1;

    const authorPeerAddresses = new Map<string, EvmAddressV1>();
    const author = await startNativeAgentWithOptions({
      name: 'private-incomplete-author',
      networkIdentityChainId: NETWORK_ID,
      accessPolicyAuthority: {
        localAgentAddress: AUTHOR,
        resolveRemoteAgentAddress: async (peerId) => authorPeerAddresses.get(peerId) ?? null,
      },
    });
    const providerAdapter = new FinalizedVmLoopbackMockChainAdapterV1(emptyFixture);
    await providerAdapter.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      nameHash,
    });
    const providerPeerAddresses = new Map<string, EvmAddressV1>([
      [author.peerId, AUTHOR],
    ]);
    let unboundColdAgentAddress = authorizedColdAgentAddress;
    const provider = await startNativeAgentWithOptions({
      name: 'private-incomplete-provider',
      networkIdentityChainId: NETWORK_ID,
      accessPolicyAuthority: {
        localAgentAddress: providerAgentAddress,
        resolveRemoteAgentAddress: async (peerId) => (
          providerPeerAddresses.get(peerId) ?? unboundColdAgentAddress
        ),
      },
      finalizedRuntime: {
        rpcUrl: providerRpcServer.url,
        chainAdapter: providerAdapter,
      },
    });
    authorPeerAddresses.set(provider.peerId, providerAgentAddress);
    for (const agent of [author, provider]) {
      agent.acceptRfc64CatalogAccessSnapshotV1({ policy, policyDigest, roster });
    }
    await connectBothWays(author, provider);
    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: CONTEXT_GRAPH_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as const;
    const genesis = await author.publishAuthorCatalogGenesisV1({
      scope,
      author: AUTHOR_WALLET,
      peers: [provider.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    await provider.whenRfc64PublicCatalogReceiverIdleV1();
    expect(provider.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
      authorAddress: AUTHOR,
    })?.currentCatalogHeadDigest).toBe(genesis.headObjectDigest);

    providerRpc = createFinalizedVmLoopbackRpcV1(providerFixture);
    const finalizedSeal = await authorSeal(41n);
    const successor = await author.publishAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [{
        assertionCoordinate: 'private-incomplete-41' as never,
        projectionBytes: PROJECTION,
        seal: finalizedSeal,
      }],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [provider.peerId],
    });
    await provider.whenRfc64PublicCatalogReceiverIdleV1();
    expect(provider.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
      authorAddress: AUTHOR,
    })?.currentCatalogHeadDigest).toBe(successor.headObjectDigest);

    const authorizedRpc = createFinalizedVmLoopbackRpcV1(providerFixture);
    const authorizedRpcServer = await rpcHarness.start((call, response) => {
      try {
        sendJsonRpcResult(response, call, authorizedRpc.respond(call.method, call.params));
      } catch (cause) {
        sendJsonRpcError(
          response,
          call,
          -32602,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    });
    const authorizedAdapter = new FinalizedVmLoopbackMockChainAdapterV1(providerFixture);
    await authorizedAdapter.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      nameHash,
    });
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    let signalRetirementStarted!: () => void;
    const retirementStarted = new Promise<void>((resolve) => {
      signalRetirementStarted = resolve;
    });
    let retirementClearCalls = 0;
    let preexistingTwin!: Awaited<ReturnType<typeof seedPreexistingFinalizedTwinV1>>;
    const authorizedCold = await startNativeAgentWithOptions({
      name: 'private-authorized-cold',
      finalizedRuntime: {
        rpcUrl: authorizedRpcServer.url,
        chainAdapter: authorizedAdapter,
        initialSubscription: CONTEXT_GRAPH_ID,
      },
      catalogActivation: {
        enabled: true,
        deploymentProfile: NATIVE_DEPLOYMENT,
        accessPolicyAuthority: {
          localAgentAddress: authorizedColdAgentAddress,
          peerAgentBindings: [{
            peerId: provider.peerId,
            agentAddress: providerAgentAddress,
          }],
        },
        bootstrap: {
          acceptedPolicies: [{
            policyEnvelope,
            rosterEnvelope,
            targets: [{ authorAddress: AUTHOR, providers: [provider.peerId] }],
            completeSwmProviders: [provider.peerId],
          }],
          retryIntervalMs: 0,
        },
      },
      beforeStart: async (agent) => {
        preexistingTwin = await seedPreexistingFinalizedTwinV1(agent, finalizedSeal);
        const clearPublishedKnowledgeAssetSwm =
          agent.publisher.clearPublishedKnowledgeAssetSwm.bind(agent.publisher);
        vi.spyOn(agent.publisher, 'clearPublishedKnowledgeAssetSwm')
          .mockImplementation(async (...args) => {
            retirementClearCalls += 1;
            // Catalog activation invalidates any previous memo. Recreate it at
            // the production retirement boundary so this assertion proves the
            // coordinator's post-clear invalidation, not activation's replace.
            expect(await writeSwmMaterializationWitness(
              agent.store,
              preexistingTwin.swmGraph,
              preexistingTwin.publicQuadsDigest,
            )).toBe(true);
            signalRetirementStarted();
            await retirementGate;
            await clearPublishedKnowledgeAssetSwm(...args);
          });
      },
    });
    providerPeerAddresses.set(authorizedCold.peerId, authorizedColdAgentAddress);
    const bootstrapIdle = authorizedCold.whenRfc64PublicCatalogBootstrapIdleV1();
    let bootstrapIdleSettled = false;
    void bootstrapIdle.then(
      () => { bootstrapIdleSettled = true; },
      () => { bootstrapIdleSettled = true; },
    );
    await retirementStarted;
    try {
      expect(bootstrapIdleSettled).toBe(false);
      expect(authorizedCold.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
        authorAddress: AUTHOR,
      })?.currentCatalogHeadDigest).toBe(successor.headObjectDigest);
      expect(await authorizedCold.store.countQuads(preexistingTwin.vmGraph))
        .toBe(PROJECTION_QUADS.length);
      expect(await authorizedCold.store.countQuads(preexistingTwin.swmGraph))
        .toBe(PROJECTION_QUADS.length);
      expect(await readSwmMaterializationWitness(
        authorizedCold.store,
        preexistingTwin.swmGraph,
        preexistingTwin.publicQuadsDigest,
      )).toBe(true);
    } finally {
      releaseRetirement();
    }
    await bootstrapIdle;
    expect(retirementClearCalls).toBe(1);
    expect(await authorizedCold.store.countQuads(preexistingTwin.vmGraph))
      .toBe(PROJECTION_QUADS.length);
    expect(await authorizedCold.store.countQuads(preexistingTwin.swmGraph)).toBe(0);
    expect(await readSwmMaterializationWitness(
      authorizedCold.store,
      preexistingTwin.swmGraph,
      preexistingTwin.publicQuadsDigest,
    )).toBe(false);
    expect(authorizedCold.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0])
      .toMatchObject({ outcome: 'applied', providerPeerId: provider.peerId });

    const recoveredNameQuery =
      'SELECT ?name WHERE { <https://example.org/alice> <https://schema.org/name> ?name }';
    const authorizedResult = await authorizedCold.query(recoveredNameQuery, {
      contextGraphId: CONTEXT_GRAPH_ID,
      view: 'verifiable-memory',
      callerAgentAddress: authorizedColdAgentAddress,
    });
    expect(authorizedResult.bindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '"Alice"' })]),
    );
    const deniedScopedResult = await authorizedCold.query(recoveredNameQuery, {
      contextGraphId: CONTEXT_GRAPH_ID,
      view: 'verifiable-memory',
      callerAgentAddress: nonRosterAgentAddress,
    });
    expect(deniedScopedResult.bindings).toEqual([]);
    const deniedUnscopedResult = await authorizedCold.query(
      'SELECT ?name WHERE { GRAPH ?g { <https://example.org/alice> '
        + '<https://schema.org/name> ?name } }',
      { callerAgentAddress: nonRosterAgentAddress },
    );
    expect(deniedUnscopedResult.bindings).toEqual([]);

    unboundColdAgentAddress = coldAgentAddress;
    const coldAdapter = new FinalizedVmLoopbackMockChainAdapterV1(coldFixture);
    await coldAdapter.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      nameHash,
    });
    const cold = await startNativeAgentWithOptions({
      name: 'private-incomplete-cold',
      finalizedRuntime: {
        rpcUrl: coldRpcServer.url,
        chainAdapter: coldAdapter,
        initialSubscription: CONTEXT_GRAPH_ID,
      },
      catalogActivation: {
        enabled: true,
        deploymentProfile: NATIVE_DEPLOYMENT,
        accessPolicyAuthority: {
          localAgentAddress: coldAgentAddress,
          peerAgentBindings: [{
            peerId: provider.peerId,
            agentAddress: providerAgentAddress,
          }],
        },
        bootstrap: {
          acceptedPolicies: [{
            policyEnvelope,
            rosterEnvelope,
            targets: [{ authorAddress: AUTHOR, providers: [provider.peerId] }],
            completeSwmProviders: [provider.peerId],
          }],
          retryIntervalMs: 0,
        },
      },
    });
    providerPeerAddresses.set(cold.peerId, coldAgentAddress);
    await cold.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(cold.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'known-incomplete',
      completionReason: 'no-authorized-provider',
      attempts: 1,
      providerPeerId: null,
      appliedHeadDigest: null,
    });
    expect(cold.readRfc64PublicCatalogReconciliationFailureV1(
      successor.headObjectDigest,
    )).toMatchObject({
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-activation',
      causeCode: 'finalized-vm-composition-incomplete',
    });
  }, 90_000);

  it('leaves the applied head null for finalized-chain policy in the dormant SWM-only lane', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('finalized-policy-author', NATIVE_DEPLOYMENT),
      startNativeAgent('finalized-policy-receiver', NATIVE_DEPLOYMENT),
    ]);
    const policy = finalizedPublicCatalogPolicy();
    for (const agent of [author, receiver]) {
      agent.acceptRfc64CatalogAccessSnapshotV1({
        policy,
        policyDigest: FINALIZED_POLICY_DIGEST,
        roster: null,
      });
    }
    await connectBothWays(author, receiver);

    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: CONTEXT_GRAPH_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as const;
    const genesis = await author.publishAuthorCatalogGenesisV1({
      scope,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    expect(genesis.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      genesis.headObjectDigest,
    )).toEqual({
      catalogHeadDigest: genesis.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-activation',
    });
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
      authorAddress: AUTHOR,
    })).toBeNull();
  }, 60_000);

  it('applies a finalized-policy SWM successor through production wiring without VM writes', async () => {
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase();
    const fixture = Object.freeze({
      accessPolicy: 0,
      active: true,
      assertedAtChainId: NATIVE_DEPLOYMENT.assertedAtChainId,
      assertedAtKav10Address: KAV10,
      knowledgeAssetStorageAddress: KA_STORAGE,
      assets: Object.freeze([]),
      blockHash: FINALIZED_BLOCK_HASH,
      blockNumberQuantity: '0x7c',
      contextGraphStorageAddress: CONTEXT_GRAPH_STORAGE,
      nameHash: nameHash as Digest32V1,
      networkId: NETWORK_ID,
      onChainContextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
      publishPolicy: 1,
    } satisfies FinalizedVmLoopbackFixtureConfigV1);
    const finalizedRpc = createFinalizedVmLoopbackRpcV1(fixture);
    const rpc = await rpcHarness.start((call, response) => {
      try {
        sendJsonRpcResult(response, call, finalizedRpc.respond(call.method, call.params));
      } catch (cause) {
        sendJsonRpcError(
          response,
          call,
          -32602,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    });
    const receiverChain = new FinalizedVmLoopbackMockChainAdapterV1(fixture);
    const privateVmDependencyLookup = vi.spyOn(
      receiverChain,
      'getDKGKnowledgeAssetsAddress',
    ).mockRejectedValue(new Error('public SWM must not require private VM dependencies'));
    await receiverChain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash,
    });
    const receiver = await startNativeAgent(
      'finalized-policy-production-receiver',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      {
        rpcUrl: rpc.url,
        chainAdapter: receiverChain,
        initialSubscription: CONTEXT_GRAPH_ID,
      },
    );
    const author = await startNativeAgent(
      'finalized-policy-production-author',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      {
        rpcUrl: rpc.url,
        chainAdapter: new FinalizedVmLoopbackMockChainAdapterV1(fixture),
      },
      {
        peers: [receiver.peerId],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(
      AUTHOR_WALLET.privateKey,
    );
    const policy = finalizedPublicCatalogPolicy();
    const policyEnvelope = {
      issuer: CONTEXT_GRAPH_STORAGE,
      objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
      payload: policy,
      signatureEvidence: { kind: 'none' },
      signatureSuite: 'eip191-personal-sign-digest-v1',
    } as UnsignedContextGraphPolicyEnvelopeV1;
    const policyDigest = computeContextGraphPolicyObjectDigestV1(policyEnvelope);
    for (const agent of [author, receiver]) {
      agent.acceptRfc64CatalogAccessSnapshotV1({ policy, policyDigest, roster: null });
    }
    await connectBothWays(author, receiver);

    const publicQuads = [{
      subject: 'https://example.org/policy-only',
      predicate: 'https://schema.org/name',
      object: '"Policy-only SWM"',
      graph: '',
    }];
    const kaNumber = 42n;
    const published = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'finalized-policy-production-success' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(kaNumber, publicQuads)),
    });
    if (published === null) throw new Error('explicit RFC-64 catalog authoring was not enabled');
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: CONTEXT_GRAPH_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as const;
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.currentCatalogHeadDigest,
    )).toBeNull();
    expect(privateVmDependencyLookup).not.toHaveBeenCalled();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: published.currentCatalogHeadDigest,
      inventoryRowCount: '1',
    });
    const swmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.SharedWorkingMemory,
      AUTHOR,
      Number(kaNumber),
    );
    const vmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      AUTHOR,
      Number(kaNumber),
    );
    await expect((receiver as any).store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
    )).resolves.toMatchObject({
      type: 'bindings',
      bindings: [expect.objectContaining({ s: 'https://example.org/policy-only' })],
    });
    await expect((receiver as any).store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
    )).resolves.toMatchObject({ type: 'bindings', bindings: [] });
  }, 60_000);

  registerM0RecoveryScenario('curated-parity', rfc64M0RecoveryTitle('curated-parity'), async () => {
    const kaNumbers = [41n] as const;
    const assets = kaNumbers.map((kaNumber) => Object.freeze({
      assertionRoot: ASSERTION_ROOT,
      assertionVersion: '1',
      authorAddress: AUTHOR,
      kaId: ((BigInt(AUTHOR) << 96n) | kaNumber).toString(),
      publisherAddress: AUTHOR,
    }));
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase();
    const fixture = Object.freeze({
      accessPolicy: 0,
      active: true,
      assertedAtChainId: NATIVE_DEPLOYMENT.assertedAtChainId,
      assertedAtKav10Address: KAV10,
      knowledgeAssetStorageAddress: KA_STORAGE,
      assets: Object.freeze(assets),
      blockHash: FINALIZED_BLOCK_HASH,
      blockNumberQuantity: '0x7c',
      contextGraphStorageAddress: CONTEXT_GRAPH_STORAGE,
      nameHash: nameHash as Digest32V1,
      networkId: NETWORK_ID,
      onChainContextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
      publishPolicy: 0,
    } satisfies FinalizedVmLoopbackFixtureConfigV1);
    const finalizedRpc = createFinalizedVmLoopbackRpcV1(fixture);
    const rpc = await rpcHarness.start((call, response) => {
      try {
        sendJsonRpcResult(response, call, finalizedRpc.respond(call.method, call.params));
      } catch (cause) {
        sendJsonRpcError(
          response,
          call,
          -32602,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    });
    const policy = finalizedPublicCatalogPolicy({
      publishPolicy: 0,
      publishAuthority: AUTHOR,
    });
    const warmDataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-release-warm-'));
    const coldDataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-release-cold-'));
    tempDirs.push(warmDataDir, coldDataDir);
    const warmStorePath = join(warmDataDir, 'oxigraph');
    const coldStorePath = join(coldDataDir, 'oxigraph');
    const startReleaseReceiver = async (
      name: string,
      dataDir: string,
      storePath: string,
      bootstrapConfig?: Rfc64PublicCatalogBootstrapConfigV1,
    ): Promise<DKGAgent> => {
      const chainAdapter = new FinalizedVmLoopbackMockChainAdapterV1(fixture);
      await chainAdapter.createOnChainContextGraph({
        accessPolicy: 0,
        publishPolicy: 0,
        nameHash,
      });
      return startNativeAgentWithOptions({
        name,
        existingDataDir: dataDir,
        finalizedRuntime: {
          rpcUrl: rpc.url,
          chainAdapter,
          initialSubscription: CONTEXT_GRAPH_ID,
        },
        bootstrap: bootstrapConfig,
        persistentStorePath: storePath,
      });
    };

    // The warm receiver exists before the publisher and before any catalog head.
    let warm = await startReleaseReceiver('release-proof-warm', warmDataDir, warmStorePath);
    const policyEnvelope = {
      issuer: CONTEXT_GRAPH_STORAGE,
      objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
      payload: policy,
      signatureEvidence: { kind: 'none' },
      signatureSuite: 'eip191-personal-sign-digest-v1',
    } as UnsignedContextGraphPolicyEnvelopeV1;
    const policyDigest = computeContextGraphPolicyObjectDigestV1(policyEnvelope);
    warm.acceptRfc64CatalogAccessSnapshotV1({
      policy,
      policyDigest,
      roster: null,
    });
    const author = await startNativeAgent(
      'release-proof-author',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      {
        rpcUrl: rpc.url,
        chainAdapter: new FinalizedVmLoopbackMockChainAdapterV1(fixture),
      },
      {
        peers: [warm.peerId],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(
      AUTHOR_WALLET.privateKey,
    );
    author.acceptRfc64CatalogAccessSnapshotV1({
      policy,
      policyDigest,
      roster: null,
    });
    const bootstrap: Rfc64PublicCatalogBootstrapConfigV1 = {
      acceptedPublicPolicies: [{
        policyEnvelope,
        targets: [{ authorAddress: AUTHOR, providers: [author.peerId] }],
      }],
      retryIntervalMs: 1_000,
    };
    await connectBothWays(author, warm);
    await warm.awaitInitialChainPoll();

    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: CONTEXT_GRAPH_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as const;
    const publicQuads = [
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
        graph: '',
      },
    ];
    const published = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'release-proof-1' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(kaNumbers[0], publicQuads)),
    });
    if (published === null) throw new Error('release proof catalog bridge was not enabled');

    const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
    const expectExactReleaseState = async (receiver: DKGAgent): Promise<void> => {
      expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
        published.currentCatalogHeadDigest,
      )).toBeNull();
      expect(receiver.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: scopeDigest,
        authorAddress: AUTHOR,
      })).toMatchObject({
        currentCatalogHeadDigest: published.currentCatalogHeadDigest,
        catalogVersion: published.catalogVersion,
        inventoryRowCount: '1',
      });
      for (const kaNumber of kaNumbers) {
        const swmGraph = contextGraphLayerUri(
          CONTEXT_GRAPH_ID,
          MemoryLayer.SharedWorkingMemory,
          AUTHOR,
          Number(kaNumber),
        );
        const vmGraph = contextGraphLayerUri(
          CONTEXT_GRAPH_ID,
          MemoryLayer.VerifiableMemory,
          AUTHOR,
          Number(kaNumber),
        );
        await expect((receiver as any).store.query(
          `SELECT ?s ?p ?o WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
        )).resolves.toMatchObject({
          type: 'bindings',
          bindings: expect.arrayContaining([
            expect.objectContaining({ s: 'https://example.org/alice' }),
          ]),
        });
        await expect((receiver as any).store.query(
          `SELECT ?s ?p ?o WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
        )).resolves.toMatchObject({ type: 'bindings', bindings: [] });
      }
    };
    await vi.waitFor(() => {
      expect(warm.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: scopeDigest,
        authorAddress: AUTHOR,
      })?.currentCatalogHeadDigest).toBe(published.currentCatalogHeadDigest);
    }, { timeout: 20_000, interval: 100 });
    await expectExactReleaseState(warm);

    // The cold receiver starts only after the finalized head exists.
    let cold = await startReleaseReceiver(
      'release-proof-cold',
      coldDataDir,
      coldStorePath,
      bootstrap,
    );
    await connectBothWays(author, cold);
    await cold.awaitInitialChainPoll();
    await vi.waitFor(() => {
      expect(cold.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'applied',
        providerPeerId: author.peerId,
        appliedHeadDigest: published.currentCatalogHeadDigest,
        inventoryRowCount: '1',
      });
    }, { timeout: 20_000, interval: 100 });
    await expectExactReleaseState(cold);

    // Prove durability before any provider or bootstrap path can repopulate the warm receiver.
    for (const receiver of [warm, cold]) {
      await receiver.stop();
      agents.splice(agents.indexOf(receiver), 1);
    }
    warm = await startReleaseReceiver(
      'release-proof-warm',
      warmDataDir,
      warmStorePath,
    );
    await warm.awaitInitialChainPoll();
    await expectExactReleaseState(warm);

    // Keep a separate restart assertion for the configured cold-bootstrap role.
    cold = await startReleaseReceiver(
      'release-proof-cold',
      coldDataDir,
      coldStorePath,
      bootstrap,
    );
    await connectBothWays(author, cold);
    await cold.awaitInitialChainPoll();
    await vi.waitFor(() => {
      expect(cold.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'applied',
        providerPeerId: author.peerId,
        appliedHeadDigest: published.currentCatalogHeadDigest,
        inventoryRowCount: '1',
      });
    }, { timeout: 20_000, interval: 100 });
    await Promise.all([
      expectExactReleaseState(warm),
      expectExactReleaseState(cold),
    ]);
  }, 90_000);

  it('exposes bounded typed failure evidence when wire scope differs from local deployment', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('mismatch-author'),
      startNativeAgent('mismatch-receiver', {
        ...NATIVE_DEPLOYMENT,
        networkId: 'base:8453' as NetworkIdV1,
      }),
    ]);
    receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, receiver);
    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    expect(published.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })).toBeNull();
    expect(receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 0,
      failed: 1,
    });
    const failure = receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    );
    expect(failure).toEqual({
      catalogHeadDigest: published.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-authorization',
    });
    expect(Object.isFrozen(failure)).toBe(true);

    await receiver.stop();
    agents.splice(agents.indexOf(receiver), 1);
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
  }, 60_000);

  it('rejects a stale-network durable dedupe after restart under a new local pin', async () => {
    const receiverDataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-native-repin-'));
    tempDirs.push(receiverDataDir);
    const [author, firstReceiver] = await Promise.all([
      startNativeAgent('repin-author'),
      startNativeAgent('repin-receiver', NATIVE_DEPLOYMENT, receiverDataDir),
    ]);
    firstReceiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, firstReceiver);
    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [firstReceiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    await firstReceiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(firstReceiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })?.currentCatalogHeadDigest).toBe(published.headObjectDigest);

    await firstReceiver.stop();
    agents.splice(agents.indexOf(firstReceiver), 1);
    const restartedReceiver = await startNativeAgent('repin-receiver', {
      ...NATIVE_DEPLOYMENT,
      networkId: 'base:8453' as NetworkIdV1,
    }, receiverDataDir);
    restartedReceiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, restartedReceiver);
    const delivery = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [restartedReceiver.peerId],
    });
    expect(delivery.announcedPeers).toEqual([restartedReceiver.peerId]);
    await restartedReceiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(restartedReceiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 0,
      dedupedAlreadyApplied: 0,
      failed: 1,
    });
    expect(restartedReceiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(restartedReceiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toEqual({
      catalogHeadDigest: published.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-authorization',
    });
  }, 60_000);

});

describe('RFC-64 M0 recovery scenarios', () => {
  it('registers the complete structural M0 recovery scenario set', () => {
    expect([...registeredRfc64M0RecoveryScenarios.keys()].sort()).toEqual(
      [...RFC64_M0_RECOVERY_SCENARIOS].sort(),
    );
  });

  for (const scenario of RFC64_M0_RECOVERY_SCENARIOS) {
    const spec = registeredRfc64M0RecoveryScenarios.get(scenario);
    if (spec === undefined) {
      throw new Error(`Missing RFC-64 M0 recovery scenario registration: ${scenario}`);
    }
    const scenarioIt = activeRfc64M0RecoveryScenario === undefined
      || activeRfc64M0RecoveryScenario === scenario
      ? it
      : it.skip;
    scenarioIt(spec.title, spec.handler, spec.timeout);
  }
});

async function authorSeal(
  kaNumber: bigint,
  publicQuads?: readonly Quad[],
): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const kaUal = `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`;
  const assertionMerkleRoot = publicQuads === undefined
    ? ASSERTION_ROOT
    : ethers.hexlify(computeFlatKCRootV10([...publicQuads], [])) as Digest32V1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(NATIVE_DEPLOYMENT.assertedAtChainId),
    kav10Address: NATIVE_DEPLOYMENT.assertedAtKav10Address,
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
    assertedAtChainId: NATIVE_DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal,
    assertionVersion: '1',
    publicTripleCount: String(publicQuads?.length ?? 2),
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
    ...(seal.privateMerkleRoot === null
      ? {}
      : { privateMerkleRoot: ethers.getBytes(seal.privateMerkleRoot) }),
    privateTripleCount: Number(seal.privateTripleCount),
    rootEntities: [],
  };
}
