// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { multiaddr } from '@multiformats/multiaddr';
import {
  DKG_ONTOLOGY,
  canonicalizeContextGraphPolicyPayloadV1,
  canonicalizeMemberRosterPayloadV1,
  computeAuthorCatalogScopeDigestV1,
  computeNetworkId,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  decodeOpaqueKaBundleV1,
  encodeOpaqueKaBundleV1,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  composeRfc64FinalizedCatalogAuthorityV1,
  parseRfc64AuthoritySnapshotV1,
} from '../../src/rfc64/release-native-catalog-authority-v1.ts';
import {
  Rfc64PrivateDevnetChainAdapter,
  startRfc64PrivateDevnetFinalizedRpc,
} from './finalized-chain-fixture.mjs';
import {
  ASSET_NUMBERS,
  CONTEXT_GRAPH_ID,
  CONTEXT_GRAPH_STORAGE,
  DEPLOYMENT,
  NETWORK_ID,
  ON_CHAIN_CONTEXT_GRAPH_ID,
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  PRIVATE_MEMBER_ROLES,
  RUNTIME_ROLES,
  UPDATED_ASSERTION_ROOT,
  UPDATED_PROJECTION,
  UPDATED_PROJECTION_QUADS,
  createCatalogAssets,
  createFinalizedChainFixture,
  createPrivatePolicyAndRoster,
  createReceiverRevokedPolicyAndRoster,
  ownerWallet,
  privateCatalogSwmShareOperationId,
  roleAgentAddress,
  rolePrivateKey,
} from './fixture.mjs';
import { classifyExpectedPrivateCatalogDenialV1 } from './denial-evidence.mjs';
import { sealExecutedRuntimeManifestV1 } from '../../../../devnet/rfc64-runtime-load-hook.mts';
import {
  hasExactPrivateCatalogMemoryContents,
  readPrivateCatalogWorkspaceMemoryEvidenceV1,
} from './memory-evidence.mjs';
import {
  RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1,
  childCommandDescriptorV1,
  defineChildCommandHandlersV1,
  dispatchChildCommandV1,
} from './child-protocol.mjs';
import { assertInitialFinalizedAuthorityV1 } from './initial-authority.mjs';
import { readVerifiedAppliedCatalogMemoryEvidenceV1 } from './verified-catalog-swm-proof.mjs';
import { emitAuthoritativeRuntimeShutdownReceiptV1 } from './runtime-shutdown.mjs';

const ROLE = requiredEnv('DKG_RFC64_PRIVATE_ROLE');
const MODE = requiredEnv('DKG_RFC64_PRIVATE_MODE');
const DATA_DIR = requiredEnv('DKG_RFC64_PRIVATE_DATA_DIR');
const RUNTIME_MANIFEST_DIGEST = requiredEnv('DKG_RFC64_RUNTIME_MANIFEST_DIGEST');
const MANIFEST_PATH = process.env.DKG_RFC64_PRIVATE_MANIFEST;
const AUTHORITY_FAULT = process.env.DKG_RFC64_PRIVATE_AUTHORITY_FAULT;
const CATALOG_PROOF_FAULT = process.env.DKG_RFC64_PRIVATE_CATALOG_PROOF_FAULT;

let agent;
let chainAdapter;
let rpc;
let stopping = false;
let runtimePeerIds;
let initialFinalizedAuthority;
let publishedCatalogScope;
let baselineCatalogAssets;

function emit(event, requestId, fields = {}) {
  process.stdout.write(`RFC64_PRIVATE_EVENT ${JSON.stringify({
    event,
    role: ROLE,
    ...(requestId === undefined ? {} : { requestId }),
    ...fields,
  })}\n`);
}

