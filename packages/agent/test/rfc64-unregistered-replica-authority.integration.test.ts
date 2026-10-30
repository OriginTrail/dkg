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
  connectRemoteSigners,
  type ContextGraphAuthoritySnapshot,
  type OperationalSigning,
} from '@origintrail-official/dkg-chain';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import { CONTEXT_GRAPH_NAME_HASH_RESOLUTION_TIMEOUT_MS } from
  '../src/dkg-agent-constants.js';
import {
  RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
  mintRfc64UnregisteredReplicaAuthorityEvidenceV1,
  mintRfc64UnregisteredReplicaAuthoritySeedV1,
} from '../src/rfc64/unregistered-replica-authority-v1.js';
import { composeRfc64UnregisteredCatalogAuthorityV1 } from
  '../src/rfc64/release-native-catalog-authority-v1.js';
import { Rfc64CatalogAuthorityRefreshLoopV1 } from
  '../src/rfc64/catalog-authority-refresh-loop-v1.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  '../src/rfc64/catalog-authority-config-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_DEPLOYMENT as DEPLOYMENT,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
} from './_helpers/rfc64-rollout-agent-harness.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

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
const EXTERNAL_PAYER_TOKEN = 'replica-authority-payer-credential-4e5f6a7b';
const EXTERNAL_AUTHOR_TOKEN = 'replica-authority-author-credential-7b6a5f4e';
const EXTERNAL_AUTHOR = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);

/** The chain adapter of a node whose operational wallets sign through an external signer. */
class ExternallySignedNoChain extends NoChainAdapter {
  operationalSigning(): OperationalSigning {
    return { external: true, payerAddresses: [] };
  }
}

const {
  createDataDir,
  startAgent,
  restartAgent,
  cleanup,
} = createRfc64RolloutAgentHarness();

