// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { multiaddr } from '@multiformats/multiaddr';
import {
  DKG_ONTOLOGY,
  computeAuthorCatalogScopeDigestV1,
  computeNetworkId,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  composeRfc64RegisteredRosterVersionV1,
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
  RUNTIME_ROLES,
  UPDATED_ASSERTION_ROOT,
  UPDATED_PROJECTION,
  UPDATED_PROJECTION_QUADS,
  createCatalogAssets,
  createFinalizedChainFixture,
  createPrivateCatalogScope,
  createPrivateCatalogSyncScope,
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
import {
  assertAuthorityEvidenceParityV1,
  assertFinalizedAuthorityMatchesExpectedV1,
  assertInitialFinalizedAuthorityV1,
} from './initial-authority.mjs';
import { readVerifiedAppliedCatalogMemoryEvidenceV1 } from './verified-catalog-swm-proof.mjs';
import { emitAuthoritativeRuntimeShutdownReceiptV1 } from './runtime-shutdown.mjs';
import { createRfc64PrivateFaultProfileV1 } from './fault-injection.mjs';
import {
  assertFinalizedRuntimeV1,
  createFinalizedRuntimeV1,
  createProbeRuntimeV1,
} from './agent-runtime.mjs';

const ROLE = requiredEnv('DKG_RFC64_PRIVATE_ROLE');
const MODE = requiredEnv('DKG_RFC64_PRIVATE_MODE');
const DATA_DIR = requiredEnv('DKG_RFC64_PRIVATE_DATA_DIR');
const RUNTIME_MANIFEST_DIGEST = requiredEnv('DKG_RFC64_RUNTIME_MANIFEST_DIGEST');
const MANIFEST_PATH = process.env.DKG_RFC64_PRIVATE_MANIFEST;
let runtime;
let childCommandHandlers;
let stopping = false;

function emit(event, requestId, fields = {}) {
  process.stdout.write(`RFC64_PRIVATE_EVENT ${JSON.stringify({
    event,
    role: ROLE,
    ...(requestId === undefined ? {} : { requestId }),
    ...fields,
  })}\n`);
}

async function boot() {
  const faultProfile = createRfc64PrivateFaultProfileV1(process.env);
  if (MODE === 'probe') {
    const created = await createAgent(undefined, false, faultProfile);
    await created.agent.start();
    runtime = createProbeRuntimeV1(created);
    childCommandHandlers = createChildCommandHandlersV1(runtime);
    emit(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready, undefined, readyFields(runtime));
    return;
  }
  if (MODE !== 'run' || MANIFEST_PATH === undefined) {
    throw new Error('runtime mode requires a manifest');
  }
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const created = await createAgent(manifest, true, faultProfile);
  await created.agent.start();
  if (created.chainAdapter === undefined) {
    throw new Error('finalized runtime produced no chain adapter');
  }
  const onChainContextGraphId = BigInt(ON_CHAIN_CONTEXT_GRAPH_ID);
  const finalizedAuthority = composeRfc64FinalizedCatalogAuthorityV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    snapshot: parseRfc64AuthoritySnapshotV1(
      await created.chainAdapter.getContextGraphAuthoritySnapshot(onChainContextGraphId),
      onChainContextGraphId,
    ),
  });
  const runtimeIsMember = finalizedAuthority.roster?.members.some(
    ({ agentAddress }) => agentAddress === roleAgentAddress(ROLE),
  ) === true;
  const responsibility = await created.agent.reconcileRfc64CatalogResponsibilityV1(
    CONTEXT_GRAPH_ID,
  );
  if (
    runtimeIsMember
    && (!responsibility.active || responsibility.mode === 'legacy')
  ) {
    throw new Error('real graph did not enter release-native RFC-64 responsibility');
  }
  if (!runtimeIsMember && responsibility.active) {
    throw new Error('nonmember unexpectedly entered RFC-64 catalog responsibility');
  }
  const expected = finalizedAuthority.roster?.version === '0'
    ? createPrivatePolicyAndRoster()
    : createReceiverRevokedPolicyAndRoster();
  const registeredRosterVersion = finalizedAuthority.roster === null
    ? null
    : composeRfc64RegisteredRosterVersionV1(
      finalizedAuthority.roster.version,
      await created.agent.readRfc64PrivateRosterVersionV1(CONTEXT_GRAPH_ID),
    );
  const registeredFinalizedAuthority = finalizedAuthority.roster === null
    ? finalizedAuthority
    : Object.freeze({
      ...finalizedAuthority,
      roster: Object.freeze({
        ...finalizedAuthority.roster,
        version: registeredRosterVersion,
      }),
    });
  const expectedAuthority = {
    policy: expected.policy,
    policyDigest: expected.policyDigest,
    roster: Object.freeze({ ...expected.roster, version: registeredRosterVersion }),
    source: 'finalized-chain',
  };
  let acceptedAuthority = null;
  try {
    acceptedAuthority = await created.agent.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
    );
  } catch (error) {
    if (
      runtimeIsMember
      || error?.code !== 'catalog-service-unavailable'
    ) throw error;
  }
  if (runtimeIsMember && acceptedAuthority === null) {
    throw new Error('real graph produced no release-native finalized authority');
  }
  const initialFinalizedAuthority = acceptedAuthority === null
    ? assertFinalizedAuthorityMatchesExpectedV1({
      finalizedAuthority: registeredFinalizedAuthority,
      expectedAuthority,
    })
    : assertInitialFinalizedAuthorityV1({
      acceptedAuthority,
      finalizedAuthority: registeredFinalizedAuthority,
      expectedAuthority,
    });
  runtime = createFinalizedRuntimeV1(created, {
    initialFinalizedAuthority,
    peerIds: manifest.peerIds,
    role: ROLE,
  });
  childCommandHandlers = createChildCommandHandlersV1(runtime);
  emit(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready, undefined, readyFields(runtime));
}

