import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  computeAuthorCatalogScopeDigestV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import {
  atomicWriteStableJson,
  readCleanRepositoryHead,
  stableJson,
} from '../rfc64-persistence-lifecycle/evidence.js';
import {
  ChildProcessRegistry,
  cleanupPreservingPrimaryFailure,
  type ProcessExitEvidence,
} from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import { Gate1AgentChild, type Gate1AgentEvent } from './agent-child.js';
import {
  GATE1_ADAPTER_PROTOCOL_VERSION,
  GATE1_RAW_SCHEMA_VERSION,
  GATE1_REAL_DKG_AGENT_ADAPTER_ID,
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  appliedReadBackFromTransfer,
  semanticReadBackFromTransfer,
  type Gate1AppliedHeadReadBack,
  type Gate1ForgedEvidence,
  type Gate1TransferEvidence,
} from './model.js';
import { assertGate1ProductCapabilities } from './product-capabilities.js';
import {
  GATE1_AUTHOR_ADDRESS as AUTHOR_ADDRESS,
  GATE1_AUTHOR_PRIVATE_KEY as AUTHOR_PRIVATE_KEY,
  GATE1_DEPLOYMENT as DEPLOYMENT,
  GATE1_NETWORK_ID as NETWORK_ID,
  GATE1_PROJECTION_NQUADS as PROJECTION_NQUADS,
  GATE1_ROLE_MASTER_KEYS as ROLE_MASTER_KEYS,
  createGate1AuthorSealV1 as authorSeal,
} from './fixture.js';
import {
  cleanupRolloutStoreFixture,
  createRolloutStoreFixture,
  type RolloutStoreFixture,
} from './rollout-store-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ADAPTER_PROCESS = join(import.meta.dirname, 'adapter-process.ts');
const DEFAULT_RAW_ARTIFACT = join(import.meta.dirname, 'artifacts/gate1-result.json');
const DEFAULT_VERDICT_ARTIFACT = join(import.meta.dirname, 'artifacts/gate1-verdict.json');
const PROCESS_TIMEOUT_MS = 60_000;

const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/gate-1';
const FORGED_CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/gate-1-forged-authorization';
const ATTACKER_PRIVATE_KEY = `0x${'65'.repeat(32)}`;
const ATTACKER_ADDRESS = new ethers.Wallet(ATTACKER_PRIVATE_KEY).address.toLowerCase();
const GENESIS_ISSUED_AT = '1773900000000';
const POSITIVE_ISSUED_AT = '1773900001000';
const FORGED_ISSUED_AT = '1773900003000';
const DELEGATION_EFFECTIVE_AT = '1773899999000';
const DELEGATION_EXPIRES_AT = '1774000000000';

