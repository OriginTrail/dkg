// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import {
  contextGraphDataGraphUri,
  SYSTEM_CONTEXT_GRAPHS,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import {
  NoChainAdapter,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import {
  RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
  mintRfc64UnregisteredReplicaAuthorityEvidenceV1,
} from '../src/rfc64/unregistered-replica-authority-v1.js';
import { composeRfc64UnregisteredCatalogAuthorityV1 } from
  '../src/rfc64/release-native-catalog-authority-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_DEPLOYMENT as DEPLOYMENT,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
} from './_helpers/rfc64-rollout-agent-harness.js';

const OWNER_WALLET = new ethers.Wallet(`0x${'71'.repeat(32)}`);
const OWNER = OWNER_WALLET.address.toLowerCase() as EvmAddressV1;
const DEFAULT_NODE_WALLET = new ethers.Wallet(`0x${'70'.repeat(32)}`);
const ATTACKER_WALLET = new ethers.Wallet(`0x${'72'.repeat(32)}`);
const ATTACKER = ATTACKER_WALLET.address.toLowerCase() as EvmAddressV1;
const CONTEXT_GRAPH_ID = `${OWNER}/replica-bootstrap` as ContextGraphIdV1;
const OTHER_CONTEXT_GRAPH_ID = `${OWNER}/other` as ContextGraphIdV1;
const CONTEXT_GRAPH_SUBJECT = contextGraphDataGraphUri(CONTEXT_GRAPH_ID);
const ONTOLOGY_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const HUB = '0x3333333333333333333333333333333333333333';

