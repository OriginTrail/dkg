// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import {
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  DKG_ONTOLOGY,
  type EvmAddressV1,
  type NetworkIdV1,
  computeNetworkId,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import {
  DKGAgent,
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionStore,
  type DKGAgentConfig,
  type Rfc64CatalogAccessPolicyAuthorityConfigV1,
} from '@origintrail-official/dkg-agent';
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
  createFinalizedChainFixture,
  createPrivatePolicyAndRoster,
  createReceiverRevokedPolicyAndRoster,
  roleAgentAddress,
  rolePrivateKey,
} from './fixture.mjs';
import {
  RFC64_PRIVATE_RUNTIME_ROLES_V1,
  createOwnerPublicationStateV1,
  type FinalizedRuntimeV1,
  type ProbeRuntimeV1,
  type Rfc64PrivateFaultProfileV1,
  type Rfc64PrivateCatalogClosureReaderV1,
  type Rfc64PrivateFinalizedRpcV1,
  type Rfc64PrivateRuntimeManifestV1,
  type Rfc64PrivateRuntimeRoleV1,
} from './agent-runtime.ts';
import {
  assertFinalizedAuthorityMatchesExpectedV1,
  assertInitialFinalizedAuthorityV1,
} from './initial-authority.mjs';

type ProbeRuntimeFactoryInputV1 = Readonly<{
  dataDir: string;
  faultProfile: Rfc64PrivateFaultProfileV1;
  role: Rfc64PrivateRuntimeRoleV1;
}>;

type FinalizedRuntimeFactoryInputV1 = ProbeRuntimeFactoryInputV1 & Readonly<{
  manifest: Rfc64PrivateRuntimeManifestV1;
}>;

type Rfc64PrivateFinalizedAgentConfigKeyV1 =
  | 'chainAdapter'
  | 'chainConfig'
  | 'contextGraphSubscriptionStore'
  | 'networkIdentity'
  | 'rfc64CatalogAccessPolicyAuthority'
  | 'rfc64CatalogActivation';

export type Rfc64PrivateFinalizedAgentConfigV1 = DKGAgentConfig & Readonly<
  Required<Pick<DKGAgentConfig, Rfc64PrivateFinalizedAgentConfigKeyV1>>
>;

class Rfc64PrivateFinalizedRuntimeAcquisitionV1 {
  #store: Pick<OxigraphStore, 'close'> | undefined;
  #rpc: Pick<Rfc64PrivateFinalizedRpcV1, 'close'> | undefined;
  #agent: Pick<DKGAgent, 'stop'> | undefined;

  ownStore<T extends Pick<OxigraphStore, 'close'>>(store: T): T {
    this.#store = store;
    return store;
  }

  ownRpc<T extends Pick<Rfc64PrivateFinalizedRpcV1, 'close'>>(rpc: T): T {
    this.#rpc = rpc;
    return rpc;
  }

  ownAgent<T extends Pick<DKGAgent, 'stop'>>(agent: T): T {
    this.#agent = agent;
    return agent;
  }

  async rollback(cause: unknown): Promise<never> {
    const cleanupFailures: unknown[] = [];
    for (const close of [
      () => this.#agent?.stop(),
      () => this.#rpc?.close(),
      () => this.#store?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [cause, ...cleanupFailures],
        'RFC-64 finalized runtime acquisition and rollback both failed',
        { cause },
      );
    }
    throw cause;
  }
}

/** Transfer ownership only after every finalized-runtime assertion succeeds. */
export async function withRfc64PrivateFinalizedRuntimeAcquisitionV1<T>(
  acquire: (owner: Rfc64PrivateFinalizedRuntimeAcquisitionV1) => Promise<T>,
): Promise<T> {
  const owner = new Rfc64PrivateFinalizedRuntimeAcquisitionV1();
  try {
    return await acquire(owner);
  } catch (error) {
    return owner.rollback(error);
  }
}

export async function createRfc64PrivateProbeRuntimeV1(
  input: ProbeRuntimeFactoryInputV1,
): Promise<ProbeRuntimeV1> {
  const { dataDir, faultProfile, role } = input;
  rolePrivateKey(role);
  const created = Object.freeze({
    agent: await DKGAgent.create(createBaseAgentConfigV1({ dataDir, role })),
    faultProfile,
  });
  await created.agent.start();
  return Object.freeze({ ...created, kind: 'probe', role });
}

export async function createRfc64PrivateFinalizedRuntimeV1(
  input: FinalizedRuntimeFactoryInputV1,
): Promise<FinalizedRuntimeV1> {
  return withRfc64PrivateFinalizedRuntimeAcquisitionV1(async (owner) => {
    const { manifest, role } = input;
    rolePrivateKey(role);
    const created = await createRfc64PrivateFinalizedAgentV1(input, owner);
    await created.agent.start();
    return bindRfc64PrivateFinalizedRuntimeV1({ created, manifest, role });
  });
}