async function execute(): Promise<void> {
  const headBefore = readCleanRepositoryHead(REPO_ROOT);
  const rawArtifactPath = process.env.DKG_RFC64_GATE1_ARTIFACT ?? DEFAULT_RAW_ARTIFACT;
  const verdictArtifactPath = process.env.DKG_RFC64_GATE1_VERDICT_ARTIFACT
    ?? DEFAULT_VERDICT_ARTIFACT;
  rmSync(rawArtifactPath, { force: true });
  rmSync(verdictArtifactPath, { force: true });

  const authorDataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-gate1-author-'));
  const receiverDataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-gate1-receiver-'));
  const temporaryRoots = [authorDataDir, receiverDataDir];
  const children = new ChildProcessRegistry(20_000);
  let storeFixture: RolloutStoreFixture | undefined;
  let operationFailed = true;
  let primaryFailure: unknown;
  try {
    storeFixture = await createRolloutStoreFixture({
      backendInput: process.env.DKG_RFC64_GATE1_STORE_BACKEND,
      blazegraphTestUrl: process.env.BLAZEGRAPH_TEST_URL,
      storeDataDirs: { author: [authorDataDir], receiver: [receiverDataDir] },
    });
    const author = spawnAgent('author', authorDataDir, children, storeFixture);
    const receiver = spawnAgent('receiver', receiverDataDir, children, storeFixture);
    const [authorReady, receiverReady] = await Promise.all([
      author.waitFor('ready'),
      receiver.waitFor('ready'),
    ]);
    requireRealReady(authorReady, 'author');
    requireRealReady(receiverReady, 'receiver');
    requireCondition(authorReady.peerId !== receiverReady.peerId, 'peer identities are not distinct');
    await connectBothWays(author, receiver, authorReady, receiverReady, 'initial');

    const [authorPolicy, receiverPolicy] = await Promise.all([
      acceptPolicy(author, 'author-policy-v1', CONTEXT_GRAPH_ID),
      acceptPolicy(receiver, 'receiver-policy-v1', CONTEXT_GRAPH_ID),
    ]);
    const authorPolicyDigest = requiredOutputDigest(authorPolicy, 'policyDigest');
    const receiverPolicyDigest = requiredOutputDigest(receiverPolicy, 'policyDigest');
    requireCondition(
      authorPolicyDigest === receiverPolicyDigest,
      'author and receiver derived different open-policy digests',
    );
    assertGate1ProductCapabilities({
      author: authorReady.capabilities,
      receiver: receiverReady.capabilities,
    });

    const seal = await authorSeal();
    const genesisEvent = await author.request(
      'publishGenesis',
      'publish-genesis-v1',
      'operation-completed',
      {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        authorPrivateKey: AUTHOR_PRIVATE_KEY,
        issuedAt: GENESIS_ISSUED_AT,
        catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
        catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
      },
    );
    const genesis = outputRecord(genesisEvent, 'genesis');
    const genesisAnnouncement = outputRecordValue(genesis, 'announcement', 'genesis');
    exact(
      requiredString(genesisAnnouncement.policyDigest, 'genesis.announcement.policyDigest'),
      receiverPolicyDigest,
      'genesis policy digest',
    );
    await announceAndDrain(
      author,
      receiver,
      genesisAnnouncement,
      receiverReady.peerId as string,
      'genesis',
    );

    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR_ADDRESS,
      era: '0',
      bucketCount: '1',
    } as never);
    const genesisApplied = await readApplied(receiver, catalogScopeDigest, AUTHOR_ADDRESS, 'genesis');
    exact(genesisApplied.catalogVersion, '0', 'genesis applied version');
    exact(genesisApplied.inventoryRowCount, 0, 'genesis applied row count');
    exact(
      genesisApplied.currentCatalogHeadDigest,
      requiredString(genesis.headObjectDigest, 'genesis.headObjectDigest'),
      'genesis applied head',
    );

    const positivePublication = await publishSuccessor(author, {
      requestId: 'publish-positive-v1',
      previousHead: stagedHeadRef(genesis, 'genesis'),
      catalogIssuerAuthorization: outputRecordValue(
        genesis,
        'catalogIssuerAuthorization',
        'genesis',
      ),
      seal,
      issuedAt: POSITIVE_ISSUED_AT,
    });
    const positiveAnnouncement = outputRecordValue(
      positivePublication,
      'announcement',
      'positive publication',
    );
    await announceAndDrain(
      author,
      receiver,
      positiveAnnouncement,
      receiverReady.peerId as string,
      'positive',
    );
    const positiveApplied = await readApplied(
      receiver,
      catalogScopeDigest,
      AUTHOR_ADDRESS,
      'positive',
    );
    const positiveSync = await readSynchronization(
      receiver,
      requiredString(positivePublication.headObjectDigest, 'positive.headObjectDigest'),
      'positive',
    );
    const positive = transferEvidence(
      positivePublication,
      positiveSync,
      requiredString(genesis.headObjectDigest, 'genesis.headObjectDigest'),
      'positive',
    );
    exactJson(positiveApplied, appliedReadBackFromTransfer(positive), 'positive applied readback');
    const positiveControlObjectCount = verifiedControlObjectCount(positiveSync, 'positive sync');
    exact(positiveControlObjectCount, 4, 'positive verified control object count');
    const semanticBeforeCrash = await readSemanticGraph(
      receiver,
      positive.swmGraph,
      'positive-before-crash',
    );
    exact(
      requiredSafeInteger(
        semanticBeforeCrash.activatedQuadCount,
        'positive semantic activatedQuadCount',
      ),
      positive.activatedQuadCount,
      'positive semantic quad count',
    );
    exact(
      requiredString(semanticBeforeCrash.projectionNQuads, 'positive semantic projection'),
      PROJECTION_NQUADS,
      'positive exact projection post-read',
    );

    const [authorForgedPolicy, receiverForgedPolicy] = await Promise.all([
      acceptPolicy(author, 'author-forged-policy-v1', FORGED_CONTEXT_GRAPH_ID),
      acceptPolicy(receiver, 'receiver-forged-policy-v1', FORGED_CONTEXT_GRAPH_ID),
    ]);
    const forgedPolicyDigest = requiredOutputDigest(authorForgedPolicy, 'policyDigest');
    exact(
      requiredOutputDigest(receiverForgedPolicy, 'policyDigest'),
      forgedPolicyDigest,
      'forged-CG independently accepted policy digest',
    );
    const forgedPreparedEvent = await author.request(
      'prepareForgedAuthorizationGenesis',
      'prepare-forged-authorization-v1',
      'operation-completed',
      {
        networkId: NETWORK_ID,
        contextGraphId: FORGED_CONTEXT_GRAPH_ID,
        policyDigest: forgedPolicyDigest,
        catalogAuthorPrivateKey: AUTHOR_PRIVATE_KEY,
        attackerPrivateKey: ATTACKER_PRIVATE_KEY,
        issuedAt: FORGED_ISSUED_AT,
        delegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
        delegationExpiresAt: DELEGATION_EXPIRES_AT,
      },
    );
    const forgedPrepared = outputRecord(forgedPreparedEvent, 'forged setup');
    const forgedAnnouncement = outputRecordValue(
      forgedPrepared,
      'announcement',
      'forged setup',
    );
    const forgedHeadDigest = requiredString(
      forgedPrepared.attemptedCatalogHeadDigest,
      'forged.attemptedCatalogHeadDigest',
    );
    exact(
      requiredString(forgedPrepared.catalogAuthorAddress, 'forged.catalogAuthorAddress'),
      AUTHOR_ADDRESS,
      'forged claimed author',
    );
    exact(
      requiredString(forgedPrepared.recoveredAuthorAddress, 'forged.recoveredAuthorAddress'),
      ATTACKER_ADDRESS,
      'forged delegation recovered author',
    );
    const statsBeforeForged = await readReceiverStats(receiver, 'before-forged');
    await announceAndDrain(
      author,
      receiver,
      forgedAnnouncement,
      receiverReady.peerId as string,
      'forged',
    );
    const notFoundBeforeForged = requiredSafeInteger(
      statsBeforeForged.notFound,
      'statsBeforeForged.notFound',
    );
    const statsAfterForged = await readReceiverStatsWhen(
      receiver,
      'after-forged',
      (stats) => requiredSafeInteger(stats.notFound, 'statsAfterForged.notFound')
        === notFoundBeforeForged + 1,
    );
    exact(
      requiredSafeInteger(statsAfterForged.notFound, 'statsAfterForged.notFound'),
      notFoundBeforeForged + 1,
      'forged scope-closed provider refusal count',
    );
    exact(
      requiredSafeInteger(statsAfterForged.failed, 'statsAfterForged.failed'),
      requiredSafeInteger(statsBeforeForged.failed, 'statsBeforeForged.failed'),
      'forged refusal does not expose an authorization oracle',
    );
    const forgedScopeDigest = computeAuthorCatalogScopeDigestV1({
      networkId: NETWORK_ID,
      contextGraphId: FORGED_CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR_ADDRESS,
      era: '0',
      bucketCount: '1',
    } as never);
    const forgedApplied = await readAppliedNullable(
      receiver,
      forgedScopeDigest,
      AUTHOR_ADDRESS,
      'forged',
    );
    exact(forgedApplied, null, 'forged applied head');
    const forgedSync = await readSynchronizationNullable(receiver, forgedHeadDigest, 'forged');
    exact(forgedSync, null, 'forged synchronization evidence');
    const appliedAfterForged = await readApplied(
      receiver,
      catalogScopeDigest,
      AUTHOR_ADDRESS,
      'after-forged',
    );
    const semanticAfterForged = await readSynchronization(
      receiver,
      positive.head.catalogHeadDigest,
      'after-forged',
    );
    exactJson(appliedAfterForged, positiveApplied, 'positive applied state after forged attempt');
    exactJson(semanticAfterForged, positiveSync, 'positive semantic state after forged attempt');

    const receiverCrashExit = await receiver.killRestartBoundary('receiver-crash-v1');
    const restartedReceiver = spawnAgent(
      'receiver',
      receiverDataDir,
      children,
      storeFixture,
    );
    const restartedReady = await restartedReceiver.waitFor('ready');
    requireRealReady(restartedReady, 'receiver');
    exact(restartedReady.peerId, receiverReady.peerId, 'receiver peer ID after restart');
    await connectBothWays(author, restartedReceiver, authorReady, restartedReady, 'restart');
    await acceptPolicy(restartedReceiver, 'restarted-receiver-policy-v1', CONTEXT_GRAPH_ID);

    await announceAndDrain(
      author,
      restartedReceiver,
      positiveAnnouncement,
      restartedReady.peerId as string,
      'repair',
    );
    const repairApplied = await readApplied(
      restartedReceiver,
      catalogScopeDigest,
      AUTHOR_ADDRESS,
      'repair',
    );
    const replayedSynchronization = await readSynchronizationNullable(
      restartedReceiver,
      positive.head.catalogHeadDigest,
      'repair',
    );
    exact(
      replayedSynchronization,
      null,
      'already-applied replay process-local synchronization evidence',
    );
    const restartStats = await readReceiverStats(restartedReceiver, 'restart-replay');
    exact(
      requiredSafeInteger(restartStats.dedupedAlreadyApplied, 'restart dedupedAlreadyApplied'),
      1,
      'restart durable applied-head dedupe',
    );
    exact(
      requiredSafeInteger(restartStats.applied, 'restart applied'),
      0,
      'restart duplicate activation count',
    );
    const semanticAfterRestart = await readSemanticGraph(
      restartedReceiver,
      positive.swmGraph,
      'positive-after-restart',
    );
    exactJson(
      semanticAfterRestart,
      semanticBeforeCrash,
      'exact SWM state across SIGKILL/restart/reannouncement',
    );
    const repair = structuredClone(positive) as Gate1TransferEvidence;
    exactJson(repairApplied, appliedReadBackFromTransfer(repair), 'repair applied readback');

    const restartedReceiverExit = await restartedReceiver.stop('receiver-stop-v1');
    const authorExit = await author.stop('author-stop-v1');
    const headAfter = readCleanRepositoryHead(REPO_ROOT);
    exact(headAfter, headBefore, 'tracked source commit after process run');

    const failureCode = 'catalog-native-receiver-not-found';
    const forged: Gate1ForgedEvidence = Object.freeze({
      attemptedCatalogHeadDigest: forgedHeadDigest,
      catalogAuthorAddress: AUTHOR_ADDRESS,
      expectedFailureCode: failureCode,
      recoveredAuthorAddress: ATTACKER_ADDRESS,
    });

    const artifact = {
      adapter: {
        id: GATE1_REAL_DKG_AGENT_ADAPTER_ID,
        inspectedProductCommits: [headBefore],
        productBoundary: 'connected',
        protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
        requiredProductionOperations: REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
        replacementContract:
          'real DKGAgent production APIs only; no fixture adapter or synthesized product evidence',
      },
      fixture: {
        forged: structuredClone(forged),
        positive: structuredClone(positive),
        repairSuccessor: structuredClone(repair),
      },
      gate: 'OT-RFC-64 Gate 1 harness contract',
      gateEvaluation: {
        reason:
          'two real DKGAgent processes completed production publish, announce, synchronize, '
            + 'authorization-negative, SIGKILL, restart, reannounce, and exact readback',
        status: 'PASS',
      },
      harnessChecksPassed: true,
      invocation: 'pnpm test:gate1:rfc64-public-open-harness',
      phases: {
        forgedAuthor: {
          activationAfter: positive.activatedQuadCount,
          activationBefore: positive.activatedQuadCount,
          appliedHeadAfter: structuredClone(appliedAfterForged),
          appliedHeadBefore: structuredClone(positiveApplied),
          attemptedCatalogHeadDigest: forged.attemptedCatalogHeadDigest,
          failureCode: forged.expectedFailureCode,
          recoveredAuthorAddress: forged.recoveredAuthorAddress,
          servedByPeerId: authorReady.peerId,
          testedByPeerId: receiverReady.peerId,
        },
        positiveSync: {
          appliedReadBack: structuredClone(positiveApplied),
          controlObjectsVerified: positiveControlObjectCount,
          exact: structuredClone(positive),
          receivedByPeerId: receiverReady.peerId,
          semanticPostRead: semanticReadBackFromTransfer(positive),
          servedByPeerId: authorReady.peerId,
        },
        restartRepair: {
          crashExit: receiverCrashExit,
          gap: {
            appliedBeforeCrash: structuredClone(positiveApplied),
            repairIntentDurable: false,
            semanticBeforeCrash: semanticReadBackFromTransfer(positive),
            target: appliedReadBackFromTransfer(repair),
          },
          readBack: {
            appliedReadBack: repairApplied,
            semanticPostRead: semanticReadBackFromTransfer(repair),
          },
          reannouncementAcknowledgedByPeerId: restartedReady.peerId,
          restartedReady: selectReady(restartedReady),
          successorServedByPeerId: authorReady.peerId,
        },
      },
      processBoundary: {
        authorInstances: 1,
        model: 'two real DKGAgent peer processes plus one receiver restart',
        receiverInstances: 2,
        stoppedExits: {
          author: selectExit(authorExit),
          restartedReceiver: selectExit(restartedReceiverExit),
        },
      },
      ready: {
        author: selectReady(authorReady),
        receiver: selectReady(receiverReady),
      },
      repository: {
        testedHeadCommit: headBefore,
        trackedSourceCleanAfterProcesses: true,
        trackedSourceCleanBeforeSpawn: true,
      },
      schemaVersion: GATE1_RAW_SCHEMA_VERSION,
    };
    const publication = atomicWriteStableJson(rawArtifactPath, artifact);
    process.stdout.write(
      `[rfc64-gate1-harness] wrote ${rawArtifactPath} sha256=${publication.sha256}\n`,
    );
    operationFailed = false;
  } catch (error) {
    primaryFailure = error;
  } finally {
    await cleanupPreservingPrimaryFailure({
      operationFailed,
      primaryFailure,
      cleanup: () => children.terminateAllThenCleanup(
        () => cleanupRolloutStoreFixture(storeFixture, temporaryRoots),
      ),
      reportSecondaryFailure: (primary, secondary) => {
        process.stderr.write(
          `[rfc64-gate1-harness] cleanup failure after ${String(primary)}: ${String(secondary)}\n`,
        );
      },
    });
  }
}

