// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { multiaddr } from '@multiformats/multiaddr';
import {
  computeAuthorCatalogScopeDigestV1,
  computeNetworkId,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  composeRfc64FinalizedCatalogAuthorityV1,
  parseRfc64AuthoritySnapshotV1,
} from '../../dist/rfc64/release-native-catalog-authority-v1.js';

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
  PRIVATE_MEMBER_ROLES,
  PROJECTION_EVIDENCE,
  UPDATED_PROJECTION_EVIDENCE,
  UPDATED_PROJECTION_QUADS,
  createCatalogAssets,
  createFinalizedChainFixture,
  createPrivatePolicyAndRoster,
  createReceiverRevokedPolicyAndRoster,
  ownerWallet,
  roleAgentAddress,
  rolePrivateKey,
} from './fixture.mjs';
import { classifyExpectedPrivateCatalogDenialV1 } from './denial-evidence.mjs';
import { sealExecutedRuntimeManifestV1 } from '../../../../devnet/rfc64-runtime-load-hook.mts';
import {
  hasExactPrivateCatalogMemoryContents,
  readPrivateCatalogGraphCountEvidence,
} from './memory-evidence.mjs';

const ROLE = requiredEnv('DKG_RFC64_PRIVATE_ROLE');
const MODE = requiredEnv('DKG_RFC64_PRIVATE_MODE');
const DATA_DIR = requiredEnv('DKG_RFC64_PRIVATE_DATA_DIR');
const RUNTIME_MANIFEST_DIGEST = requiredEnv('DKG_RFC64_RUNTIME_MANIFEST_DIGEST');
const MANIFEST_PATH = process.env.DKG_RFC64_PRIVATE_MANIFEST;

let agent;
let chainAdapter;
let rpc;
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
  if (MODE === 'probe') {
    agent = await createAgent(undefined, false);
    await agent.start();
    emit('ready', undefined, readyFields());
    return;
  }
  if (MODE !== 'run' || MANIFEST_PATH === undefined) {
    throw new Error('runtime mode requires a manifest');
  }
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  agent = await createAgent(manifest, true);
  await agent.start();
  if (ROLE === 'outsider') {
    // The outsider knows the exact finalized policy and roster but is not a
    // member. This lets its pull reach the provider and proves the provider's
    // RFC-64 policy denial instead of mistaking missing local policy setup for
    // remote access control.
    const { policy, policyDigest, roster } = createPrivatePolicyAndRoster();
    agent.acceptRfc64CatalogAccessSnapshotV1({ policy, policyDigest, roster });
  }
  emit('ready', undefined, readyFields());
}

async function createAgent(manifest, finalizedRuntime) {
  const fixture = createFinalizedChainFixture();
  let chainRuntime = {};
  if (finalizedRuntime) {
    rpc = await startRfc64PrivateDevnetFinalizedRpc(fixture);
    chainAdapter = new Rfc64PrivateDevnetChainAdapter(fixture);
    await chainAdapter.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: fixture.ownerAddress,
      publishAuthorityAccountId: 0n,
      participantAgents: fixture.participantAgents,
      nameHash: fixture.nameHash,
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

  const { policyEnvelope, rosterEnvelope } =
    createPrivatePolicyAndRoster();
  const peerIds = manifest.peerIds;
  const memberRoles = PRIVATE_MEMBER_ROLES;
  if (ROLE === 'outsider') {
    return DKGAgent.create({
      ...base,
      networkIdentity: {
        networkId: await computeNetworkId(),
        chainId: NETWORK_ID,
      },
      rfc64CatalogDeploymentProfile: DEPLOYMENT,
      rfc64CatalogAccessPolicyAuthority: {
        localAgentAddress: roleAgentAddress(ROLE),
        resolveRemoteAgentAddress: async (peerId) => {
          const role = Object.entries(peerIds).find(([, value]) => value === peerId)?.[0];
          return role === undefined ? null : roleAgentAddress(role);
        },
      },
    });
  }

  const completeSwmProviders = ROLE === 'provider2'
    ? [peerIds.owner]
    : [peerIds.provider2];
  return DKGAgent.create({
    ...base,
    networkIdentity: {
      networkId: await computeNetworkId(),
      chainId: NETWORK_ID,
    },
    rfc64CatalogActivation: {
      enabled: true,
      deploymentProfile: DEPLOYMENT,
      accessPolicyAuthority: {
        localAgentAddress: roleAgentAddress(ROLE),
        peerAgentBindings: memberRoles.map((role) => ({
          peerId: peerIds[role],
          agentAddress: roleAgentAddress(role),
        })),
      },
      bootstrap: {
        acceptedPolicies: [{
          policyEnvelope,
          rosterEnvelope,
          targets: [{
            authorAddress: roleAgentAddress('owner'),
            providers: completeSwmProviders,
          }],
          completeSwmProviders,
        }],
        retryIntervalMs: 1_000,
      },
    },
  });
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
  };
}