async function createRfc64PrivateFinalizedAgentV1(
  {
    dataDir,
    faultProfile,
    manifest,
    role,
  }: FinalizedRuntimeFactoryInputV1,
  owner: Rfc64PrivateFinalizedRuntimeAcquisitionV1,
) {
  const store = owner.ownStore(new OxigraphStore(join(dataDir, 'oxigraph')));
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
    participantAgents: [...fixture.participantAgents],
    nameHash: fixture.nameHash,
  });
  const rpc = owner.ownRpc(await startRfc64PrivateDevnetFinalizedRpc(fixture, {
    readAuthoritySnapshot: () => chainAdapter.getContextGraphAuthoritySnapshot(
      BigInt(ON_CHAIN_CONTEXT_GRAPH_ID),
    ),
  }));
  const base = createBaseAgentConfigV1({
    dataDir,
    role,
    store,
  });

  const peerIds = manifest.peerIds;
  const agentAddressByPeerId = new Map(RFC64_PRIVATE_RUNTIME_ROLES_V1.map((runtimeRole) => [
    peerIds[runtimeRole],
    roleAgentAddress(runtimeRole),
  ]));
  const accessPolicyAuthority: Rfc64CatalogAccessPolicyAuthorityConfigV1 = {
    localAgentAddress: roleAgentAddress(role) as EvmAddressV1,
    resolveRemoteAgentAddress: async (peerId: string) =>
      (agentAddressByPeerId.get(peerId) as EvmAddressV1 | undefined) ?? null,
  };
  const finalizedSnapshot = await chainAdapter.getContextGraphAuthoritySnapshot(
    BigInt(ON_CHAIN_CONTEXT_GRAPH_ID),
  );
  await seedPrivateCatalogDefinitionV1(
    store,
    peerIds,
    finalizedSnapshot.participantAgents,
  );
  const finalizedConfig: Rfc64PrivateFinalizedAgentConfigV1 = {
    ...base,
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
      deploymentProfile: DEPLOYMENT as CatalogSealDeploymentProfileV1,
      rollout: {
        contextGraphModes: { [CONTEXT_GRAPH_ID]: 'catalog' },
      },
    },
  };
  const created = owner.ownAgent(await DKGAgent.create(finalizedConfig));
  return Object.freeze({ agent: created, chainAdapter, faultProfile, rpc });
}

async function bindRfc64PrivateFinalizedRuntimeV1({
  created,
  manifest,
  role,
}: Readonly<{
  created: Awaited<ReturnType<typeof createRfc64PrivateFinalizedAgentV1>>;
  manifest: Rfc64PrivateRuntimeManifestV1;
  role: Rfc64PrivateRuntimeRoleV1;
}>): Promise<FinalizedRuntimeV1> {
  const onChainContextGraphId = BigInt(ON_CHAIN_CONTEXT_GRAPH_ID);
  const finalizedAuthority = composeRfc64FinalizedCatalogAuthorityV1({
    networkId: NETWORK_ID as NetworkIdV1,
    contextGraphId: CONTEXT_GRAPH_ID as ContextGraphIdV1,
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
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
    if (runtimeIsMember || code !== 'catalog-service-unavailable') throw error;
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
  const common = Object.freeze({
    ...created,
    kind: 'run',
    initialFinalizedAuthority,
    peerIds: Object.freeze({ ...manifest.peerIds }),
    readVerifiedAppliedCatalogClosure: ((input) =>
      created.agent.readRfc64VerifiedAppliedCatalogClosureV1({
        ...input,
        deployment: DEPLOYMENT as CatalogSealDeploymentProfileV1,
      })) satisfies Rfc64PrivateCatalogClosureReaderV1,
  });
  return role === 'owner'
    ? Object.freeze({ ...common, role, publication: createOwnerPublicationStateV1() })
    : Object.freeze({ ...common, role, publication: null });
}

function createBaseAgentConfigV1({
  dataDir,
  role,
  store,
}: Readonly<{
  dataDir: string;
  role: Rfc64PrivateRuntimeRoleV1;
  store?: OxigraphStore;
}>): DKGAgentConfig {
  return {
    name: `RFC64PrivateReleaseGate-${role}`,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge' as const,
    store: store ?? new OxigraphStore(join(dataDir, 'oxigraph')),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: true,
    agentProfileHeartbeatMs: 0,
  };
}

async function seedPrivateCatalogDefinitionV1(
  store: OxigraphStore,
  peerIds: Readonly<Record<Rfc64PrivateRuntimeRoleV1, string>>,
  participantAgents: readonly string[],
) {
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

function seededSubscriptionStoreV1(
  contextGraphId: string,
  onChainId: string,
): ContextGraphSubscriptionStore {
  const records = new Map<string, ContextGraphSubscriptionRecord>([[contextGraphId, {
    id: contextGraphId,
    subscribed: true,
    synced: false,
    syncScoped: true,
    onChainId,
  }]]);
  return {
    loadAll: async () => [...records.values()].map((record) => ({ ...record })),
    load: async (id: string) => {
      const record = records.get(id);
      return record === undefined ? null : { ...record };
    },
    save: async (record: ContextGraphSubscriptionRecord) => {
      records.set(record.id, { ...record });
    },
    delete: async (id: string) => { records.delete(id); },
  };
}