async function publishSuccessor(
  author: Gate1AgentChild,
  input: {
    readonly requestId: string;
    readonly previousHead: Record<string, unknown>;
    readonly catalogIssuerAuthorization: Record<string, unknown>;
    readonly seal: CanonicalGraphScopedAuthorSealV1;
    readonly issuedAt: string;
  },
): Promise<Record<string, unknown>> {
  const event = await author.request('publishSuccessor', input.requestId, 'operation-completed', {
    previousHead: input.previousHead,
    authorPrivateKey: AUTHOR_PRIVATE_KEY,
    catalogIssuerAuthorization: input.catalogIssuerAuthorization,
    assertionCoordinate: 'gate-1-object',
    projectionNQuads: PROJECTION_NQUADS,
    seal: input.seal,
    deployment: DEPLOYMENT,
    issuedAt: input.issuedAt,
    peers: [],
  });
  return outputRecord(event, input.requestId);
}

async function announceAndDrain(
  author: Gate1AgentChild,
  receiver: Gate1AgentChild,
  announcement: Record<string, unknown>,
  receiverPeerId: string,
  label: string,
): Promise<void> {
  const announced = await author.request('announce', `${label}-announce-v1`, 'operation-completed', {
    announcement,
    peers: [receiverPeerId],
  });
  const output = outputRecord(announced, `${label} announce`);
  exactJson(output.announcedPeers, [receiverPeerId], `${label} announced peers`);
  exactJson(output.failedPeers, [], `${label} failed peers`);
  await receiver.request('awaitReceiverIdle', `${label}-receiver-idle-v1`, 'receiver-idle');
}