async function boot() {
  if (
    CATALOG_PROOF_FAULT !== undefined
    && CATALOG_PROOF_FAULT !== 'inventory-digest'
    && CATALOG_PROOF_FAULT !== 'expected-assets'
    && CATALOG_PROOF_FAULT !== 'duplicate-expected-assets'
    && CATALOG_PROOF_FAULT !== 'missing-bundle'
    && CATALOG_PROOF_FAULT !== 'mismatched-bundle'
  ) {
    throw new Error('unsupported RFC-64 private catalog proof fault injection');
  }
  if (MODE === 'probe') {
    agent = await createAgent(undefined, false);
    await agent.start();
    emit(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready, undefined, readyFields());
    return;
  }
  if (MODE !== 'run' || MANIFEST_PATH === undefined) {
    throw new Error('runtime mode requires a manifest');
  }
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  runtimePeerIds = manifest.peerIds;
  agent = await createAgent(manifest, true);
  await agent.start();
  const responsibility = await agent.reconcileRfc64CatalogResponsibilityV1(
    CONTEXT_GRAPH_ID,
  );
  if (
    ROLE !== 'outsider'
    && (!responsibility.active || responsibility.mode === 'legacy')
  ) {
    throw new Error('real graph did not enter release-native RFC-64 responsibility');
  }
  if (ROLE === 'outsider' && responsibility.active) {
    throw new Error('nonmember unexpectedly entered RFC-64 catalog responsibility');
  }
  const acceptedAuthority = await agent.reconcileRfc64CatalogAccessAuthorityV1(
    CONTEXT_GRAPH_ID,
  );
  if (acceptedAuthority === null || chainAdapter === undefined) {
    throw new Error('real graph produced no release-native finalized authority');
  }
  const onChainContextGraphId = BigInt(ON_CHAIN_CONTEXT_GRAPH_ID);
  const finalizedAuthority = composeRfc64FinalizedCatalogAuthorityV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    snapshot: parseRfc64AuthoritySnapshotV1(
      await chainAdapter.getContextGraphAuthoritySnapshot(onChainContextGraphId),
      onChainContextGraphId,
    ),
  });
  const expected = createPrivatePolicyAndRoster();
  initialFinalizedAuthority = assertInitialFinalizedAuthorityV1({
    acceptedAuthority,
    finalizedAuthority,
    expectedAuthority: {
      policy: expected.policy,
      policyDigest: expected.policyDigest,
      roster: expected.roster,
      source: 'finalized-chain',
    },
  });
  emit(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready, undefined, readyFields());
}

async function createAgent(manifest, finalizedRuntime) {
  const canonicalFixture = createFinalizedChainFixture();
  const fixture = AUTHORITY_FAULT === 'omit-receiver'
    ? Object.freeze({
      ...canonicalFixture,
      participantAgents: Object.freeze(canonicalFixture.participantAgents.filter(
        (address) => address !== roleAgentAddress('receiver'),
      )),
    })
    : canonicalFixture;
  if (
    AUTHORITY_FAULT !== undefined
    && AUTHORITY_FAULT !== 'omit-receiver'
    && AUTHORITY_FAULT !== 'revocation-chain-noop'
    && AUTHORITY_FAULT !== 'revocation-over-removal'
  ) {
    throw new Error('unsupported RFC-64 private authority fault injection');
  }
  let chainRuntime = {};
  if (finalizedRuntime) {
    chainAdapter = new Rfc64PrivateDevnetChainAdapter(fixture, {
      participantRemovalAlsoRemoves: AUTHORITY_FAULT === 'revocation-over-removal'
        ? roleAgentAddress('owner')
        : undefined,
      participantRemovalNoop: AUTHORITY_FAULT === 'revocation-chain-noop',
    });
    await chainAdapter.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: fixture.ownerAddress,
      publishAuthorityAccountId: 0n,
      participantAgents: fixture.participantAgents,
      nameHash: fixture.nameHash,
    });
    rpc = await startRfc64PrivateDevnetFinalizedRpc(fixture, {
      readAuthoritySnapshot: () => chainAdapter.getContextGraphAuthoritySnapshot(
        BigInt(ON_CHAIN_CONTEXT_GRAPH_ID),
      ),
    });
    chainRuntime = {
      chainAdapter,
      chainConfig: {
        rpcUrl: rpc.url,
        hubAddress: CONTEXT_GRAPH_STORAGE,
        operationalKeys: [rolePrivateKey(ROLE)],
      },
      contextGraphSubscriptionStore: seededSubscriptionStore(
        CONTEXT_GRAPH_ID,
        ON_CHAIN_CONTEXT_GRAPH_ID,
      ),
    };
  }
  const base = {
    name: `RFC64PrivateReleaseGate-${ROLE}`,
    dataDir: DATA_DIR,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(join(DATA_DIR, 'oxigraph')),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: true,
    agentProfileHeartbeatMs: 0,
    ...chainRuntime,
  };
  if (manifest === undefined) return DKGAgent.create(base);

  const peerIds = manifest.peerIds;
  const agentAddressByPeerId = new Map(RUNTIME_ROLES.map((role) => [
    peerIds[role],
    roleAgentAddress(role),
  ]));
  const accessPolicyAuthority = {
    localAgentAddress: roleAgentAddress(ROLE),
    resolveRemoteAgentAddress: async (peerId) => agentAddressByPeerId.get(peerId) ?? null,
  };
  const created = await DKGAgent.create({
    ...base,
    networkIdentity: {
      networkId: await computeNetworkId(),
      chainId: NETWORK_ID,
    },
    // This fixture-only resolver binds authenticated process identities. It
    // supplies no policy or roster; the real graph remains exclusively
    // chain-discovered through release-native authority reconciliation.
    rfc64CatalogAccessPolicyAuthority: accessPolicyAuthority,
    rfc64CatalogActivation: {
      enabled: true,
      deploymentProfile: DEPLOYMENT,
      rollout: {
        contextGraphModes: { [CONTEXT_GRAPH_ID]: 'catalog' },
      },
    },
  });
  await seedPrivateCatalogDefinition(created, peerIds);
  return created;
}