async function createAgent(manifest, finalizedRuntime, faultProfile) {
  const canonicalFixture = createFinalizedChainFixture();
  const fixture = faultProfile.authority.fixture(
    canonicalFixture,
    roleAgentAddress('receiver'),
  );
  let chainAdapter;
  let rpc;
  let chainRuntime = {};
  if (finalizedRuntime) {
    chainAdapter = new Rfc64PrivateDevnetChainAdapter(fixture, {
      ...faultProfile.authority.adapterOptions({
        authorityStatePath: manifest.authorityStatePath,
        ownerAddress: roleAgentAddress('owner'),
      }),
      signerAddress: roleAgentAddress(ROLE),
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
  if (manifest === undefined) {
    return Object.freeze({
      agent: await DKGAgent.create(base),
      chainAdapter: undefined,
      faultProfile,
      rpc: undefined,
    });
  }

  const peerIds = manifest.peerIds;
  const agentAddressByPeerId = new Map(RUNTIME_ROLES.map((role) => [
    peerIds[role],
    roleAgentAddress(role),
  ]));
  const accessPolicyAuthority = {
    localAgentAddress: roleAgentAddress(ROLE),
    resolveRemoteAgentAddress: async (peerId) => agentAddressByPeerId.get(peerId) ?? null,
  };
  const finalizedSnapshot = await chainAdapter.getContextGraphAuthoritySnapshot(
    BigInt(ON_CHAIN_CONTEXT_GRAPH_ID),
  );
  await seedPrivateCatalogDefinition(base.store, peerIds, finalizedSnapshot.participantAgents);
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
  return Object.freeze({ agent: created, chainAdapter, faultProfile, rpc });
}

function readyFields(context) {
  const address = context.agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('agent has no TCP multiaddr');
  return {
    agentClass: context.agent.constructor.name,
    peerId: context.agent.peerId,
    multiaddr: address,
    catalogServiceStarted: context.agent.rfc64PublicCatalogStatsV1()?.started === true,
    runtimeBuildManifestDigest: RUNTIME_MANIFEST_DIGEST,
    ...(context.kind !== 'run' ? {} : {
      authoritySource: context.initialFinalizedAuthority.source,
      authorityPolicyDigest: context.initialFinalizedAuthority.policyDigest,
      authorityRosterVersion: context.initialFinalizedAuthority.roster.version,
      authorityMembers: context.initialFinalizedAuthority.roster.members.map(
        ({ agentAddress }) => agentAddress,
      ),
    }),
  };
}

async function handle(command) {
  if (childCommandHandlers === undefined) throw new Error('child runtime is not ready');
  const { descriptor } = await dispatchChildCommandV1(
    childCommandHandlers,
    command,
    emit,
  );
  if (descriptor.command === 'stop') {
    await shutdown(0, command.requestId, descriptor.responseEvent);
  }
}

function createChildCommandHandlersV1(context) {
  return defineChildCommandHandlersV1({
    dial: async (command) => {
      await context.agent.node.libp2p.dial(multiaddr(command.multiaddr));
      return { peerId: command.peerId };
    },
    publish: () => publishCatalogBaseline(context),
    'publish-update': () => publishCatalogUpdate(context),
    'wait-bootstrap': (command) => waitForBootstrap(context, command),
    inspect: (command) => inspect(context, command.expectedHeadDigest),
    'inspect-persisted': (command) => inspect(
      context,
      command.expectedHeadDigest,
      { includeNonmemberQuery: false },
    ),
    'sync-denied': (command) => proveDenied(context, command),
    'revoke-receiver': () => revokeReceiver(context),
    'observe-receiver-revocation': () => observeReceiverRevocation(context),
    stop: async () => Object.freeze({}),
  });
}

async function publishCatalogBaseline(context) {
  assertFinalizedRuntimeV1(context);
  if (ROLE !== 'owner' || context.publication === null) {
    throw new Error('only the owner role can publish');
  }
  context.publication.beginBaseline();
  const { policyDigest } = createPrivatePolicyAndRoster();
  const scope = createPrivateCatalogScope();
  const assets = await createCatalogAssets();
  let applied;
  for (const asset of assets) {
    applied = await context.agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      scope,
      author: ownerWallet(),
      asset,
      deployment: DEPLOYMENT,
      peers: [],
      catalogIssuerDelegationEffectiveAt: '0',
      catalogIssuerDelegationExpiresAt: '1893456000000',
    });
  }
  context.publication.commitBaseline(scope, assets);
  return publishedFields(applied, policyDigest, scope);
}

async function publishCatalogUpdate(context) {
  assertFinalizedRuntimeV1(context);
  if (ROLE !== 'owner' || context.publication === null) {
    throw new Error('only the owner role can publish');
  }
  const baseline = context.publication.requireBaseline();
  const { policyDigest } = createPrivatePolicyAndRoster();
  // The catalog establishes the finalized VM baseline first. These staged
  // version-2 snapshots represent a later, not-yet-finalized SWM generation,
  // so finalized version-1 twin retirement must preserve them.
  for (const [index, asset] of baseline.assets.entries()) {
    const kaNumber = ASSET_NUMBERS[index];
    if (kaNumber === undefined) throw new Error('catalog fixture asset number is missing');
    await context.agent.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: privateCatalogSwmShareOperationId(kaNumber),
      kaUal: asset.seal.kaUal,
      assertionVersion: '2',
      quads: UPDATED_PROJECTION_QUADS,
      privateTripleCount: 0,
      publisherPeerId: context.agent.peerId,
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
    applied = await context.agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      scope: baseline.scope,
      author: ownerWallet(),
      asset,
      deployment: DEPLOYMENT,
      peers: [],
      catalogIssuerDelegationEffectiveAt: '0',
      catalogIssuerDelegationExpiresAt: '1893456000000',
    });
  }
  return publishedFields(applied, policyDigest, baseline.scope);
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