async function acceptPolicy(
  child: Gate1AgentChild,
  requestId: string,
  contextGraphId: string,
): Promise<Gate1AgentEvent> {
  return child.request('acceptOpenPolicy', requestId, 'operation-completed', {
    networkId: NETWORK_ID,
    contextGraphId,
    ownerAddress: AUTHOR_ADDRESS,
  });
}

async function connectBothWays(
  author: Gate1AgentChild,
  receiver: Gate1AgentChild,
  authorReady: Gate1AgentEvent,
  receiverReady: Gate1AgentEvent,
  label: string,
): Promise<void> {
  await Promise.all([
    receiver.request('dial', `${label}-receiver-dial-author-v1`, 'dialed', {
      multiaddr: authorReady.multiaddr,
      peerId: authorReady.peerId,
    }),
    author.request('dial', `${label}-author-dial-receiver-v1`, 'dialed', {
      multiaddr: receiverReady.multiaddr,
      peerId: receiverReady.peerId,
    }),
  ]);
}

async function readApplied(
  receiver: Gate1AgentChild,
  catalogScopeDigest: string,
  authorAddress: string,
  label: string,
): Promise<Gate1AppliedHeadReadBack> {
  const value = await readAppliedNullable(receiver, catalogScopeDigest, authorAddress, label);
  if (value === null) throw new Error(`${label} applied-head readback is missing`);
  return value;
}