function readyFields() {
  const address = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('agent has no TCP multiaddr');
  return {
    agentClass: agent.constructor.name,
    peerId: agent.peerId,
    multiaddr: address,
    catalogServiceStarted: agent.rfc64PublicCatalogStatsV1()?.started === true,
    runtimeBuildManifestDigest: RUNTIME_MANIFEST_DIGEST,
    ...(initialFinalizedAuthority === undefined ? {} : {
      authoritySource: initialFinalizedAuthority.source,
      authorityPolicyDigest: initialFinalizedAuthority.policyDigest,
      authorityRosterVersion: initialFinalizedAuthority.roster.version,
      authorityMembers: initialFinalizedAuthority.roster.members.map(
        ({ agentAddress }) => agentAddress,
      ),
    }),
  };
}

async function handle(command) {
  const { descriptor } = await dispatchChildCommandV1(
  CHILD_COMMAND_HANDLERS,
  command,
  emit,
  );
  if (descriptor.command === 'stop') {
    await shutdown(0, command.requestId, descriptor.responseEvent);
  }
}

const CHILD_COMMAND_HANDLERS = defineChildCommandHandlersV1({
  dial: async (command) => {
    await agent.node.libp2p.dial(multiaddr(command.multiaddr));
    return { peerId: command.peerId };
  },
  publish: () => publishCatalogBaseline(),
  'publish-update': () => publishCatalogUpdate(),
  'wait-bootstrap': (command) => waitForBootstrap(command),
  inspect: (command) => inspect(command.expectedHeadDigest),
  'inspect-persisted': (command) => inspect(
    command.expectedHeadDigest,
    { includeNonmemberQuery: false },
  ),
  'sync-denied': (command) => proveDenied(command),
  'revoke-receiver': () => revokeReceiver(),
  stop: async () => Object.freeze({}),
});

async function publishCatalogBaseline() {
  if (ROLE !== 'owner') throw new Error('only the owner role can publish');
  if (publishedCatalogScope !== undefined) throw new Error('catalog baseline already published');
  const { policy, policyDigest } = createPrivatePolicyAndRoster();
  const scope = {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: policy.governanceChainId,
    governanceContractAddress: policy.governanceContractAddress,
    ownershipTransitionDigest: policy.ownershipTransitionDigest,
    subGraphName: null,
    authorAddress: roleAgentAddress('owner'),
    era: policy.era,
    bucketCount: '1',
  };
  const assets = await createCatalogAssets();
  baselineCatalogAssets = assets;
  publishedCatalogScope = scope;
  let applied;
  for (const asset of assets) {
    applied = await agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      scope,
      author: ownerWallet(),
      asset,
      deployment: DEPLOYMENT,
      peers: [],
      catalogIssuerDelegationEffectiveAt: '0',
      catalogIssuerDelegationExpiresAt: '1893456000000',
    });
  }
  return publishedFields(applied, policyDigest, scope);
}