const fakes: FakeSigner[] = [];
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  while (fakes.length > 0) await fakes.pop()!.close();
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
    const custodialKeys = vi.spyOn(publisher, 'getCustodialAgentPrivateKey');
    const ownerKeyReads = () => custodialKeys.mock.calls
      .filter(([address]) => address.toLowerCase() === namespaceOwner).length;

    await expect(publisher.createContextGraph({
      id: `${namespaceOwner}/admin-token-attempt`,
      name: 'Admin-token attempt',
      accessPolicy: 0,
    })).rejects.toThrow(/uses wallet namespace.*authenticated caller/iu);
    expect(ownerKeyReads()).toBe(0);
    await expect(publisher.contextGraphExists(
      `${namespaceOwner}/admin-token-attempt`,
    )).resolves.toBe(false);

    // The owner's own request reads its key and creates the graph.
    await publisher.createContextGraph({
      id: `${namespaceOwner}/owner-request`,
      name: 'Owner request',
      accessPolicy: 0,
      callerAgentAddress: namespaceOwner,
    });
    expect(ownerKeyReads()).toBeGreaterThan(0);
    await expect(publisher.contextGraphExists(`${namespaceOwner}/owner-request`)).resolves.toBe(true);
  });

  it('rejects a mismatched caller before looking up an external author key or asking the signer', async () => {
    const fake = await startFakeRemoteSigner({
      credentials: [
        { token: EXTERNAL_PAYER_TOKEN, keys: [HARDHAT_KEYS.PUBLISHER] },
        { token: EXTERNAL_AUTHOR_TOKEN, keys: [EXTERNAL_AUTHOR.privateKey] },
      ],
    });
    fakes.push(fake);
    const remote = await connectRemoteSigners({
      url: fake.url,
      authToken: EXTERNAL_PAYER_TOKEN,
      author: { authToken: EXTERNAL_AUTHOR_TOKEN },
    });
    const publisher = await startAgent({
      name: 'unregistered-evidence-external-author',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: new ExternallySignedNoChain(),
        authorSigners: remote.authors,
      },
    });
    const owner = EXTERNAL_AUTHOR.address.toLowerCase();
    expect(publisher.getDefaultAgentAddress()?.toLowerCase()).toBe(owner);
    const authors = remote.authors!;
    const lookups = [vi.spyOn(authors, 'signerFor'), vi.spyOn(authors, 'firstSignerOf')];
    const custodialKeys = vi.spyOn(publisher, 'getCustodialAgentPrivateKey');
    const requestsBefore = fake.requests.length;

    await expect(publisher.createContextGraph({
      id: `${owner}/mismatched-caller`,
      name: 'Mismatched caller',
      accessPolicy: 0,
      callerAgentAddress: ATTACKER,
    })).rejects.toThrow(/uses wallet namespace.*authenticated caller/iu);
    for (const lookup of lookups) expect(lookup).not.toHaveBeenCalled();
    expect(custodialKeys.mock.calls.filter(([address]) => address.toLowerCase() === owner)).toEqual([]);
    expect(fake.requests).toHaveLength(requestsBefore);
    await expect(publisher.contextGraphExists(`${owner}/mismatched-caller`)).resolves.toBe(false);

    // The owner's own request looks its author key up and has the signer sign the seed.
    await publisher.createContextGraph({ id: `${owner}/owner-request`, name: 'Owner request', accessPolicy: 0 });
    expect(lookups.some((lookup) => lookup.mock.calls.length > 0)).toBe(true);
    const signed = fake.calls('eth_sign');
    expect(signed).toHaveLength(1);
    expect(signed[0]!.authorization).toBe(`Bearer ${EXTERNAL_AUTHOR_TOKEN}`);
    await expect(publisher.contextGraphExists(`${owner}/owner-request`)).resolves.toBe(true);
  });

  it('rejects a matching caller when its custodial signing key is unavailable', async () => {
    const publisher = await startPublisher('unregistered-evidence-missing-signer');
    const externalOwner = ethers.Wallet.createRandom().address.toLowerCase();

    await expect(publisher.createContextGraph({
      id: `${externalOwner}/missing-signer-attempt`,
      name: 'Missing signer attempt',
      accessPolicy: 0,
      callerAgentAddress: externalOwner,
    })).rejects.toThrow(/no signing key/iu);
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
    const resolveFinalized = vi.fn(async () => new Map());
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-evidence-adversarial-receiver',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
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
    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      CONTEXT_GRAPH_ID,
    )).toBeNull();
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

  it('scheduled authority refresh promotes accepted absence and unlocks VM binding', async () => {
    let registered: ContextGraphAuthoritySnapshot | undefined;
    const resolveFinalized = vi.fn(async (nameHashes: readonly string[]) => (
      registered === undefined
        ? new Map()
        : new Map([[nameHashes[0]!, registered]])
    ));
    const legacyScalar = vi.fn(async () => {
      throw new Error('scheduled transition must not use legacy name enumeration');
    });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      resolveContextGraphIdByNameHash: legacyScalar,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-evidence-sequential-promotion',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
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
    receiver.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    expect((receiver as any).isVmReconcileTargetSelected(CONTEXT_GRAPH_ID)).toBe(false);

    registered = finalizedAuthoritySnapshot();
    const timer = {} as ReturnType<typeof setInterval>;
    const scheduledRefresh = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => [CONTEXT_GRAPH_ID],
      createRefreshRequests: (contextGraphIds, signal) => (
        receiver.createRfc64CatalogAuthorityRefreshRequestsV1(contextGraphIds, signal)
      ),
      refreshContextGraph: async (contextGraphId, signal, request) => (
        await receiver.reconcileRfc64CatalogAccessAuthorityV1(
          contextGraphId,
          signal,
          request,
        ) === null ? 'superseded' : 'committed'
      ),
      onActiveContextGraphIdsReadFailure: vi.fn(),
      onRefreshFailure: vi.fn(),
      scheduler: {
        setInterval: vi.fn(() => timer),
        clearInterval: vi.fn(),
        setTimeout: vi.fn(() => timer),
        clearTimeout: vi.fn(),
      },
    });
    scheduledRefresh.start();
    await scheduledRefresh.whenIdle();
    await scheduledRefresh.close();

    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      CONTEXT_GRAPH_ID,
    )).toMatchObject({
      policy: { source: { kind: 'finalized-chain' } },
    });
    expect((receiver as any).isVmReconcileTargetSelected(CONTEXT_GRAPH_ID)).toBe(true);
    vi.spyOn(receiver as any, 'vmReconcileEnabled').mockReturnValue(true);
    vi.spyOn(receiver, 'canReadContextGraph').mockResolvedValue(true);
    await expect((receiver as any).resolveVmReconcileTarget(CONTEXT_GRAPH_ID))
      .resolves.toMatchObject({
        kind: 'subscription',
        bindingKind: 'authoritative',
        onChainId: registered.contextGraphId,
      });
    expect(receiver.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID))
      .toMatchObject({ onChainId: registered.contextGraphId });

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
    expect(legacyScalar).not.toHaveBeenCalled();
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
    const whenIdle = vi.fn(async () => undefined);
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes:
          vi.fn(async () => { throw timeout; }),
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle,
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
    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
    });
    expect(whenIdle).toHaveBeenCalledOnce();
    expect(receiver.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
  });

  it('does not reinterpret private owner-signed absence as public bootstrap authority', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const legacyScalar = vi.fn(async () => { throw new Error('must not legacy scalar-read'); });
    const legacyBatch = vi.fn(async () => { throw new Error('must not legacy batch-read'); });
    const pointRead = vi.fn(async () => { throw new Error('must not point-read'); });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointRead,
      resolveContextGraphIdByNameHash: legacyScalar,
      resolveContextGraphIdsByNameHashes: legacyBatch,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-private-bootstrap-fence',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
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

    await expect(receiver.resolveContextGraphRegistrationBinding(
      CONTEXT_GRAPH_ID,
    )).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      {
        callerAgentAddress: ATTACKER,
        allowSubscriptionFallback: false,
      },
    )).resolves.toMatchObject({
      outcome: 'denied',
      source: 'rfc64-private',
    });
    expect(resolveFinalized).toHaveBeenCalledTimes(2);
    expect(pointRead).not.toHaveBeenCalled();
    expect(legacyScalar).not.toHaveBeenCalled();
    expect(legacyBatch).not.toHaveBeenCalled();
    expect(receiver.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
  });

  it('keeps finalized absence unavailable without independent accepted authority', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const legacyScalar = vi.fn(async () => { throw new Error('must not legacy scalar-read'); });
    const legacyBatch = vi.fn(async () => { throw new Error('must not legacy batch-read'); });
    const whenIdle = vi.fn(async () => undefined);
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      resolveContextGraphIdByNameHash: legacyScalar,
      resolveContextGraphIdsByNameHashes: legacyBatch,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle,
      },
    });
    const receiver = await startAgent({
      name: 'unaccepted-finalized-absence-fence',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
    });
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const localPolicy = vi.spyOn(receiver, 'isPrivateContextGraph');

    await expect(receiver.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'finalized-name-absence-unaccepted',
    });

    expect(resolveFinalized).toHaveBeenCalledOnce();
    expect(whenIdle).not.toHaveBeenCalled();
    expect(legacyScalar).not.toHaveBeenCalled();
    expect(legacyBatch).not.toHaveBeenCalled();
    expect(localPolicy).not.toHaveBeenCalled();
  });

  it('consumes one exact finalized-absence pass without reopening point RPC reads', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const pointRead = vi.fn(async () => { throw new Error('must not point-read'); });
    const legacyScalar = vi.fn(async () => { throw new Error('must not legacy scalar-read'); });
    const legacyBatch = vi.fn(async () => { throw new Error('must not legacy batch-read'); });
    const whenIdle = vi.fn(async () => undefined);
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointRead,
      resolveContextGraphIdByNameHash: legacyScalar,
      resolveContextGraphIdsByNameHashes: legacyBatch,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle,
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
    expect((receiver as any).hasAcceptedRfc64UnregisteredAuthorityV1(
      CONTEXT_GRAPH_ID,
    )).toBe(true);
    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-public',
    });
    await expect(receiver.query('SELECT * WHERE { ?s ?p ?o }', {
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.toMatchObject({ bindings: [] });
    receiver.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    expect(receiver.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(true);
    expect(resolveFinalized).toHaveBeenCalledTimes(3);
    expect(whenIdle).toHaveBeenCalledOnce();
    expect(pointRead).not.toHaveBeenCalled();
    expect(legacyScalar).not.toHaveBeenCalled();
    expect(legacyBatch).not.toHaveBeenCalled();
  });

  it('authenticates owner evidence at the cold subscription boundary', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const pointRead = vi.fn(async () => { throw new Error('must not point-read'); });
    const legacyScalar = vi.fn(async () => { throw new Error('must not legacy scalar-read'); });
    const legacyBatch = vi.fn(async () => { throw new Error('must not legacy batch-read'); });
    const whenIdle = vi.fn(async () => undefined);
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointRead,
      resolveContextGraphIdByNameHash: legacyScalar,
      resolveContextGraphIdsByNameHashes: legacyBatch,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle,
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-evidence-subscription-bootstrap',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
    });
    await storeOf(receiver).insert([evidenceQuad(await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
    }))]);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-public',
    });
    expect((receiver as any).hasAcceptedRfc64UnregisteredAuthorityV1(
      CONTEXT_GRAPH_ID,
    )).toBe(true);
    expect(resolveFinalized).toHaveBeenCalledTimes(2);
    expect(whenIdle).not.toHaveBeenCalled();
    expect(pointRead).not.toHaveBeenCalled();
    expect(legacyScalar).not.toHaveBeenCalled();
    expect(legacyBatch).not.toHaveBeenCalled();
    expect(receiver.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
  });

  it('does not promote a cold private owner policy through public subscription bootstrap', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-private-evidence-cold-subscription',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
    });
    await storeOf(receiver).insert([evidenceQuad(await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
      accessPolicy: 1,
    }))]);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      {
        callerAgentAddress: OWNER,
        allowSubscriptionFallback: false,
      },
    )).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(resolveFinalized).toHaveBeenCalledOnce();
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      CONTEXT_GRAPH_ID,
    )).toBeNull();
    expect(receiver.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
  });

  it('keeps repeated missing-evidence subscription retries on the finalized index lane', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const pointRead = vi.fn(async () => { throw new Error('must not point-read'); });
    const legacyScalar = vi.fn(async () => { throw new Error('must not legacy scalar-read'); });
    const legacyBatch = vi.fn(async () => { throw new Error('must not legacy batch-read'); });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointRead,
      resolveContextGraphIdByNameHash: legacyScalar,
      resolveContextGraphIdsByNameHashes: legacyBatch,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-missing-evidence-subscription-retries',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
    });
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
        CONTEXT_GRAPH_ID,
        { allowSubscriptionFallback: false },
      )).resolves.toMatchObject({
        outcome: 'unavailable',
        source: 'registered-chain',
        reason: 'finalized-name-absence-unaccepted',
      });
    }
    expect(resolveFinalized).toHaveBeenCalledTimes(3);
    expect(pointRead).not.toHaveBeenCalled();
    expect(legacyScalar).not.toHaveBeenCalled();
    expect(legacyBatch).not.toHaveBeenCalled();
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      CONTEXT_GRAPH_ID,
    )).toBeNull();
    expect(receiver.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
  });

  it('replaces replica authority when registration finalizes during bootstrap', async () => {
    const registered = finalizedAuthoritySnapshot();
    let finalizedReads = 0;
    const resolveFinalized = vi.fn(async (nameHashes: readonly string[]) => {
      finalizedReads += 1;
      return finalizedReads === 1
        ? new Map()
        : new Map([[nameHashes[0]!, registered]]);
    });
    const pointRead = vi.fn(async () => { throw new Error('must not point-read'); });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointRead,
      isContextGraphActiveOnChain: vi.fn(async () => true),
      getContextGraphAccessPolicy: vi.fn(async () => 0),
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-evidence-registration-during-bootstrap',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
    });
    await storeOf(receiver).insert([evidenceQuad(await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
    }))]);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'registered-chain',
      onChainId: BigInt(registered.contextGraphId),
    });
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      CONTEXT_GRAPH_ID,
    )).toMatchObject({ policy: { source: { kind: 'finalized-chain' } } });
    expect(resolveFinalized).toHaveBeenCalledTimes(4);
    expect(pointRead).not.toHaveBeenCalled();
    expect(receiver.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
  });

  it('preserves a private registration denial that finalizes during bootstrap', async () => {
    const registered = Object.freeze({
      ...finalizedAuthoritySnapshot(),
      accessPolicy: 1 as const,
    });
    let finalizedReads = 0;
    const resolveFinalized = vi.fn(async (nameHashes: readonly string[]) => {
      finalizedReads += 1;
      return finalizedReads === 1
        ? new Map()
        : new Map([[nameHashes[0]!, registered]]);
    });
    const pointRead = vi.fn(async () => { throw new Error('must not point-read'); });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointRead,
      isContextGraphActiveOnChain: vi.fn(async () => true),
      getContextGraphAccessPolicy: vi.fn(async () => 1),
      getContextGraphParticipantAgents: vi.fn(async () => []),
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-private-registration-during-bootstrap',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
    });
    await storeOf(receiver).insert([evidenceQuad(await mintEvidence({
      wallet: OWNER_WALLET,
      owner: OWNER,
      contextGraphId: CONTEXT_GRAPH_ID,
    }))]);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'denied',
      source: 'registered-chain',
      reason: 'agent-not-in-chain-roster',
      onChainId: BigInt(registered.contextGraphId),
      metadataBootstrap: 'forbidden',
    });
    expect(resolveFinalized).toHaveBeenCalledTimes(2);
    expect(pointRead).not.toHaveBeenCalled();
    expect(receiver.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
  });

  it('bounds a stalled subscription evidence read and leaves no accepted authority', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'unregistered-evidence-subscription-store-timeout',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
    });
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const store = storeOf(receiver);
    const realQuery = store.query.bind(store);
    let evidenceReadStarted!: () => void;
    const started = new Promise<void>((resolve) => { evidenceReadStarted = resolve; });
    vi.spyOn(store, 'query').mockImplementation((sparql, options) => {
      if (!sparql.includes(RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1)) {
        return realQuery(sparql, options);
      }
      evidenceReadStarted();
      return new Promise(() => undefined);
    });

    vi.useFakeTimers();
    try {
      const authority = receiver.resolveContextGraphSubscriptionBootstrapAuthority(
        CONTEXT_GRAPH_ID,
        { allowSubscriptionFallback: false },
      );
      await started;
      await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_NAME_HASH_RESOLUTION_TIMEOUT_MS);
      await expect(authority).resolves.toMatchObject({
        outcome: 'unavailable',
        source: 'registered-chain',
        reason: 'chain-name-binding-unavailable',
      });
      expect(resolveFinalized).toHaveBeenCalledOnce();
      expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
        NETWORK_ID,
        CONTEXT_GRAPH_ID,
      )).toBeNull();
      expect(receiver.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a seeded public replica readable when a refresh pass outlasts the graph\'s own refresh', async () => {
    const receiver = await startSeededPublicReplica('unregistered-seed-refresh-overlap');
    const failures: unknown[] = [];
    const requestKinds: string[] = [];
    let requestBatches = 0;
    let markRefreshStarted!: () => void;
    let releaseRefresh!: () => void;
    let markRefreshDone!: () => void;
    let markSecondBatchStarted!: () => void;
    let releaseSecondBatch!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const refreshDone = new Promise<void>((resolve) => { markRefreshDone = resolve; });
    const secondBatchStarted = new Promise<void>((resolve) => {
      markSecondBatchStarted = resolve;
    });
    const secondBatchGate = new Promise<void>((resolve) => { releaseSecondBatch = resolve; });
    // A fresh loop, so its first pass is the forced initial one and its
    // second an ordinary one, wired the way the agent wires its own.
    const refresh = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => [CONTEXT_GRAPH_ID],
      createRefreshRequests: async (contextGraphIds, signal) => {
        requestBatches += 1;
        if (requestBatches === 2) {
          markSecondBatchStarted();
          await secondBatchGate;
        }
        return receiver.createRfc64CatalogAuthorityRefreshRequestsV1(contextGraphIds, signal);
      },
      refreshContextGraph: async (contextGraphId, signal, request) => {
        requestKinds.push(request.kind);
        const first = requestKinds.length === 1;
        if (first) {
          markRefreshStarted();
          await refreshGate;
        }
        try {
          return await receiver.reconcileRfc64CatalogAccessAuthorityV1(
            contextGraphId,
            signal,
            request,
          ) === null ? 'superseded' : 'committed';
        } finally {
          if (first) markRefreshDone();
        }
      },
      onActiveContextGraphIdsReadFailure: vi.fn(),
      onRefreshFailure: (_contextGraphId, error) => { failures.push(error); },
      scheduler: {
        setInterval: vi.fn(() => ({}) as ReturnType<typeof setInterval>),
        clearInterval: vi.fn(),
        setTimeout: vi.fn(() => ({}) as ReturnType<typeof setTimeout>),
        clearTimeout: vi.fn(),
      },
    });

    refresh.start();
    await refreshStarted;
    // Subscribing to another graph nudges a pass while this graph's own
    // refresh still runs, and that pass's finalized read outlasts it.
    refresh.trigger();
    await secondBatchStarted;
    releaseRefresh();
    await refreshDone;
    await settleEventLoopTurns();
    releaseSecondBatch();
    await refresh.whenIdle();
    await refresh.close();

    expect(requestBatches).toBe(2);
    expect(requestKinds).toEqual(['finalized-absence']);
    expect(failures).toEqual([]);
    await expect(receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID))
      .resolves.toBe(true);
  });

  it('re-establishes a seeded public replica from the refresh loop\'s own retry', async () => {
    const receiver = await startSeededPublicReplica('unregistered-seed-refresh-retry');
    const owner = (receiver as any).rfc64PublicCatalogOwnerV1;
    // One refresh cannot read the stored seed (a closed or stalled inventory).
    vi.spyOn(receiver, 'readRfc64UnregisteredAuthoritySeedV1')
      .mockRejectedValueOnce(new Error('seed inventory unavailable'));
    const warn = vi.spyOn((receiver as any).log, 'warn');

    owner.requestAuthorityRefresh();
    await owner.whenIdle();
    expect(warn.mock.calls.filter(([, message]) => String(message)
      .includes('authority refresh incomplete'))).toHaveLength(1);
    await expect(receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID))
      .resolves.toBe(false);

    // No lifecycle nudge, sync work or interval tick follows: the loop's own
    // retry reads the stored seed again within its first delay.
    await vi.waitFor(async () => {
      await expect(receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID))
        .resolves.toBe(true);
    }, {
      timeout: RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.failureRetryDelaysMs[0]! + 4_000,
      interval: 100,
    });
    expect(warn.mock.calls.filter(([, message]) => String(message)
      .includes('authority refresh incomplete'))).toHaveLength(1);
  });

  it('catches up only the re-established graph after the refresh loop\'s own retry', async () => {
    const receiver = await startSeededPublicReplica('unregistered-seed-refresh-retry-catchup');
    // The first acceptance's catch-up window passes before any peer connects.
    await new Promise<void>((resolve) => setTimeout(resolve, 3_100));
    const remotePeerId = '12D3KooWRefreshRetryCatchupPeer';
    vi.spyOn(receiver.node.libp2p, 'getPeers').mockReturnValue(
      [{ toString: () => remotePeerId }] as never,
    );
    const queueSync = vi.spyOn(receiver, 'queueSyncFromPeerOnConnect').mockReturnValue(true);
    const owner = (receiver as any).rfc64PublicCatalogOwnerV1;
    vi.spyOn(receiver, 'readRfc64UnregisteredAuthoritySeedV1')
      .mockRejectedValueOnce(new Error('seed inventory unavailable'));

    owner.requestAuthorityRefresh();
    await owner.whenIdle();
    await expect(receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID))
      .resolves.toBe(false);
    expect(queueSync).not.toHaveBeenCalled();

    // The loop's own retry accepts the graph again, and the catch-up that
    // acceptance schedules asks the connected peer for this graph only.
    await vi.waitFor(() => expect(queueSync).toHaveBeenCalledOnce(), {
      timeout: RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.failureRetryDelaysMs[0]! + 3_000 + 4_000,
      interval: 100,
    });
    expect(queueSync).toHaveBeenCalledWith(remotePeerId, expect.any(Function), 0, {
      authorityScopeChanged: true,
      authorityScopeContextGraphIds: new Set([CONTEXT_GRAPH_ID]),
    });
    await expect(receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID))
      .resolves.toBe(true);
  });
});