async function readAppliedNullable(
  receiver: Gate1AgentChild,
  catalogScopeDigest: string,
  authorAddress: string,
  label: string,
): Promise<Gate1AppliedHeadReadBack | null> {
  const event = await receiver.request(
    'appliedHeadReadback',
    `${label}-applied-head-v1`,
    'operation-completed',
    { catalogScopeDigest, authorAddress },
  );
  if (event.output === null) return null;
  const output = outputRecord(event, `${label} applied head`);
  return Object.freeze({
    appliedInventoryDigest: requiredString(
      output.appliedInventoryDigest,
      `${label}.appliedInventoryDigest`,
    ),
    catalogVersion: requiredString(output.catalogVersion, `${label}.catalogVersion`),
    currentCatalogHeadDigest: requiredString(
      output.currentCatalogHeadDigest,
      `${label}.currentCatalogHeadDigest`,
    ),
    inventoryRowCount: decimalToSafeInteger(
      output.inventoryRowCount,
      `${label}.inventoryRowCount`,
    ),
  });
}

async function readSynchronization(
  receiver: Gate1AgentChild,
  catalogHeadDigest: string,
  label: string,
): Promise<Record<string, unknown>> {
  const value = await readSynchronizationNullable(receiver, catalogHeadDigest, label);
  if (value === null) throw new Error(`${label} synchronization evidence is missing`);
  return value;
}