async function publishCatalogUpdate() {
  if (ROLE !== 'owner') throw new Error('only the owner role can publish');
  if (publishedCatalogScope === undefined || baselineCatalogAssets === undefined) {
    throw new Error('catalog update requires a published finalized-VM baseline');
  }
  const { policyDigest } = createPrivatePolicyAndRoster();
  // The catalog establishes the finalized VM baseline first. These staged
  // version-2 snapshots represent a later, not-yet-finalized SWM generation,
  // so finalized version-1 twin retirement must preserve them.
  for (const [index, asset] of baselineCatalogAssets.entries()) {
    const kaNumber = ASSET_NUMBERS[index];
    if (kaNumber === undefined) throw new Error('catalog fixture asset number is missing');
    await agent.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: privateCatalogSwmShareOperationId(kaNumber),
      kaUal: asset.seal.kaUal,
      assertionVersion: '2',
      quads: UPDATED_PROJECTION_QUADS,
      privateTripleCount: 0,
      publisherPeerId: agent.peerId,
      accessPolicy: 'ownerOnly',
      agentAddress: roleAgentAddress('owner'),
      timestamp: new Date(),
    });
  }
  const updatedAssets = await createCatalogAssets({
    assertionRoot: UPDATED_ASSERTION_ROOT,
    assertionVersion: '2',
    projectionBytes: UPDATED_PROJECTION,
  });
  let applied;
  for (const asset of updatedAssets) {
    applied = await agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      scope: publishedCatalogScope,
      author: ownerWallet(),
      asset,
      deployment: DEPLOYMENT,
      peers: [],
      catalogIssuerDelegationEffectiveAt: '0',
      catalogIssuerDelegationExpiresAt: '1893456000000',
    });
  }
  return publishedFields(applied, policyDigest, publishedCatalogScope);
}

function publishedFields(applied, policyDigest, scope) {
  if (applied === undefined) throw new Error('catalog upsert produced no applied head');
  return {
    headObjectDigest: applied.currentCatalogHeadDigest,
    policyDigest,
    catalogVersion: applied.catalogVersion,
    inventoryRowCount: applied.inventoryRowCount,
    scopeDigest: computeAuthorCatalogScopeDigestV1(scope),
  };
}

async function waitForBootstrap(command) {
  const timeoutMs = boundedTimeout(command.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let last;
  let attempts = 0;
  const providerRole = ROLE === 'provider2' ? 'owner' : 'provider2';
  const providerPeerId = runtimePeerIds?.[providerRole];
  if (providerPeerId === undefined) {
    throw new Error(`${ROLE} has no configured catalog provider`);
  }
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      last = await agent.synchronizeRfc64CatalogFromProvidersV1({
        remotePeerIds: [providerPeerId],
        scope: {
          networkId: NETWORK_ID,
          contextGraphId: CONTEXT_GRAPH_ID,
          subGraphName: null,
          authorAddress: roleAgentAddress('owner'),
          catalogEra: '0',
        },
      });
    } catch (error) {
      last = { error: boundedErrorChain(error) };
    }
    const bootstrapApplied = last !== null
      && last.error === undefined
      && (
        command.expectedHeadDigest === undefined
        || last.currentCatalogHeadDigest === command.expectedHeadDigest
      );
    const exactMemory = command.expectedMemory === 'finalized-vm-v1'
      ? await hasExactLocalFinalizedVmBaseline()
      : await hasExactLocalMemoryContents({
        catalogVersion: last?.catalogVersion,
        exactExpectedHead: bootstrapApplied,
      });
    if (bootstrapApplied && exactMemory) {
      return {
        outcome: 'applied',
        providerPeerId: last.appliedProviderPeerId ?? providerPeerId,
        appliedHeadDigest: last.currentCatalogHeadDigest,
        catalogVersion: last.catalogVersion,
        inventoryRowCount: last.inventoryRowCount,
        attempts,
      };
    }
    await delay(100);
  }
  const graphCounts = await readPrivateCatalogWorkspaceMemoryEvidenceV1(agent.store, {
    assetNumbers: ASSET_NUMBERS,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorAddress: roleAgentAddress('owner'),
    networkId: NETWORK_ID,
  });
  const registeredAuthority = await agent.resolveRegisteredContextGraphAuthority(
    CONTEXT_GRAPH_ID,
  ).catch((error) => ({ error: boundedErrorChain(error) }));
  const memberRecoveryGate = await agent.getMemberRecoveryGate(
    CONTEXT_GRAPH_ID,
  ).catch((error) => ({ error: boundedErrorChain(error) }));
  throw new Error(
    `bootstrap did not converge; graphCounts=${JSON.stringify(graphCounts)}; `
    + `memberRecoveryGate=${JSON.stringify(memberRecoveryGate)}; `
    + `registeredAuthority=${JSON.stringify(registeredAuthority, bigintToDecimal)}; `
    + `last=${JSON.stringify(last)}`,
  );
}