const {
  createDataDir,
  startAgent,
  restartAgent,
  cleanup,
} = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('RFC-64 unregistered replica authority', () => {
  it('keeps ontology-only discovery blocked, then enables replica SWM from owner evidence', async () => {
    const publisher = await startPublisher('unregistered-evidence-publisher');
    const receiver = await startAgent({
      name: 'unregistered-evidence-receiver',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    const nestedAgent = await publisher.registerAgent('nested-author');
    const nestedOwner = nestedAgent.agentAddress.toLowerCase() as EvmAddressV1;
    const nestedContextGraphId = (
      `${nestedOwner}/replica-bootstrap`
    ) as ContextGraphIdV1;
    await publisher.createContextGraph({
      id: nestedContextGraphId,
      name: 'Replica bootstrap',
      accessPolicy: 0,
      callerAgentAddress: nestedOwner,
    });

    const publisherDefinition = await readPublisherDefinition(
      publisher,
      nestedContextGraphId,
    );
    const authorityEvidence = publisherDefinition.filter(
      (quad) => quad.predicate === RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
    );
    expect(authorityEvidence).toHaveLength(1);

    const receiverStore = storeOf(receiver);
    await receiverStore.insert(publisherDefinition.filter(
      (quad) => quad.predicate !== RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
    ));
    receiver.subscribeToContextGraph(nestedContextGraphId, { syncMode: 'always-on' });
    await receiver.whenRfc64CatalogResponsibilitiesIdleV1();
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
      nestedContextGraphId,
      undefined,
      { kind: 'finalized-absence' },
    )).rejects.toMatchObject({
      code: 'unregistered-owner-unresolved',
    });

    // Simulate the second agent receiving the source-authenticated ontology
    // definition after its finalized name-index read already proved absence.
    await receiverStore.insert(authorityEvidence);
    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
      nestedContextGraphId,
      undefined,
      { kind: 'finalized-absence' },
    )).resolves.toMatchObject({
      source: 'owner-signed-unregistered',
      policy: {
        contextGraphId: nestedContextGraphId,
        source: { ownerAddress: nestedOwner },
      },
    });
    await expect(receiver.canUseSharedMemoryForContextGraph(nestedContextGraphId))
      .resolves.toBe(true);
  });

  it('rejects an admin-token caller before using another local agent key', async () => {
    const publisher = await startPublisher('unregistered-evidence-admin-token');
    const namespaceAgent = await publisher.registerAgent('namespace-owner');
    const namespaceOwner = namespaceAgent.agentAddress.toLowerCase();
    const getSigner = vi.spyOn(publisher, 'getWorkspaceSigningAgentForAddress');

    await expect(publisher.createContextGraph({
      id: `${namespaceOwner}/admin-token-attempt`,
      name: 'Admin-token attempt',
      accessPolicy: 0,
    })).rejects.toThrow(/uses wallet namespace.*authenticated caller/iu);
    expect(getSigner).not.toHaveBeenCalled();
    await expect(publisher.contextGraphExists(
      `${namespaceOwner}/admin-token-attempt`,
    )).resolves.toBe(false);
  });

  it('rejects a matching caller when its custodial signing key is unavailable', async () => {
    const publisher = await startPublisher('unregistered-evidence-missing-signer');
    const externalOwner = ethers.Wallet.createRandom().address.toLowerCase();

    await expect(publisher.createContextGraph({
      id: `${externalOwner}/missing-signer-attempt`,
      name: 'Missing signer attempt',
      accessPolicy: 0,
      callerAgentAddress: externalOwner,
    })).rejects.toThrow(/no custodial signing key/iu);
    await expect(publisher.contextGraphExists(
      `${externalOwner}/missing-signer-attempt`,
    )).resolves.toBe(false);
  });

  it('does not reinterpret directly accepted private authority as unsigned public authority', async () => {
    const receiver = await startAgent({
      name: 'unregistered-private-to-public-downgrade',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    const privateAuthority = composeRfc64UnregisteredCatalogAuthorityV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: OWNER,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthorityAccountId: '0',
      memberAddresses: [OWNER],
      rosterVersion: '0',
    });
    receiver.acceptRfc64CatalogAccessSnapshotV1({
      policy: privateAuthority.policy,
      policyDigest: privateAuthority.policyDigest,
      roster: privateAuthority.roster,
    });
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    vi.spyOn(receiver, 'getContextGraphOwner').mockResolvedValue(`did:dkg:agent:${OWNER}`);
    vi.spyOn(receiver, 'getExplicitAccessPolicy').mockResolvedValue('public');

    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID))
      .rejects.toMatchObject({ code: 'access-policy-unresolved' });
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      CONTEXT_GRAPH_ID,
    )).toMatchObject({ policy: { accessPolicy: 1 } });
  });

  it('rejects forged, wrong-owner and cross-context replay evidence', async () => {
    const receiver = await startAgent({
      name: 'unregistered-evidence-adversarial-receiver',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    const valid = await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    const decoded = JSON.parse(Buffer.from(valid, 'base64url').toString('utf8')) as {
      signature: string;
    };
    decoded.signature = `0x${'00'.repeat(65)}`;
    const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    const wrongOwner = await mintEvidence({
      wallet: ATTACKER_WALLET,
      owner: ATTACKER,
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    const replay = await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: OTHER_CONTEXT_GRAPH_ID,
    });
    const privatePolicy = await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
      accessPolicy: 1,
    });
    const wrongNetwork = await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
      networkId: 'otp:1' as NetworkIdV1,
    });
    await storeOf(receiver).insert([
      forged,
      wrongOwner,
      replay,
      privatePolicy,
      wrongNetwork,
    ].map(evidenceQuad));
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).rejects.toMatchObject({ code: 'unregistered-owner-unresolved' });
  });

  it('fences stale absence reconciliation behind later finalized registration', async () => {
    const receiver = await startAgent({
      name: 'unregistered-evidence-registration-fence',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    const evidence = await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    await storeOf(receiver).insert([evidenceQuad(evidence)]);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    const store = storeOf(receiver);
    const realQuery = store.query.bind(store);
    let releaseAbsenceRead!: () => void;
    const absenceReadStarted = new Promise<void>((resolve) => {
      vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
        if (!sparql.includes(RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1)) {
          return realQuery(sparql, options);
        }
        resolve();
        await new Promise<void>((release) => { releaseAbsenceRead = release; });
        return realQuery(sparql, options);
      });
    });
    const staleAbsence = receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    await absenceReadStarted;

    const registered = finalizedAuthoritySnapshot();
    receiver.recordDiscoveredContextGraph(CONTEXT_GRAPH_ID, {
      name: CONTEXT_GRAPH_ID,
      onChainId: registered.contextGraphId,
      onChainHash: registered.nameHash,
    });
    const finalized = await receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      {
        kind: 'finalized-evidence',
        evidence: {
          contextGraphAuthorityIndexId: registered.contextGraphId,
          batchTargetIds: [registered.contextGraphId],
          snapshot: registered,
        },
      },
    );
    releaseAbsenceRead();

    await expect(staleAbsence).resolves.toBeNull();
    expect(finalized).toMatchObject({ source: 'finalized-chain' });
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      CONTEXT_GRAPH_ID,
    )).toMatchObject({
      policy: { source: { kind: 'finalized-chain' } },
    });
  });

  it('rejects a delayed unregistered seed after binding-only chain discovery', async () => {
    const receiver = await startAgent({
      name: 'unregistered-evidence-binding-only-fence',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    const evidence = await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    await storeOf(receiver).insert([evidenceQuad(evidence)]);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    const store = storeOf(receiver);
    const realQuery = store.query.bind(store);
    let releaseEvidenceRead!: () => void;
    const evidenceReadStarted = new Promise<void>((resolve) => {
      vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
        if (!sparql.includes(RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1)) {
          return realQuery(sparql, options);
        }
        resolve();
        await new Promise<void>((release) => { releaseEvidenceRead = release; });
        return realQuery(sparql, options);
      });
    });
    const staleAbsence = receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    await evidenceReadStarted;

    const registered = finalizedAuthoritySnapshot();
    receiver.recordDiscoveredContextGraph(CONTEXT_GRAPH_ID, {
      name: CONTEXT_GRAPH_ID,
      onChainId: registered.contextGraphId,
      onChainHash: registered.nameHash,
    });
    releaseEvidenceRead();

    await expect(staleAbsence).rejects.toMatchObject({
      code: 'registered-authority-binding-mismatch',
    });
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      CONTEXT_GRAPH_ID,
    )).toBeNull();
  });

  it('promotes accepted unregistered authority and cannot regress to its old seed', async () => {
    const receiver = await startAgent({
      name: 'unregistered-evidence-sequential-promotion',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    await storeOf(receiver).insert([evidenceQuad(await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
    }))]);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).resolves.toMatchObject({ source: 'owner-signed-unregistered' });

    const registered = finalizedAuthoritySnapshot();
    receiver.recordDiscoveredContextGraph(CONTEXT_GRAPH_ID, {
      name: CONTEXT_GRAPH_ID,
      onChainId: registered.contextGraphId,
      onChainHash: registered.nameHash,
    });
    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      {
        kind: 'finalized-evidence',
        evidence: {
          contextGraphAuthorityIndexId: registered.contextGraphId,
          batchTargetIds: [registered.contextGraphId],
          snapshot: registered,
        },
      },
    )).resolves.toMatchObject({ source: 'finalized-chain' });

    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).rejects.toMatchObject({ code: 'registered-authority-binding-mismatch' });
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      CONTEXT_GRAPH_ID,
    )).toMatchObject({
      policy: { source: { kind: 'finalized-chain' } },
    });
  });

  it('re-authenticates the durable ontology seed after a receiver restart', async () => {
    const dataDir = await createDataDir('unregistered-evidence-restart');
    const persistentStorePath = join(dataDir, 'oxigraph');
    let receiver = await startAgent({
      name: 'unregistered-evidence-restart-before',
      dataDir,
      persistentStorePath,
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    const evidence = await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    await storeOf(receiver).insert([evidenceQuad(evidence)]);

    receiver = await restartAgent(receiver, {
      name: 'unregistered-evidence-restart-after',
      dataDir,
      persistentStorePath,
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).resolves.toMatchObject({ source: 'owner-signed-unregistered' });
  });

  it('does not consume signed ontology evidence when finalized absence times out', async () => {
    const timeout = new Error('finalized authority index timeout');
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes:
          vi.fn(async () => { throw timeout; }),
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-evidence-absence-timeout',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter,
      },
    });
    await storeOf(receiver).insert([evidenceQuad(await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
    }))]);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.createRfc64CatalogAuthorityRefreshRequestsV1(
      [CONTEXT_GRAPH_ID],
      new AbortController().signal,
    )).rejects.toBe(timeout);
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      CONTEXT_GRAPH_ID,
    )).toBeNull();
  });

  it('consumes one exact finalized-absence pass without reopening point RPC reads', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const pointRead = vi.fn(async () => { throw new Error('must not point-read'); });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointRead,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-evidence-exact-absence',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter,
      },
    });
    await storeOf(receiver).insert([evidenceQuad(await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
    }))]);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    const requests = await receiver.createRfc64CatalogAuthorityRefreshRequestsV1(
      [CONTEXT_GRAPH_ID],
      new AbortController().signal,
    );
    const request = requests.get(CONTEXT_GRAPH_ID);
    expect(request).toEqual({ kind: 'finalized-absence' });
    if (request === undefined) throw new Error('missing authority refresh request');
    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      request,
    )).resolves.toMatchObject({ source: 'owner-signed-unregistered' });
    expect(resolveFinalized).toHaveBeenCalledOnce();
    expect(pointRead).not.toHaveBeenCalled();
  });
});