async function handle(command) {
  const requestId = command.requestId;
  switch (command.cmd) {
    case 'dial':
      await agent.node.libp2p.dial(multiaddr(command.multiaddr));
      emit('dialed', requestId, { peerId: command.peerId });
      return;
    case 'publish':
      await publishCatalog(requestId);
      return;
    case 'wait-bootstrap':
      await waitForBootstrap(command, requestId);
      return;
    case 'inspect':
      emit('inspection', requestId, await inspect(command.expectedHeadDigest));
      return;
    case 'inspect-persisted':
      emit(
        'persisted-inspection',
        requestId,
        await inspect(command.expectedHeadDigest, { includeNonmemberQuery: false }),
      );
      return;
    case 'sync-denied':
      await proveDenied(command, requestId);
      return;
    case 'revoke-receiver':
      await revokeReceiver(requestId);
      return;
    case 'stop':
      await shutdown(0, requestId);
      return;
    default:
      throw new Error(`unknown command ${String(command.cmd)}`);
  }
}

async function publishCatalog(requestId) {
  if (ROLE !== 'owner') throw new Error('only the owner role can publish');
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
  // The catalog establishes the finalized VM baseline first. These staged
  // version-2 snapshots represent a later, not-yet-finalized SWM generation,
  // so finalized version-1 twin retirement must preserve them.
  for (const [index, asset] of assets.entries()) {
    const kaNumber = ASSET_NUMBERS[index];
    if (kaNumber === undefined) throw new Error('catalog fixture asset number is missing');
    await agent.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: `rfc64-private-release-gate-v2-${kaNumber}`,
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
  if (applied === undefined) throw new Error('catalog upsert produced no applied head');
  emit('published', requestId, {
    headObjectDigest: applied.currentCatalogHeadDigest,
    policyDigest,
    catalogVersion: applied.catalogVersion,
    inventoryRowCount: applied.inventoryRowCount,
    scopeDigest: computeAuthorCatalogScopeDigestV1(scope),
  });
}

async function waitForBootstrap(command, requestId) {
  const timeoutMs = boundedTimeout(command.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    await agent.whenRfc64PublicCatalogBootstrapIdleV1();
    last = agent.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0] ?? null;
    const bootstrapApplied = (
      last?.outcome === 'applied'
      && (command.expectedHeadDigest === undefined
        || last.appliedHeadDigest === command.expectedHeadDigest)
    );
    if (bootstrapApplied && await hasExactLocalMemoryContents()) {
      emit('bootstrap-applied', requestId, {
        outcome: last.outcome,
        providerPeerId: last.providerPeerId,
        appliedHeadDigest: last.appliedHeadDigest,
        catalogVersion: last.catalogVersion,
        inventoryRowCount: last.inventoryRowCount,
        attempts: last.attempts,
      });
      return;
    }
    await delay(100);
  }
  const graphCounts = await readPrivateCatalogGraphCountEvidence(agent.store, {
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

async function hasExactLocalMemoryContents() {
  const graphCounts = await readPrivateCatalogGraphCountEvidence(agent.store, {
    assetNumbers: ASSET_NUMBERS,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorAddress: roleAgentAddress('owner'),
    networkId: NETWORK_ID,
  });
  return hasExactPrivateCatalogMemoryContents(
    { graphCounts },
    {
      assetNumbers: ASSET_NUMBERS,
      swm: {
        projection: UPDATED_PROJECTION_EVIDENCE,
        assertionVersion: '2',
        shareOperationIdPrefix: 'rfc64-private-release-gate-v2-',
      },
      vm: { projection: PROJECTION_EVIDENCE, assertionVersion: '1' },
    },
  );
}

async function inspect(expectedHeadDigest, { includeNonmemberQuery = true } = {}) {
  const authorAddress = roleAgentAddress('owner');
  const scopeDigest = computeAuthorCatalogScopeDigestV1({
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
  const applied = agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: scopeDigest,
    authorAddress,
  });
  const graphCounts = await readPrivateCatalogGraphCountEvidence(agent.store, {
    assetNumbers: ASSET_NUMBERS,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorAddress,
    networkId: NETWORK_ID,
  });
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

async function revokeReceiver(requestId) {
  if (ROLE !== 'provider2') throw new Error('only provider2 can advance the gate roster');
  if (chainAdapter === undefined) throw new Error('provider2 has no finalized chain adapter');
  await chainAdapter.removeContextGraphParticipantAgent(
    BigInt(ON_CHAIN_CONTEXT_GRAPH_ID),
    roleAgentAddress('receiver'),
  );
  const contextGraphId = BigInt(ON_CHAIN_CONTEXT_GRAPH_ID);
  const authority = composeRfc64FinalizedCatalogAuthorityV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    snapshot: parseRfc64AuthoritySnapshotV1(
      await chainAdapter.getContextGraphAuthoritySnapshot(contextGraphId),
      contextGraphId,
    ),
  });
  const expected = createReceiverRevokedPolicyAndRoster();
  if (
    authority.policyDigest !== expected.policyDigest
    || authority.roster?.version !== expected.roster.version
    || authority.roster.members.some(
      ({ agentAddress }) => agentAddress === roleAgentAddress('receiver'),
    )
  ) {
    throw new Error('provider2 did not adopt the finalized receiver revocation');
  }
  const catalogService = agent.rfc64PublicCatalogServiceV1;
  if (catalogService === undefined) {
    throw new Error('provider2 has no RFC-64 catalog service');
  }
  const accepted = catalogService.acceptAuthoritativePolicySnapshot({
    policy: authority.policy,
    policyDigest: authority.policyDigest,
    roster: authority.roster,
  });
  if (
    accepted.roster?.version !== expected.roster.version
    || accepted.roster.members.some(
      ({ agentAddress }) => agentAddress === roleAgentAddress('receiver'),
    )
  ) {
    throw new Error('provider2 did not accept the finalized receiver revocation');
  }
  emit('receiver-revoked', requestId, {
    policyDigest: authority.policyDigest,
    rosterVersion: authority.roster.version,
    revokedAgentAddress: roleAgentAddress('receiver'),
  });
}

async function proveDenied(command, requestId) {
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
    emit('sync-denial-result', requestId, {
      denied: false,
      applied: result !== null,
      failureClass: null,
    });
  } catch (error) {
    const denial = classifyExpectedPrivateCatalogDenialV1(error);
    if (denial === null) throw error;
    emit('sync-denial-result', requestId, {
      denied: true,
      applied: false,
      ...denial,
    });
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

async function shutdown(code, requestId) {
  if (stopping) return;
  stopping = true;
  try { await agent?.stop(); } catch { /* best effort */ }
  try { await rpc?.close(); } catch { /* best effort */ }
  await emitAndFlush('stopping', requestId, {
    executedRuntimeManifest: sealExecutedRuntimeManifestV1(),
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