async function hasExactLocalFinalizedVmBaseline() {
  const graphCounts = await readPrivateCatalogWorkspaceMemoryEvidenceV1(agent.store, {
    assetNumbers: ASSET_NUMBERS,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorAddress: roleAgentAddress('owner'),
    networkId: NETWORK_ID,
  });
  return graphCounts.length === ASSET_NUMBERS.length
    && graphCounts.every((entry, index) => (
      entry.kaNumber === ASSET_NUMBERS[index]
      && entry.swm === 0
      && entry.swmProof?.kind === 'absent'
      && entry.vm === PRIVATE_CATALOG_MEMORY_EXPECTATION.vm.projection.count
      && entry.vmDigest === PRIVATE_CATALOG_MEMORY_EXPECTATION.vm.projection.digest
      && entry.vmHead?.assertionVersion
        === PRIVATE_CATALOG_MEMORY_EXPECTATION.vm.assertionVersion
      && entry.vmHead.assertionGraph === entry.vmGraph
    ));
}

async function hasExactLocalMemoryContents(catalogEvidence = {}) {
  const authorAddress = roleAgentAddress('owner');
  const scope = privateCatalogScope(authorAddress);
  const applied = agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    authorAddress,
  });
  const graphCounts = await readVerifiedAppliedCatalogMemoryV1(applied, scope);
  return hasExactPrivateCatalogMemoryContents(
    {
      appliedHeadDigest: applied?.currentCatalogHeadDigest,
      graphCounts,
      ...catalogEvidence,
    },
    PRIVATE_CATALOG_MEMORY_EXPECTATION,
  );
}

async function inspect(expectedHeadDigest, { includeNonmemberQuery = true } = {}) {
  const authorAddress = roleAgentAddress('owner');
  const scope = privateCatalogScope(authorAddress);
  const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const applied = agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: scopeDigest,
    authorAddress,
  });
  const graphCounts = ROLE === 'owner' || applied === null
    ? await readPrivateCatalogWorkspaceMemoryEvidenceV1(agent.store, {
        assetNumbers: ASSET_NUMBERS,
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress,
        networkId: NETWORK_ID,
      })
    : await readVerifiedAppliedCatalogMemoryV1(applied, scope);
  const outsiderResult = ROLE === 'outsider' || !includeNonmemberQuery
    ? null
    : await agent.query(
      'SELECT ?name WHERE { <https://example.org/alice> <https://schema.org/name> ?name }',
      {
        contextGraphId: CONTEXT_GRAPH_ID,
        view: 'verifiable-memory',
        callerAgentAddress: roleAgentAddress('outsider'),
      },
    );
  return {
    appliedHeadDigest: applied?.currentCatalogHeadDigest ?? null,
    catalogVersion: applied?.catalogVersion ?? null,
    inventoryRowCount: applied?.inventoryRowCount ?? null,
    exactExpectedHead: expectedHeadDigest === undefined
      ? null
      : applied?.currentCatalogHeadDigest === expectedHeadDigest,
    graphCounts,
    outsiderVisibleVmBindings: includeNonmemberQuery
      ? outsiderResult?.bindings?.length ?? 0
      : null,
    receiverStats: agent.rfc64PublicCatalogStatsV1()?.receiver ?? null,
    rpcCalls: rpc === undefined ? 0 : [
      'eth_getBlockByNumber',
      'eth_call',
    ].reduce((sum, method) => sum + rpc.calls(method), 0),
    rpcCallCounts: rpc?.snapshot() ?? Object.freeze({}),
  };
}

function privateCatalogScope(authorAddress) {
  return Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: '20430',
    governanceContractAddress: CONTEXT_GRAPH_STORAGE,
    ownershipTransitionDigest: createPrivatePolicyAndRoster().policy.ownershipTransitionDigest,
    subGraphName: null,
    authorAddress,
    era: '0',
    bucketCount: '1',
  });
}