async function readSynchronizationNullable(
  receiver: Gate1AgentChild,
  catalogHeadDigest: string,
  label: string,
): Promise<Record<string, unknown> | null> {
  const event = await receiver.request(
    'exactInventoryReadback',
    `${label}-exact-inventory-v1`,
    'operation-completed',
    { catalogHeadDigest },
  );
  return event.output === null ? null : outputRecord(event, `${label} synchronization`);
}

async function readReceiverStats(
  receiver: Gate1AgentChild,
  label: string,
): Promise<Record<string, unknown>> {
  return outputRecord(
    await receiver.request('receiverStats', `${label}-receiver-stats-v1`, 'operation-completed'),
    `${label} receiver stats`,
  );
}

async function readReceiverStatsWhen(
  receiver: Gate1AgentChild,
  label: string,
  predicate: (stats: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  let stats = await readReceiverStats(receiver, label);
  while (!predicate(stats) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await receiver.request(
      'awaitReceiverIdle',
      `${label}-settle-${Date.now()}`,
      'receiver-idle',
    );
    stats = await readReceiverStats(receiver, label);
  }
  return stats;
}

async function readSemanticGraph(
  receiver: Gate1AgentChild,
  swmGraph: string,
  label: string,
): Promise<Record<string, unknown>> {
  return outputRecord(
    await receiver.request(
      'semanticGraphReadback',
      `${label}-semantic-graph-v1`,
      'operation-completed',
      { swmGraph },
    ),
    `${label} semantic graph`,
  );
}

function transferEvidence(
  publication: Record<string, unknown>,
  synchronization: Record<string, unknown>,
  previousCatalogHeadDigest: string,
  label: string,
): Gate1TransferEvidence {
  const announcement = outputRecordValue(publication, 'announcement', `${label} publication`);
  const headDigest = requiredString(publication.headObjectDigest, `${label}.headObjectDigest`);
  exact(
    requiredString(announcement.catalogHeadObjectDigest, `${label}.announcement.headDigest`),
    headDigest,
    `${label} announcement head digest`,
  );
  exact(
    requiredString(synchronization.catalogHeadDigest, `${label}.sync.catalogHeadDigest`),
    headDigest,
    `${label} synchronized head digest`,
  );
  exact(
    requiredString(synchronization.catalogRowDigest, `${label}.sync.catalogRowDigest`),
    requiredString(publication.catalogRowDigest, `${label}.catalogRowDigest`),
    `${label} catalog row digest`,
  );
  exact(
    requiredString(synchronization.contentDigest, `${label}.sync.contentDigest`),
    requiredString(publication.contentDigest, `${label}.contentDigest`),
    `${label} content digest`,
  );
  exact(
    requiredString(synchronization.bundleDigest, `${label}.sync.bundleDigest`),
    requiredString(publication.bundleDigest, `${label}.bundleDigest`),
    `${label} bundle digest`,
  );
  exact(
    requiredString(synchronization.kaUal, `${label}.sync.kaUal`),
    requiredString(publication.kaUal, `${label}.kaUal`),
    `${label} KA UAL`,
  );
  const bundleByteLength = decimalToSafeInteger(
    publication.bundleByteLength,
    `${label}.bundleByteLength`,
  );
  exact(
    requiredSafeInteger(publication.stagedBundleByteLength, `${label}.stagedBundleByteLength`),
    bundleByteLength,
    `${label} staged bundle byte length`,
  );
  const inventoryRowCount = decimalToSafeInteger(
    publication.inventoryRowCount,
    `${label}.inventoryRowCount`,
  );
  exact(
    requiredSafeInteger(synchronization.inventoryRowCount, `${label}.sync.inventoryRowCount`),
    inventoryRowCount,
    `${label} synchronized inventory row count`,
  );
  return Object.freeze({
    activatedQuadCount: requiredSafeInteger(
      synchronization.activatedTripleCount,
      `${label}.activatedTripleCount`,
    ),
    authorAddress: requiredString(announcement.authorAddress, `${label}.authorAddress`),
    bundleByteLength,
    bundleDigest: requiredString(publication.bundleDigest, `${label}.bundleDigest`),
    catalogRowDigest: requiredString(publication.catalogRowDigest, `${label}.catalogRowDigest`),
    contentByteLength: decimalToSafeInteger(
      publication.contentByteLength,
      `${label}.contentByteLength`,
    ),
    contentDigest: requiredString(publication.contentDigest, `${label}.contentDigest`),
    head: Object.freeze({
      appliedInventoryDigest: requiredString(
        synchronization.inventoryDigest,
        `${label}.inventoryDigest`,
      ),
      catalogHeadDigest: headDigest,
      catalogVersion: requiredString(announcement.catalogVersion, `${label}.catalogVersion`),
      previousCatalogHeadDigest,
    }),
    inventoryRowCount,
    kaUal: requiredString(publication.kaUal, `${label}.kaUal`),
    swmGraph: requiredString(synchronization.swmGraph, `${label}.swmGraph`),
  });
}

function verifiedControlObjectCount(
  synchronization: Record<string, unknown>,
  label: string,
): number {
  return requiredSafeInteger(
    synchronization.verifiedControlObjectCount,
    `${label}.verifiedControlObjectCount`,
  );
}

function stagedHeadRef(output: Record<string, unknown>, label: string): Record<string, unknown> {
  return {
    objectDigest: requiredString(output.headObjectDigest, `${label}.headObjectDigest`),
    signatureVariantDigest: requiredString(
      output.signatureVariantDigest,
      `${label}.signatureVariantDigest`,
    ),
  };
}

function spawnAgent(
  role: 'author' | 'receiver',
  dataDir: string,
  registry: ChildProcessRegistry,
  storeFixture: RolloutStoreFixture,
): Gate1AgentChild {
  return new Gate1AgentChild({
    eventTimeoutMs: PROCESS_TIMEOUT_MS,
    registry,
    role,
    spawn: {
      command: process.execPath,
      args: ['--import', 'tsx', ADAPTER_PROCESS, role],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DKG_RFC64_GATE1_ADAPTER_DATA_DIR: dataDir,
        DKG_RFC64_GATE1_AGENT_MASTER_KEY_HEX: ROLE_MASTER_KEYS[role],
        ...storeFixture.envForRole(role, dataDir),
        NODE_ENV: 'production',
      },
    },
  });
}