async function startPublisher(name: string): Promise<DKGAgent> {
  return startAgent({
    name,
    config: {
      rfc64CatalogDeploymentProfile: DEPLOYMENT,
      chainAdapter: new NoChainAdapter(),
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:1',
        hubAddress: HUB,
        operationalKeys: [DEFAULT_NODE_WALLET.privateKey],
      },
    },
  });
}

function storeOf(agent: DKGAgent): TripleStore {
  return (agent as unknown as { store: TripleStore }).store;
}

async function readPublisherDefinition(
  publisher: DKGAgent,
  contextGraphId: ContextGraphIdV1,
): Promise<Quad[]> {
  const subject = contextGraphDataGraphUri(contextGraphId);
  const result = await storeOf(publisher).query(
    `SELECT ?predicate ?object WHERE { GRAPH <${ONTOLOGY_GRAPH}> { ` +
    `<${subject}> ?predicate ?object . } }`,
  );
  if (result.type !== 'bindings') throw new Error('expected ontology bindings');
  return result.bindings.map((row) => ({
    subject,
    predicate: row['predicate']!,
    object: row['object']!,
    graph: ONTOLOGY_GRAPH,
  }));
}

async function mintEvidence(input: Readonly<{
  readonly wallet: ethers.Wallet;
  readonly owner: EvmAddressV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly networkId?: NetworkIdV1;
  readonly accessPolicy?: 0 | 1;
}>): Promise<string> {
  return mintRfc64UnregisteredReplicaAuthorityEvidenceV1({
    networkId: input.networkId ?? NETWORK_ID,
    contextGraphId: input.contextGraphId,
    ownerAddress: input.owner,
    accessPolicy: input.accessPolicy ?? 0,
    publishPolicy: 1,
    publishAuthorityAccountId: '0',
    memberAddresses: [],
    rosterVersion: '0',
    signer: {
      issuer: input.owner,
      signDigest: (digest) => input.wallet.signMessage(digest),
    },
  });
}

function evidenceQuad(evidence: string): Quad {
  return {
    subject: CONTEXT_GRAPH_SUBJECT,
    predicate: RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
    object: `"${evidence}"`,
    graph: ONTOLOGY_GRAPH,
  };
}

function finalizedAuthoritySnapshot(): ContextGraphAuthoritySnapshot {
  return Object.freeze({
    chainId: '20430',
    governanceContract: HUB,
    contextGraphId: '9',
    owner: OWNER,
    active: true,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    participantAgents: [],
    nameHash: ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase(),
    ownershipEra: '1',
    policyVersion: '1',
    rosterVersion: '0',
    sourceBlockNumber: '42',
    sourceBlockHash: `0x${'44'.repeat(32)}`,
  });
}