async function readVerifiedAppliedCatalogMemoryV1(applied, scope) {
  const persistence = agent.rfc64PersistenceV1;
  if (applied === null || persistence === undefined) {
    throw new Error('catalog-row SWM evidence has no durable applied catalog');
  }
  return readVerifiedAppliedCatalogMemoryEvidenceV1({
    appliedHead: CATALOG_PROOF_FAULT === 'inventory-digest'
      ? Object.freeze({ ...applied, appliedInventoryDigest: `0x${'00'.repeat(32)}` })
      : applied,
    controlObjects: persistence.controlObjects,
    deployment: DEPLOYMENT,
    expectedAssetNumbers: CATALOG_PROOF_FAULT === 'expected-assets'
      ? Object.freeze([ASSET_NUMBERS[0], 43])
      : CATALOG_PROOF_FAULT === 'duplicate-expected-assets'
        ? Object.freeze([ASSET_NUMBERS[0], ASSET_NUMBERS[0]])
        : ASSET_NUMBERS,
    kaBundles: catalogProofKaBundlesV1(persistence.kaBundles),
    store: agent.store,
    trustedCatalogScope: scope,
  });
}

function catalogProofKaBundlesV1(kaBundles) {
  if (CATALOG_PROOF_FAULT === 'missing-bundle') {
    return Object.freeze({ readKaBundleByDigest: async () => null });
  }
  if (CATALOG_PROOF_FAULT !== 'mismatched-bundle') return kaBundles;
  return Object.freeze({
    readKaBundleByDigest: async (blobDigest) => {
      const bundleBytes = await kaBundles.readKaBundleByDigest(blobDigest);
      if (bundleBytes === null) return null;
      const decoded = decodeOpaqueKaBundleV1(bundleBytes);
      const projectionBytes = decoded.projectionBytes.slice();
      if (projectionBytes.length === 0) {
        throw new Error('cannot inject a mismatched empty catalog projection');
      }
      projectionBytes[0] ^= 1;
      return encodeOpaqueKaBundleV1(projectionBytes, decoded.sealBytes).bundleBytes;
    },
  });
}

async function revokeReceiver() {
  if (ROLE !== 'provider2') throw new Error('only provider2 can advance the gate roster');
  if (chainAdapter === undefined) throw new Error('provider2 has no finalized chain adapter');
  await agent.removeAgentFromContextGraph(
    CONTEXT_GRAPH_ID,
    roleAgentAddress('receiver'),
    roleAgentAddress('owner'),
  );
  const onChainContextGraphId = BigInt(ON_CHAIN_CONTEXT_GRAPH_ID);
  const finalizedAuthority = composeRfc64FinalizedCatalogAuthorityV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    snapshot: parseRfc64AuthoritySnapshotV1(
      await chainAdapter.getContextGraphAuthoritySnapshot(onChainContextGraphId),
      onChainContextGraphId,
    ),
  });
  const receiverAddress = roleAgentAddress('receiver');
  const expected = createReceiverRevokedPolicyAndRoster();
  if (
    finalizedAuthority.roster === null
    || initialFinalizedAuthority?.roster === null
    || initialFinalizedAuthority?.roster === undefined
    || BigInt(finalizedAuthority.roster.version)
      <= BigInt(initialFinalizedAuthority.roster.version)
    || finalizedAuthority.roster.members.some(
      ({ agentAddress }) => agentAddress === receiverAddress,
    )
    || finalizedAuthority.policyDigest !== expected.policyDigest
    || canonicalizeContextGraphPolicyPayloadV1(finalizedAuthority.policy)
      !== canonicalizeContextGraphPolicyPayloadV1(expected.policy)
    || canonicalizeMemberRosterPayloadV1(finalizedAuthority.roster)
      !== canonicalizeMemberRosterPayloadV1(expected.roster)
  ) {
    throw new Error('finalized chain authority did not exactly apply the receiver revocation');
  }
  const authority = await agent.reconcileRfc64CatalogAccessAuthorityV1(
    CONTEXT_GRAPH_ID,
  );
  if (authority === null) {
    throw new Error('provider2 canonical authority reconciliation produced no snapshot');
  }
  const expectedReconciledRoster = authority.roster === null
    ? null
    : Object.freeze({
        ...finalizedAuthority.roster,
        version: authority.roster.version,
      });
  if (
    authority.roster === null
    || authority.source !== 'finalized-chain'
    || BigInt(authority.roster.version) <= BigInt(initialFinalizedAuthority.roster.version)
    || authority.policyDigest !== finalizedAuthority.policyDigest
    || canonicalizeContextGraphPolicyPayloadV1(authority.policy)
      !== canonicalizeContextGraphPolicyPayloadV1(finalizedAuthority.policy)
    || canonicalizeMemberRosterPayloadV1(authority.roster)
      !== canonicalizeMemberRosterPayloadV1(expectedReconciledRoster)
  ) {
    throw new Error('provider2 reconciliation differs from the finalized receiver revocation');
  }
  return {
    policyDigest: authority.policyDigest,
    rosterVersion: authority.roster.version,
    revokedAgentAddress: receiverAddress,
  };
}

