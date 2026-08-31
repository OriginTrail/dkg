import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAssertionSealQuads,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  computeNetworkId,
  computeSwmAuthorInventoryScopeDigestV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createOperationContext,
  type AssertionSeal,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { afterEach, expect } from 'vitest';

import { DKGAgent } from '../../src/index.js';
import type {
  Rfc64PublicCatalogActivationInputV1,
} from '../../src/rfc64/public-catalog-activation-config-v1.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '../../src/rfc64/open-catalog-policy-v1.js';
import type {
  Rfc64PublicCatalogAutoPublishConfigV1,
  Rfc64PublicCatalogBootstrapConfigV1,
} from '../../src/dkg-agent-types.js';

export const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
export const NETWORK_ID = 'otp:20430' as NetworkIdV1;
export const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-wiring' as ContextGraphIdV1;
export const LEGACY_CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/legacy-repair' as ContextGraphIdV1;
export const REMOTE_AUTHOR =
  '0x9999999999999999999999999999999999999999' as EvmAddressV1;
export const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
export const NATIVE_DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;
export const PROJECTION_QUADS: readonly Quad[] = Object.freeze([
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

export const agents: DKGAgent[] = [];
export const tempDirs: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best effort */ }
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

interface StartRepairAgentOptionsV1 {
  readonly name: string;
  readonly dataDir?: string;
  readonly storePath?: string;
  readonly syncContextGraphs?: readonly string[];
  readonly autoPublish?: Rfc64PublicCatalogAutoPublishConfigV1;
  readonly bootstrap?: Rfc64PublicCatalogBootstrapConfigV1;
  readonly activation?: Rfc64PublicCatalogActivationInputV1;
  readonly beforeStart?: (agent: DKGAgent) => void | Promise<void>;
}

export async function startRepairAgentV1(
  options: StartRepairAgentOptionsV1,
): Promise<DKGAgent> {
  const dataDir = options.dataDir
    ?? await mkdtemp(join(tmpdir(), `dkg-rfc64-repair-${options.name}-`));
  if (options.dataDir === undefined) tempDirs.push(dataDir);
  const agent = await DKGAgent.create({
    name: options.name,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(options.storePath),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
    syncContextGraphs: options.syncContextGraphs
      ?? (options.activation !== undefined && options.activation.enabled !== false
        ? options.activation.bootstrap?.acceptedPublicPolicies.map(
          ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId,
        ) ?? []
        : []),
    ...(options.activation === undefined ? {} : {
      networkIdentity: {
        networkId: await computeNetworkId(),
        chainId: NATIVE_DEPLOYMENT.networkId,
      },
    }),
    ...(options.activation === undefined ? {
      rfc64CatalogDeploymentProfile: NATIVE_DEPLOYMENT,
      rfc64PublicCatalogAutoPublish: options.autoPublish,
      rfc64PublicCatalogBootstrap: options.bootstrap,
    } : {
      rfc64PublicCatalogActivation: options.activation,
    }),
  });
  agents.push(agent);
  await options.beforeStart?.(agent);
  await agent.start();
  return agent;
}

export function catalogScopeDigestV1(): Digest32V1 {
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  });
}

export function bootstrapConfigV1(
  retryIntervalMs?: number,
  includeRemoteTarget = true,
): Rfc64PublicCatalogBootstrapConfigV1 {
  const policy = buildOpenOwnerContextGraphPolicyV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR,
  });
  return {
    acceptedPublicPolicies: [{
      policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
      targets: includeRemoteTarget ? [{
        authorAddress: AUTHOR,
        providers: ['12D3KooWRepairProvider'],
      }] : [],
    }],
    ...(retryIntervalMs === undefined ? {} : { retryIntervalMs }),
  };
}

export async function authorSealV1(
  kaNumber: bigint,
): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const assertionMerkleRoot = ethers.hexlify(
    computeFlatKCRootV10([...PROJECTION_QUADS], []),
  ) as Digest32V1;
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
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: String(PROJECTION_QUADS.length),
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

export function assertionSealV1(seal: CanonicalGraphScopedAuthorSealV1): AssertionSeal {
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

export async function seedInventoryAssetV1(
  agent: DKGAgent,
  suffix: string,
  reservedKaId: bigint,
): Promise<Readonly<{ seal: AssertionSeal; scopeDigest: Digest32V1 }>> {
  const assertionCoordinate = `repair-${suffix}`;
  const shareOperationId = `repair-operation-${suffix}`;
  const canonicalSeal = await authorSealV1(reservedKaId);
  const seal = assertionSealV1(canonicalSeal);
  const assertionUri = contextGraphAssertionUri(
    CONTEXT_GRAPH_ID,
    AUTHOR,
    assertionCoordinate,
  );
  await agent.store.insert(buildAssertionSealQuads({
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
  const graphManager = new GraphManager(agent.store);
  await storeKnowledgeAssetOperationPublicQuads({
    store: agent.store,
    graphManager,
    contextGraphId: CONTEXT_GRAPH_ID,
    shareOperationId,
    kaUal: canonicalSeal.kaUal,
    assertionVersion: canonicalSeal.assertionVersion,
    quads: PROJECTION_QUADS,
    privateTripleCount: 0,
    publisherPeerId: agent.peerId,
    accessPolicy: 'public',
    agentAddress: AUTHOR,
    timestamp: new Date('2026-07-19T12:35:00.000Z'),
  });
  await storeKnowledgeAssetWorkspaceHead({
    store: agent.store,
    graphManager,
    contextGraphId: CONTEXT_GRAPH_ID,
    kaUal: canonicalSeal.kaUal,
    assertionVersion: canonicalSeal.assertionVersion,
    shareOperationId,
  });
  await expect(agent.recordRfc64SwmAuthorInventoryShadowV1({
    contextGraphId: CONTEXT_GRAPH_ID,
    assertionCoordinate,
    lifecycleAgentAddress: AUTHOR,
    shareOperationId,
  })).resolves.toMatchObject({ status: 'applied' });
  return Object.freeze({
    seal,
    scopeDigest: computeSwmAuthorInventoryScopeDigestV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
    }),
  });
}
