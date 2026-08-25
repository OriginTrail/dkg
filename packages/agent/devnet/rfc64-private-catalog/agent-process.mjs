// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { multiaddr } from '@multiformats/multiaddr';
import {
  MemoryLayer,
  computeAuthorCatalogScopeDigestV1,
  computeNetworkId,
  contextGraphLayerUri,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

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
  createCatalogAssets,
  createFinalizedChainFixture,
  createPrivatePolicyAndRoster,
  ownerWallet,
  roleAgentAddress,
} from './fixture.mjs';

const ROLE = requiredEnv('DKG_RFC64_PRIVATE_ROLE');
const MODE = requiredEnv('DKG_RFC64_PRIVATE_MODE');
const DATA_DIR = requiredEnv('DKG_RFC64_PRIVATE_DATA_DIR');
const MANIFEST_PATH = process.env.DKG_RFC64_PRIVATE_MANIFEST;

let agent;
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
    await shutdown(0);
    return;
  }
  if (MODE !== 'run' || MANIFEST_PATH === undefined) {
    throw new Error('runtime mode requires a manifest');
  }
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  agent = await createAgent(manifest, true);
  await agent.start();
  emit('ready', undefined, readyFields());
}

async function createAgent(manifest, finalizedRuntime) {
  const fixture = createFinalizedChainFixture();
  let chainRuntime = {};
  if (finalizedRuntime) {
    rpc = await startRfc64PrivateDevnetFinalizedRpc(fixture);
    const chainAdapter = new Rfc64PrivateDevnetChainAdapter(fixture);
    await chainAdapter.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: fixture.ownerAddress,
      publishAuthorityAccountId: 0n,
      nameHash: fixture.nameHash,
    });
    chainRuntime = {
      chainAdapter,
      chainConfig: {
        rpcUrl: rpc.url,
        hubAddress: CONTEXT_GRAPH_STORAGE,
        operationalKeys: [`0x${'12'.repeat(32)}`],
      },
      contextGraphSubscriptionStore: seededSubscriptionStore(CONTEXT_GRAPH_ID),
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
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
    ...chainRuntime,
  };
  if (manifest === undefined) return DKGAgent.create(base);

  const { policyEnvelope, rosterEnvelope } =
    createPrivatePolicyAndRoster();
  const peerIds = manifest.peerIds;
  const memberRoles = ['owner', 'provider2', 'receiver'];
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

  const providerPeerIds = [peerIds.owner, peerIds.provider2];
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
            providers: providerPeerIds,
          }],
          completeSwmProviders: providerPeerIds,
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
    case 'sync-denied':
      await proveDenied(command, requestId);
      return;
    case 'stop':
      emit('stopping', requestId);
      await shutdown(0);
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
    ownershipTransitionDigest: null,
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
    if (
      last?.outcome === 'applied'
      && (command.expectedHeadDigest === undefined
        || last.appliedHeadDigest === command.expectedHeadDigest)
    ) {
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
  throw new Error(`bootstrap did not apply the expected head; last outcome ${last?.outcome ?? 'none'}`);
}

async function inspect(expectedHeadDigest) {
  const authorAddress = roleAgentAddress('owner');
  const scopeDigest = computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: '20430',
    governanceContractAddress: CONTEXT_GRAPH_STORAGE,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress,
    era: '0',
    bucketCount: '1',
  });
  const applied = agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: scopeDigest,
    authorAddress,
  });
  const graphCounts = [];
  for (const kaNumber of ASSET_NUMBERS) {
    const swmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.SharedWorkingMemory,
      authorAddress,
      kaNumber,
    );
    const vmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      authorAddress,
      kaNumber,
    );
    graphCounts.push({
      kaNumber,
      swm: await exactGraphCount(swmGraph),
      vm: await exactGraphCount(vmGraph),
    });
  }
  const outsiderResult = ROLE === 'outsider'
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
    outsiderVisibleVmBindings: outsiderResult?.bindings?.length ?? 0,
    receiverStats: agent.rfc64PublicCatalogStatsV1()?.receiver ?? null,
    rpcCalls: rpc === undefined ? 0 : [
      'eth_getBlockByNumber',
      'eth_call',
    ].reduce((sum, method) => sum + rpc.calls(method), 0),
  };
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
    emit('sync-denial-result', requestId, {
      denied: true,
      applied: false,
      failureClass: error?.name ?? 'Error',
    });
  }
}

async function exactGraphCount(graph) {
  const result = await agent.store.query(
    `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
  );
  const value = result?.bindings?.[0]?.count ?? '0';
  const match = String(value).match(/-?[0-9]+/u);
  return match === null ? 0 : Number(match[0]);
}

function seededSubscriptionStore(contextGraphId) {
  const records = new Map([[contextGraphId, {
    id: contextGraphId,
    subscribed: true,
    synced: false,
    syncScoped: true,
  }]]);
  return {
    loadAll: async () => [...records.values()].map((record) => ({ ...record })),
    load: async (id) => records.has(id) ? { ...records.get(id) } : null,
    save: async (record) => { records.set(record.id, { ...record }); },
    delete: async (id) => { records.delete(id); },
  };
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  try { await agent?.stop(); } catch { /* best effort */ }
  try { await rpc?.close(); } catch { /* best effort */ }
  process.exit(code);
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