async function seedPrivateCatalogDefinition(created, peerIds) {
  const graph = contextGraphMetaGraphUri(CONTEXT_GRAPH_ID);
  const subject = contextGraphDataGraphUri(CONTEXT_GRAPH_ID);
  await created.store.insert([
    {
      subject,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph,
    },
    {
      subject,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"',
      graph,
    },
    {
      subject,
      predicate: DKG_ONTOLOGY.DKG_CREATOR,
      object: `did:dkg:agent:${peerIds.owner}`,
      graph,
    },
    {
      subject,
      predicate: DKG_ONTOLOGY.DKG_CURATOR,
      object: `did:dkg:agent:${roleAgentAddress('owner')}`,
      graph,
    },
    ...PRIVATE_MEMBER_ROLES.map((role) => ({
      subject,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${roleAgentAddress(role)}"`,
      graph,
    })),
  ]);
}

async function proveDenied(command) {
  try {
    const result = await agent.synchronizeRfc64CatalogFromProvidersV1({
      remotePeerIds: command.providerPeerIds,
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: roleAgentAddress('owner'),
        catalogEra: '0',
      },
    });
    return {
      denied: false,
      applied: result !== null,
      failureClass: null,
    };
  } catch (error) {
    const denial = classifyExpectedPrivateCatalogDenialV1(error);
    if (denial === null) throw error;
    return {
      denied: true,
      applied: false,
      ...denial,
    };
  }
}

function seededSubscriptionStore(contextGraphId, onChainId) {
  const records = new Map([[contextGraphId, {
    id: contextGraphId,
    subscribed: true,
    synced: false,
    syncScoped: true,
    onChainId,
  }]]);
  return {
    loadAll: async () => [...records.values()].map((record) => ({ ...record })),
    load: async (id) => records.has(id) ? { ...records.get(id) } : null,
    save: async (record) => { records.set(record.id, { ...record }); },
    delete: async (id) => { records.delete(id); },
  };
}

async function shutdown(
  code,
  requestId,
  responseEvent = childCommandDescriptorV1({ cmd: 'stop' }).responseEvent,
) {
  if (stopping) return;
  stopping = true;
  await emitAuthoritativeRuntimeShutdownReceiptV1({
    agent,
    rpc,
    executedRuntimeManifest: sealExecutedRuntimeManifestV1(),
    emitReceipt: (fields) => emitAndFlush(responseEvent, requestId, fields),
  });
  process.exit(code);
}

function emitAndFlush(event, requestId, fields = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`RFC64_PRIVATE_EVENT ${JSON.stringify({
      event,
      role: ROLE,
      ...(requestId === undefined ? {} : { requestId }),
      ...fields,
    })}\n`, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function boundedTimeout(value) {
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 120_000
    ? value
    : 60_000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bigintToDecimal(_key, value) {
  return typeof value === 'bigint' ? value.toString(10) : value;
}

process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(130); });

const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    emit('command-error', undefined, { message: 'invalid command JSON' });
    return;
  }
  handle(command).catch((error) => {
    emit('command-error', command.requestId, {
      message: boundedErrorChain(error),
    });
  });
});

boot().catch((error) => {
  emit('boot-failed', undefined, {
    message: boundedErrorChain(error),
  });
  void shutdown(1);
});

function boundedErrorChain(error) {
  const messages = [];
  const seen = new Set();
  let current = error;
  while (current !== null && current !== undefined && !seen.has(current) && messages.length < 6) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = typeof current === 'object' ? current.cause : null;
  }
  return messages.join(' <- ').slice(0, 2_048);
}