function requireRealReady(event: Gate1AgentEvent, expectedRole: 'author' | 'receiver'): void {
  requireCondition(event.role === expectedRole, 'ready role differs from the spawned role');
  requireCondition(
    event.adapterId === GATE1_REAL_DKG_AGENT_ADAPTER_ID,
    'adapter did not identify the real DKGAgent boundary',
  );
  requireCondition(
    event.protocolVersion === GATE1_ADAPTER_PROTOCOL_VERSION,
    'adapter protocol version changed',
  );
  requireCondition(event.agentClass === 'DKGAgent', 'child did not boot a real DKGAgent');
  requireCondition(event.catalogServiceStarted === true, 'production catalog service did not start');
  requireCondition(event.startupRepair === null, 'adapter claimed nonexistent automatic startup repair');
  requireCondition(typeof event.peerId === 'string' && event.peerId.length > 0, 'peer ID is missing');
  requireCondition(
    typeof event.multiaddr === 'string' && event.multiaddr.includes('/tcp/'),
    'TCP multiaddr is missing',
  );
  requireCondition(
    event.capabilities !== null && typeof event.capabilities === 'object',
    'product capability report is missing',
  );
}

function selectReady(event: Gate1AgentEvent): Record<string, unknown> {
  return {
    adapterId: event.adapterId,
    peerId: event.peerId,
    protocolVersion: event.protocolVersion,
    role: event.role,
    startupRepair: event.startupRepair,
  };
}

function selectExit(exit: ProcessExitEvidence): Record<string, unknown> {
  return { code: exit.code, signal: exit.signal };
}

function outputRecord(event: Gate1AgentEvent, label: string): Record<string, unknown> {
  if (event.output === null || typeof event.output !== 'object' || Array.isArray(event.output)) {
    throw new Error(`${label} output is not an object`);
  }
  return event.output as Record<string, unknown>;
}

function outputRecordValue(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const value = record[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}.${key} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredOutputDigest(event: Gate1AgentEvent, key: string): string {
  const output = outputRecord(event, `${event.role}/${event.event}`);
  const value = requiredString(output[key], `${event.role}/${event.event}.${key}`);
  if (!/^0x[0-9a-f]{64}$/u.test(value)) throw new Error(`${key} is not a canonical digest`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function decimalToSafeInteger(value: unknown, label: string): number {
  const decimal = requiredString(value, label);
  if (!/^(0|[1-9][0-9]*)$/u.test(decimal)) throw new Error(`${label} is not canonical decimal`);
  const number = Number(decimal);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe integer range`);
  return number;
}

function exact(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label} differed: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

function exactJson(actual: unknown, expected: unknown, label: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label} differed from exact production evidence`);
  }
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await execute();
