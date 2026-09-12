// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import {
  DKG_ONTOLOGY,
  computeNetworkId,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

import {
  composeRfc64FinalizedCatalogAuthorityV1,
  composeRfc64RegisteredRosterVersionV1,
  parseRfc64AuthoritySnapshotV1,
} from '../../src/rfc64/release-native-catalog-authority-v1.ts';
import {
  Rfc64PrivateDevnetChainAdapter,
  startRfc64PrivateDevnetFinalizedRpc,
} from './finalized-chain-fixture.mjs';
import {
  CONTEXT_GRAPH_ID,
  CONTEXT_GRAPH_STORAGE,
  DEPLOYMENT,
  NETWORK_ID,
  ON_CHAIN_CONTEXT_GRAPH_ID,
  RUNTIME_ROLES,
  createFinalizedChainFixture,
  createPrivatePolicyAndRoster,
  createReceiverRevokedPolicyAndRoster,
  roleAgentAddress,
  rolePrivateKey,
} from './fixture.mjs';
import {
  assertFinalizedRuntimeFactoryInputV1,
  assertProbeRuntimeFactoryInputV1,
  createFinalizedRuntimeV1,
  createProbeRuntimeV1,
} from './agent-runtime.mjs';
import {
  assertFinalizedAuthorityMatchesExpectedV1,
  assertInitialFinalizedAuthorityV1,
} from './initial-authority.mjs';

export async function createRfc64PrivateProbeRuntimeV1(input) {
  assertProbeRuntimeFactoryInputV1(input);
  const { dataDir, faultProfile, role } = input;
  rolePrivateKey(role);
  const created = Object.freeze({
    agent: await DKGAgent.create(createBaseAgentOptionsV1({ dataDir, role })),
    faultProfile,
  });
  await created.agent.start();
  return createProbeRuntimeV1(created, { role });
}

export async function createRfc64PrivateFinalizedRuntimeV1(input) {
  assertFinalizedRuntimeFactoryInputV1(input);
  const { dataDir, faultProfile, manifest, role } = input;
  rolePrivateKey(role);
  const created = await createRfc64PrivateFinalizedAgentV1({
    dataDir,
    faultProfile,
    manifest,
    role,
  });
  await created.agent.start();
  return bindRfc64PrivateFinalizedRuntimeV1({ created, manifest, role });
}

async function createRfc64PrivateFinalizedAgentV1({
  dataDir,
  faultProfile,
  manifest,
  role,
}) {
  const canonicalFixture = createFinalizedChainFixture();
  const fixture = faultProfile.authority.fixture(
    canonicalFixture,
    roleAgentAddress('receiver'),
  );
  const chainAdapter = new Rfc64PrivateDevnetChainAdapter(fixture, {
    ...faultProfile.authority.adapterOptions({
      authorityStatePath: manifest.authorityStatePath,
      ownerAddress: roleAgentAddress('owner'),
    }),
    signerAddress: roleAgentAddress(role),
  });
  await chainAdapter.createOnChainContextGraph({
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: fixture.ownerAddress,
    publishAuthorityAccountId: 0n,
    participantAgents: fixture.participantAgents,
    nameHash: fixture.nameHash,
  });
  const rpc = await startRfc64PrivateDevnetFinalizedRpc(fixture, {
    readAuthoritySnapshot: () => chainAdapter.getContextGraphAuthoritySnapshot(
      BigInt(ON_CHAIN_CONTEXT_GRAPH_ID),
    ),
  });
  const base = createBaseAgentOptionsV1({
    dataDir,
    role,
    chainRuntime: {
      chainAdapter,
      chainConfig: {
        rpcUrl: rpc.url,
        hubAddress: CONTEXT_GRAPH_STORAGE,
        operationalKeys: [rolePrivateKey(role)],
      },
      contextGraphSubscriptionStore: seededSubscriptionStoreV1(
        CONTEXT_GRAPH_ID,
        ON_CHAIN_CONTEXT_GRAPH_ID,
      ),
    },
  });

  const peerIds = manifest.peerIds;
  const agentAddressByPeerId = new Map(RUNTIME_ROLES.map((runtimeRole) => [
    peerIds[runtimeRole],
    roleAgentAddress(runtimeRole),
  ]));
  const accessPolicyAuthority = {
    localAgentAddress: roleAgentAddress(role),
    resolveRemoteAgentAddress: async (peerId) => agentAddressByPeerId.get(peerId) ?? null,
  };
  const finalizedSnapshot = await chainAdapter.getContextGraphAuthoritySnapshot(
    BigInt(ON_CHAIN_CONTEXT_GRAPH_ID),
  );
  await seedPrivateCatalogDefinitionV1(
    base.store,
    peerIds,
    finalizedSnapshot.participantAgents,
  );
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

async function bindRfc64PrivateFinalizedRuntimeV1({ created, manifest, role }) {
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
    ({ agentAddress }) => agentAddress === roleAgentAddress(role),
  ) === true;
  const responsibility = await created.agent.reconcileRfc64CatalogResponsibilityV1(
    CONTEXT_GRAPH_ID,
  );
  if (runtimeIsMember && (!responsibility.active || responsibility.mode === 'legacy')) {
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
    if (runtimeIsMember || error?.code !== 'catalog-service-unavailable') throw error;
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
  return createFinalizedRuntimeV1(created, {
    initialFinalizedAuthority,
    peerIds: manifest.peerIds,
    role,
  });
}

function createBaseAgentOptionsV1({ dataDir, role, chainRuntime = {} }) {
  return {
    name: `RFC64PrivateReleaseGate-${role}`,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(join(dataDir, 'oxigraph')),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: true,
    agentProfileHeartbeatMs: 0,
    ...chainRuntime,
  };
}

async function seedPrivateCatalogDefinitionV1(store, peerIds, participantAgents) {
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

function seededSubscriptionStoreV1(contextGraphId, onChainId) {
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