async function waitForBootstrap(context, command) {
  assertFinalizedRuntimeV1(context);
  const timeoutMs = boundedTimeout(command.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let last;
  let attempts = 0;
  const providerRole = ROLE === 'provider2' ? 'owner' : 'provider2';
  const providerPeerId = context.peerIds[providerRole];
  if (providerPeerId === undefined) {
    throw new Error(`${ROLE} has no configured catalog provider`);
  }
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      last = await context.agent.synchronizeRfc64CatalogFromProvidersV1({
        remotePeerIds: [providerPeerId],
        scope: createPrivateCatalogSyncScope(),
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
      ? await hasExactLocalFinalizedVmBaseline(context)
      : await hasExactLocalMemoryContents(context, {
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
  const graphCounts = await readPrivateCatalogWorkspaceMemoryEvidenceV1(context.agent.store, {
    assetNumbers: ASSET_NUMBERS,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorAddress: roleAgentAddress('owner'),
    networkId: NETWORK_ID,
  });
  const registeredAuthority = await context.agent.resolveRegisteredContextGraphAuthority(
    CONTEXT_GRAPH_ID,
  ).catch((error) => ({ error: boundedErrorChain(error) }));
  const memberRecoveryGate = await context.agent.getMemberRecoveryGate(
    CONTEXT_GRAPH_ID,
  ).catch((error) => ({ error: boundedErrorChain(error) }));
  throw new Error(
    `bootstrap did not converge; graphCounts=${JSON.stringify(graphCounts)}; `
    + `memberRecoveryGate=${JSON.stringify(memberRecoveryGate)}; `
    + `registeredAuthority=${JSON.stringify(registeredAuthority, bigintToDecimal)}; `
    + `last=${JSON.stringify(last)}`,
  );
}

async function hasExactLocalFinalizedVmBaseline(context) {
  const graphCounts = await readPrivateCatalogWorkspaceMemoryEvidenceV1(context.agent.store, {
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

async function hasExactLocalMemoryContents(context, catalogEvidence = {}) {
  const authorAddress = roleAgentAddress('owner');
  const scope = createPrivateCatalogScope({ authorAddress });
  const applied = context.agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    authorAddress,
  });
  const graphCounts = await readVerifiedAppliedCatalogMemoryV1(context, applied, scope);
  return hasExactPrivateCatalogMemoryContents(
    {
      appliedHeadDigest: applied?.currentCatalogHeadDigest,
      graphCounts,
      ...catalogEvidence,
    },
    PRIVATE_CATALOG_MEMORY_EXPECTATION,
  );
}

async function inspect(context, expectedHeadDigest, { includeNonmemberQuery = true } = {}) {
  const authorAddress = roleAgentAddress('owner');
  const scope = createPrivateCatalogScope({ authorAddress });
  const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const applied = context.agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: scopeDigest,
    authorAddress,
  });
  const graphCounts = ROLE === 'owner' || applied === null
    ? await readPrivateCatalogWorkspaceMemoryEvidenceV1(context.agent.store, {
        assetNumbers: ASSET_NUMBERS,
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress,
        networkId: NETWORK_ID,
      })
    : await readVerifiedAppliedCatalogMemoryV1(context, applied, scope);
  const outsiderResult = ROLE === 'outsider' || !includeNonmemberQuery
    ? null
    : await context.agent.query(
      'SELECT ?name WHERE { <https://example.org/alice> <https://schema.org/name> ?name }',
      {
        contextGraphId: CONTEXT_GRAPH_ID,
        view: 'verifiable-memory',
        callerAgentAddress: roleAgentAddress('outsider'),
      },
    );
  return {
    appliedHeadDigest: applied?.currentCatalogHeadDigest ?? null,
    catalogScopeDigest: scopeDigest,
    catalogVersion: applied?.catalogVersion ?? null,
    inventoryRowCount: applied?.inventoryRowCount ?? null,
    exactExpectedHead: expectedHeadDigest === undefined
      ? null
      : applied?.currentCatalogHeadDigest === expectedHeadDigest,
    graphCounts,
    outsiderVisibleVmBindings: includeNonmemberQuery
      ? outsiderResult?.bindings?.length ?? 0
      : null,
    receiverStats: context.agent.rfc64PublicCatalogStatsV1()?.receiver ?? null,
    rpcCalls: context.rpc === undefined ? 0 : [
      'eth_getBlockByNumber',
      'eth_call',
    ].reduce((sum, method) => sum + context.rpc.calls(method), 0),
    rpcCallCounts: context.rpc?.snapshot() ?? Object.freeze({}),
  };
}

async function readVerifiedAppliedCatalogMemoryV1(context, applied, scope) {
  const persistence = context.agent.rfc64PersistenceV1;
  if (applied === null || persistence === undefined) {
    throw new Error('catalog-row SWM evidence has no durable applied catalog');
  }
  const proofInputs = context.faultProfile.proof.inputs({
    appliedHead: applied,
    expectedAssetNumbers: ASSET_NUMBERS,
    kaBundles: persistence.kaBundles,
    trustedCatalogScope: scope,
    untrustedCatalogScope: Object.freeze({
      ...scope,
      authorAddress: roleAgentAddress('outsider'),
    }),
  });
  return readVerifiedAppliedCatalogMemoryEvidenceV1({
    ...proofInputs,
    controlObjects: persistence.controlObjects,
    deployment: DEPLOYMENT,
    store: context.agent.store,
  });
}

async function revokeReceiver(context) {
  assertFinalizedRuntimeV1(context);
  if (ROLE !== 'owner') throw new Error('only the owner can advance the gate roster');
  if (context.chainAdapter === undefined) throw new Error('owner has no finalized chain adapter');
  await context.agent.removeAgentFromContextGraph(
    CONTEXT_GRAPH_ID,
    roleAgentAddress('receiver'),
    roleAgentAddress('owner'),
  );
  const finalizedAuthority = await readExactReceiverRevokedFinalizedAuthorityV1(context);
  return {
    policyDigest: finalizedAuthority.policyDigest,
    rosterVersion: finalizedAuthority.roster.version,
    revokedAgentAddress: roleAgentAddress('receiver'),
  };
}

async function observeReceiverRevocation(context) {
  assertFinalizedRuntimeV1(context);
  if (ROLE !== 'provider2') throw new Error('only provider2 can observe the gate revocation');
  let providerMutationDenied = false;
  try {
    await context.agent.removeAgentFromContextGraph(
      CONTEXT_GRAPH_ID,
      roleAgentAddress('receiver'),
      roleAgentAddress('provider2'),
    );
  } catch (error) {
    providerMutationDenied = /Only the context graph creator can manage participants/u.test(
      error instanceof Error ? error.message : '',
    );
  }
  if (!providerMutationDenied) {
    throw new Error('provider2 identity was not denied the owner-only receiver revocation');
  }
  const finalizedAuthority = await readExactReceiverRevokedFinalizedAuthorityV1(context);
  const curatorMetadataRefreshed = await context.agent.refreshMetaFromCurator(
    CONTEXT_GRAPH_ID,
    {
      force: true,
      trustedCuratorPeerId: context.peerIds.owner,
    },
  );
  if (!curatorMetadataRefreshed) {
    throw new Error('provider2 did not refresh the owner-authenticated revocation metadata');
  }
  const authority = await context.agent.reconcileRfc64CatalogAccessAuthorityV1(
    CONTEXT_GRAPH_ID,
  );
  if (authority === null) {
    throw new Error('provider2 canonical authority reconciliation produced no snapshot');
  }
  if (
    authority.roster === null
    || authority.source !== 'finalized-chain'
    || BigInt(authority.roster.version)
      <= BigInt(context.initialFinalizedAuthority.roster.version)
  ) {
    throw new Error('provider2 reconciliation differs from the finalized receiver revocation');
  }
  assertAuthorityEvidenceParityV1({
    actual: authority,
    expected: finalizedAuthority,
    expectedRosterVersion: authority.roster.version,
    message: 'provider2 reconciliation differs from the finalized receiver revocation',
  });
  return {
    policyDigest: authority.policyDigest,
    curatorMetadataRefreshed,
    providerMutationDenied,
    rosterVersion: authority.roster.version,
    revokedAgentAddress: roleAgentAddress('receiver'),
  };
}

async function readExactReceiverRevokedFinalizedAuthorityV1(context) {
  if (context.chainAdapter === undefined) {
    throw new Error(`${ROLE} has no finalized chain adapter`);
  }
  const onChainContextGraphId = BigInt(ON_CHAIN_CONTEXT_GRAPH_ID);
  const finalizedAuthority = composeRfc64FinalizedCatalogAuthorityV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    snapshot: parseRfc64AuthoritySnapshotV1(
      await context.chainAdapter.getContextGraphAuthoritySnapshot(onChainContextGraphId),
      onChainContextGraphId,
    ),
  });
  const receiverAddress = roleAgentAddress('receiver');
  const expected = createReceiverRevokedPolicyAndRoster();
  if (
    finalizedAuthority.roster === null
    || context.initialFinalizedAuthority.roster === null
    || BigInt(finalizedAuthority.roster.version)
      <= BigInt(context.initialFinalizedAuthority.roster.version)
    || finalizedAuthority.roster.members.some(
      ({ agentAddress }) => agentAddress === receiverAddress,
    )
  ) {
    throw new Error('finalized chain authority did not exactly apply the receiver revocation');
  }
  assertAuthorityEvidenceParityV1({
    actual: finalizedAuthority,
    expected,
    message: 'finalized chain authority did not exactly apply the receiver revocation',
  });
  return finalizedAuthority;
}

async function seedPrivateCatalogDefinition(store, peerIds, participantAgents) {
  const graph = contextGraphMetaGraphUri(CONTEXT_GRAPH_ID);
  const subject = contextGraphDataGraphUri(CONTEXT_GRAPH_ID);
  await Promise.all([
    DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
    DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
  ].map((predicate) => store.deleteByPattern({ subject, predicate, graph })));
  await store.insert([
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
    ...participantAgents.map((agentAddress) => ({
      subject,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${agentAddress.toLowerCase()}"`,
      graph,
    })),
  ]);
}

async function proveDenied(context, command) {
  assertFinalizedRuntimeV1(context);
  try {
    const result = await context.agent.synchronizeRfc64CatalogFromProvidersV1({
      remotePeerIds: command.providerPeerIds,
      scope: createPrivateCatalogSyncScope(),
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
  if (runtime === undefined) {
    process.exit(code);
    return;
  }
  await emitAuthoritativeRuntimeShutdownReceiptV1({
    agent: runtime.agent,
    rpc: runtime.rpc,
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