/**
 * A member that stored the owner-signed seed of an unregistered public graph
 * when it subscribed, the way a seed fetched from a peer is kept, and whose
 * authority for that graph is accepted and readable. Its own authority
 * refresh loop is idle when this returns.
 */
async function startSeededPublicReplica(name: string): Promise<DKGAgent> {
  const chainAdapter = Object.assign(new NoChainAdapter(), {
    contextGraphAuthorityIndexRevisionReader: {
      resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: vi.fn(async () => new Map()),
      readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
      whenIdle: vi.fn(async () => undefined),
    },
  });
  const receiver = await startAgent({
    name,
    config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
  });
  const seed = await mintRfc64UnregisteredReplicaAuthoritySeedV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: OWNER,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthorityAccountId: '0',
    memberAddresses: [],
    rosterVersion: '0',
    signer: {
      issuer: OWNER,
      signDigest: (digest) => OWNER_WALLET.signMessage(digest),
    },
  });
  await receiver.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    canonicalEnvelopeBytes: seed.canonicalEnvelopeBytes,
  });
  vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
  await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
    CONTEXT_GRAPH_ID,
    undefined,
    { kind: 'finalized-absence' },
  )).resolves.toMatchObject({ source: 'owner-signed-unregistered' });
  receiver.subscribeToContextGraph(CONTEXT_GRAPH_ID);
  await receiver.whenRfc64CatalogResponsibilitiesIdleV1();
  await (receiver as any).rfc64PublicCatalogOwnerV1.whenIdle();
  await expect(receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID))
    .resolves.toBe(true);
  return receiver;
}

async function settleEventLoopTurns(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

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
