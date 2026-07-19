import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import {
  atomicWriteExactBytes,
  readCleanRepositoryHead,
  stableJson,
} from '../rfc64-persistence-lifecycle/evidence.js';
import {
  ChildProcessRegistry,
  cleanupPreservingPrimaryFailure,
  type ProcessExitEvidence,
} from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import { Gate2AgentChild, type Gate2AgentEvent } from './agent-child.js';
import {
  GATE2_ADAPTER_PROTOCOL_VERSION,
  GATE2_RAW_SCHEMA_VERSION,
  GATE2_REAL_DKG_AGENT_ADAPTER_ID,
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  appliedReadBackFromInventories,
  type Gate2AppliedHeadReadBack,
  type Gate2AuthoredInventory,
  type Gate2ReceivedInventory,
  type Gate2SemanticReadBack,
} from './model.js';
import {
  GATE_EVALUATION,
  PRODUCT_BOUNDARY,
  RAW_SCHEMA_ID,
  type AssetRowV1,
  type CatalogScopeV1,
} from './src/schema.ts';
import { verify as verifyInventoryContract } from './src/verify.ts';
import { canonicalDocument, type CanonicalValue } from './src/canonical.ts';
import {
  assertGate2RuntimeManifestEqualV1,
  buildGate2RuntimeManifestV1,
  buildGate2RuntimeProvenanceV1,
  consumeGate2RuntimeLaunchReceiptV1,
  type Gate2ExecutedRuntimeManifestV1,
} from './runtime-provenance.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ADAPTER_PROCESS = join(import.meta.dirname, 'adapter-process.ts');
const RUNTIME_LOAD_HOOK = join(import.meta.dirname, 'runtime-load-hook.ts');
const DEFAULT_RAW_ARTIFACT = join(import.meta.dirname, 'artifacts/gate2-result.json');
const DEFAULT_VERDICT_ARTIFACT = join(import.meta.dirname, 'artifacts/gate2-verdict.json');
const PROCESS_TIMEOUT_MS = 90_000;

const NETWORK_ID = 'otp:20430';
const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/gate-2';
const FORGED_CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/gate-2-forged-authorization';
const AUTHOR_PRIVATE_KEY = `0x${'64'.repeat(32)}`;
const ATTACKER_PRIVATE_KEY = `0x${'65'.repeat(32)}`;
const AUTHOR_WALLET = new ethers.Wallet(AUTHOR_PRIVATE_KEY);
const AUTHOR_ADDRESS = AUTHOR_WALLET.address.toLowerCase();
const ATTACKER_ADDRESS = new ethers.Wallet(ATTACKER_PRIVATE_KEY).address.toLowerCase();
const KAV10_ADDRESS = '0x4444444444444444444444444444444444444444';
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10_ADDRESS,
});
const KA_NUMBERS = Object.freeze([7n, 8n, 9n]);
const ASSERTION_ROOTS = Object.freeze([
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
  '0x3f3c55f18e4bf87221b0f51de96594fc94496961cc7b71a1c6b9823ee10e1f30',
  '0xa3bae85ecbcd93e7673b01492a36c8104cab9d0f391a5dd9923dcc7e09a4b9b9',
]);
const PROJECTION_NQUADS = Object.freeze([
  '<https://example.org/alice> <https://schema.org/age> '
    + '"42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
    + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
  '<https://example.org/bob> <https://schema.org/age> '
    + '"43"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
    + '<https://example.org/bob> <https://schema.org/name> "Bob" .\n',
  '<https://example.org/carol> <https://schema.org/age> '
    + '"44"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
    + '<https://example.org/carol> <https://schema.org/name> "Carol" .\n',
]);
const GENESIS_ISSUED_AT = '1773900000000';
const SUCCESSOR_ISSUED_AT = Object.freeze([
  '1773900001000',
  '1773900002000',
  '1773900003000',
]);
const FORGED_ISSUED_AT = '1773900004000';
const DELEGATION_EFFECTIVE_AT = '1773899999000';
const DELEGATION_EXPIRES_AT = '1774000000000';
const ROLE_MASTER_KEYS = Object.freeze({
  author: '1a'.repeat(32),
  receiver: '2b'.repeat(32),
});

async function execute(): Promise<void> {
  const launchReceipt = consumeGate2RuntimeLaunchReceiptV1();
  const headBefore = readCleanRepositoryHead(REPO_ROOT);
  exact(headBefore, launchReceipt.sourceCommit, 'clean-build launch source commit');
  assertGate2RuntimeManifestEqualV1(
    buildGate2RuntimeManifestV1(REPO_ROOT, headBefore),
    launchReceipt.manifest,
  );
  exact(new Set(PROJECTION_NQUADS).size, 3, 'distinct per-KA projections before spawn');
  exact(new Set(ASSERTION_ROOTS).size, 3, 'distinct per-KA assertion roots before spawn');
  const rawArtifactPath = process.env.DKG_RFC64_GATE2_ARTIFACT ?? DEFAULT_RAW_ARTIFACT;
  const verdictArtifactPath = process.env.DKG_RFC64_GATE2_VERDICT_ARTIFACT
    ?? DEFAULT_VERDICT_ARTIFACT;
  rmSync(rawArtifactPath, { force: true });
  rmSync(verdictArtifactPath, { force: true });

  const authorDataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-gate2-author-'));
  const receiverDataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-gate2-receiver-'));
  const children = new ChildProcessRegistry(20_000);
  let operationFailed = true;
  let primaryFailure: unknown;
  try {
    const author = spawnAgent(
      'author', authorDataDir, children, launchReceipt.manifest.manifestDigest, headBefore,
    );
    const receiver = spawnAgent(
      'receiver', receiverDataDir, children, launchReceipt.manifest.manifestDigest, headBefore,
    );
    const [authorReady, receiverReady] = await Promise.all([
      author.waitFor('ready'),
      receiver.waitFor('ready'),
    ]);
    requireRealReady(authorReady, 'author', launchReceipt.manifest.manifestDigest);
    requireRealReady(receiverReady, 'receiver', launchReceipt.manifest.manifestDigest);
    requireCondition(authorReady.peerId !== receiverReady.peerId, 'peer identities are not distinct');
    await connectBothWays(author, receiver, authorReady, receiverReady, 'initial');

    const [authorPolicy, receiverPolicy] = await Promise.all([
      acceptPolicy(author, 'author-policy-v1', CONTEXT_GRAPH_ID),
      acceptPolicy(receiver, 'receiver-policy-v1', CONTEXT_GRAPH_ID),
    ]);
    const authorPolicyDigest = requiredOutputDigest(authorPolicy, 'policyDigest');
    const receiverPolicyDigest = requiredOutputDigest(receiverPolicy, 'policyDigest');
    exact(authorPolicyDigest, receiverPolicyDigest, 'independently accepted policy digests');
    assertGate2ProductCapabilities(authorReady.capabilities, 'author');
    assertGate2ProductCapabilities(receiverReady.capabilities, 'receiver');

    const genesis = outputRecord(await author.request(
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
    ), 'genesis');
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
      requiredString(receiverReady.peerId, 'receiver peer ID'),
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

    const catalogIssuerAuthorization = outputRecordValue(
      genesis,
      'catalogIssuerAuthorization',
      'genesis',
    );
    const allAssets = await Promise.all(KA_NUMBERS.map(async (kaNumber, index) => ({
      assertionCoordinate: `gate-2-object-${index + 1}`,
      projectionNQuads: PROJECTION_NQUADS[index]!,
      seal: await authorSeal(kaNumber, 2, ASSERTION_ROOTS[index]!),
    })));
    let previousHead = stagedHeadRef(genesis, 'genesis');
    let previousHeadDigest = requiredString(genesis.headObjectDigest, 'genesis.headObjectDigest');
    const transitions: Record<string, unknown>[] = [];
    let finalPublication: Record<string, unknown> | undefined;
    let finalSynchronization: Record<string, unknown> | undefined;
    for (let index = 0; index < allAssets.length; index += 1) {
      const liveSet = allAssets.slice(0, index + 1);
      const inputOrder = index === 2
        ? [liveSet[2]!, liveSet[0]!, liveSet[1]!]
        : [...liveSet].reverse();
      const publication = await publishExactSetSuccessor(author, {
        requestId: `publish-exact-set-${index + 1}-v1`,
        previousHead,
        catalogIssuerAuthorization,
        assets: inputOrder,
        issuedAt: SUCCESSOR_ISSUED_AT[index]!,
      });
      const announcement = outputRecordValue(
        publication,
        'announcement',
        `exact-set-${index + 1} publication`,
      );
      exact(
        requiredString(announcement.policyDigest, `exact-set-${index + 1}.policyDigest`),
        receiverPolicyDigest,
        `exact-set-${index + 1} policy digest`,
      );
      await announceAndDrain(
        author,
        receiver,
        announcement,
        requiredString(receiverReady.peerId, 'receiver peer ID'),
        `exact-set-${index + 1}`,
      );
      const headDigest = requiredDigest(
        publication.headObjectDigest,
        `exact-set-${index + 1}.headObjectDigest`,
      );
      let synchronization: Record<string, unknown> | undefined;
      if (index === 0) {
        const applied = await readApplied(
          receiver,
          catalogScopeDigest,
          AUTHOR_ADDRESS,
          'exact-set-1',
        );
        exact(applied.currentCatalogHeadDigest, headDigest, 'exact-set-1 durable head');
        exact(applied.catalogVersion, '1', 'exact-set-1 durable version');
        exact(applied.inventoryRowCount, 1, 'exact-set-1 durable row count');
      } else {
        synchronization = await readSynchronization(
          receiver,
          headDigest,
          `exact-set-${index + 1}`,
        );
        exact(
          requiredSafeInteger(
            synchronization.inventoryRowCount,
            `exact-set-${index + 1}.sync.inventoryRowCount`,
          ),
          index + 1,
          `exact-set-${index + 1} synchronized row count`,
        );
        exact(
          requiredString(
            synchronization.appliedHeadStatus,
            `exact-set-${index + 1}.sync.appliedHeadStatus`,
          ),
          'applied',
          `exact-set-${index + 1} applied status`,
        );
      }
      transitions.push(Object.freeze({
        catalogHeadDigest: headDigest,
        catalogVersion: requiredString(
          announcement.catalogVersion,
          `exact-set-${index + 1}.catalogVersion`,
        ),
        inventoryRowCount: index + 1,
        previousCatalogHeadDigest: previousHeadDigest,
        signatureVariantDigest: requiredDigest(
          publication.signatureVariantDigest,
          `exact-set-${index + 1}.signatureVariantDigest`,
        ),
      }));
      previousHead = stagedHeadRef(publication, `exact-set-${index + 1}`);
      previousHeadDigest = headDigest;
      finalPublication = publication;
      if (synchronization !== undefined) finalSynchronization = synchronization;
    }
    if (finalPublication === undefined || finalSynchronization === undefined) {
      throw new Error('Gate 2 produced no final three-row successor evidence');
    }

    const finalAnnouncement = outputRecordValue(
      finalPublication,
      'announcement',
      'final publication',
    );
    const authored = authoredInventoryFromPublication(finalPublication);
    const received = receivedInventoryFromSynchronization(finalSynchronization);
    exact(authored.catalogHeadDigest, received.catalogHeadDigest, 'authored/received head');
    exact(authored.declaredCatalogScopeDigest, catalogScopeDigest, 'product catalog scope digest');
    exact(
      verifiedControlObjectCount(finalSynchronization, 'final synchronization'),
      4,
      'final verified control-object count',
    );
    const contractVerdict = verifyInventoryContract({
      schema: RAW_SCHEMA_ID,
      productBoundary: PRODUCT_BOUNDARY,
      gateEvaluation: GATE_EVALUATION,
      authored,
      received,
    });
    exact(contractVerdict.fixtureComplete, true, 'reviewed exact-set evidence contract');
    const expectedApplied = appliedReadBackFromInventories(
      authored,
      received,
      requiredString(finalAnnouncement.catalogVersion, 'final catalog version'),
    );
    const positiveApplied = await readApplied(
      receiver,
      authored.declaredCatalogScopeDigest,
      AUTHOR_ADDRESS,
      'final-positive',
    );
    exactJson(positiveApplied, expectedApplied, 'final positive durable applied head');
    const semanticBeforeNegative = await readExactSemanticState(
      receiver,
      finalSynchronization,
      'before-negative',
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
    const forgedPrepared = outputRecord(await author.request(
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
    ), 'forged setup');
    const forgedAnnouncement = outputRecordValue(forgedPrepared, 'announcement', 'forged setup');
    const forgedHeadDigest = requiredDigest(
      forgedPrepared.attemptedCatalogHeadDigest,
      'forged.attemptedCatalogHeadDigest',
    );
    exact(forgedPrepared.catalogAuthorAddress, AUTHOR_ADDRESS, 'forged claimed author');
    exact(forgedPrepared.recoveredAuthorAddress, ATTACKER_ADDRESS, 'forged recovered author');
    const statsBeforeForged = await readReceiverStats(receiver, 'before-forged');
    await announceAndDrain(
      author,
      receiver,
      forgedAnnouncement,
      requiredString(receiverReady.peerId, 'receiver peer ID'),
      'forged',
    );
    const statsAfterForged = await readReceiverStats(receiver, 'after-forged');
    exact(
      requiredSafeInteger(statsAfterForged.failed, 'statsAfterForged.failed'),
      requiredSafeInteger(statsBeforeForged.failed, 'statsBeforeForged.failed') + 1,
      'forged terminal failure count',
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
      authored.declaredCatalogScopeDigest,
      AUTHOR_ADDRESS,
      'after-forged',
    );
    const inventoryAfterForged = await readSynchronization(
      receiver,
      authored.catalogHeadDigest,
      'after-forged',
    );
    exactJson(appliedAfterForged, positiveApplied, 'positive applied state after forged attempt');
    exactJson(
      inventoryAfterForged,
      finalSynchronization,
      'positive exact inventory after forged attempt',
    );
    const semanticAfterNegative = await readExactSemanticState(
      receiver,
      finalSynchronization,
      'after-negative',
    );
    exactJson(
      semanticAfterNegative,
      semanticBeforeNegative,
      'exact semantic state after forged attempt',
    );
    const terminalFailure = outputRecord(await receiver.request(
      'terminalFailureReadback',
      'forged-terminal-failure-v1',
      'operation-completed',
      { catalogHeadDigest: forgedHeadDigest },
    ), 'forged terminal failure');
    const failureCode = requiredString(terminalFailure.errorCode, 'terminalFailure.errorCode');
    requiredString(terminalFailure.errorName, 'terminalFailure.errorName');
    exact(
      requiredDigest(terminalFailure.catalogHeadDigest, 'terminalFailure.catalogHeadDigest'),
      forgedHeadDigest,
      'terminal failure head digest',
    );
    exact(failureCode, 'catalog-native-receiver-authorization', 'terminal failure code');

    const receiverCrashBoundary = await receiver.killRestartBoundary('receiver-crash-v1');
    const restartedReceiver = spawnAgent(
      'receiver', receiverDataDir, children, launchReceipt.manifest.manifestDigest, headBefore,
    );
    const restartedReady = await restartedReceiver.waitFor('ready');
    requireRealReady(restartedReady, 'receiver', launchReceipt.manifest.manifestDigest);
    exact(restartedReady.peerId, receiverReady.peerId, 'receiver peer ID after restart');
    await connectBothWays(author, restartedReceiver, authorReady, restartedReady, 'restart');
    await acceptPolicy(restartedReceiver, 'restarted-receiver-policy-v1', CONTEXT_GRAPH_ID);
    await announceAndDrain(
      author,
      restartedReceiver,
      finalAnnouncement,
      requiredString(restartedReady.peerId, 'restarted receiver peer ID'),
      'replay',
    );
    const replayApplied = await readApplied(
      restartedReceiver,
      authored.declaredCatalogScopeDigest,
      AUTHOR_ADDRESS,
      'replay',
    );
    const replayedSynchronization = await readSynchronizationNullable(
      restartedReceiver,
      authored.catalogHeadDigest,
      'replay',
    );
    exact(replayedSynchronization, null, 'already-applied replay process-local evidence');
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
    const semanticAfterRestart = await readExactSemanticState(
      restartedReceiver,
      finalSynchronization,
      'after-restart',
    );
    exactJson(
      semanticAfterRestart,
      semanticBeforeNegative,
      'exact three-row SWM state across SIGKILL/restart/reannouncement',
    );
    exactJson(replayApplied, expectedApplied, 'replay durable applied readback');

    const restartedReceiverBoundary = await restartedReceiver.stop('receiver-stop-v1');
    const authorBoundary = await author.stop('author-stop-v1');
    const headAfter = readCleanRepositoryHead(REPO_ROOT);
    exact(headAfter, headBefore, 'tracked source commit after process run');
    assertGate2RuntimeManifestEqualV1(
      buildGate2RuntimeManifestV1(REPO_ROOT, headAfter),
      launchReceipt.manifest,
    );
    const runtimeProvenance = buildGate2RuntimeProvenanceV1(
      launchReceipt.manifest,
      [
        {
          id: 'author',
          loaded: requiredExecutedRuntimeManifest(authorBoundary.event, 'author stop'),
        },
        {
          id: 'receiverBeforeCrash',
          loaded: requiredExecutedRuntimeManifest(
            receiverCrashBoundary.event,
            'receiver pre-SIGKILL',
          ),
        },
        {
          id: 'receiverAfterRestart',
          loaded: requiredExecutedRuntimeManifest(
            restartedReceiverBoundary.event,
            'restarted receiver stop',
          ),
        },
      ],
    );

    const artifact = {
      adapter: {
        id: GATE2_REAL_DKG_AGENT_ADAPTER_ID,
        inspectedProductCommits: [headBefore],
        productBoundary: 'connected',
        protocolVersion: GATE2_ADAPTER_PROTOCOL_VERSION,
        runtimeBuildManifestDigest: launchReceipt.manifest.manifestDigest,
        requiredProductionOperations: REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
        replacementContract:
          'real DKGAgent production APIs only; no fixture adapter or synthesized product evidence',
      },
      authorizationNegative: {
        attemptedCatalogHeadDigest: forgedHeadDigest,
        catalogAuthorAddress: AUTHOR_ADDRESS,
        expectedFailureCode: failureCode,
        forgedAppliedHead: forgedApplied,
        forgedSynchronization: forgedSync,
        positiveAppliedAfter: structuredClone(appliedAfterForged),
        positiveAppliedBefore: structuredClone(positiveApplied),
        positiveInventoryAfter: structuredClone(inventoryAfterForged),
        positiveInventoryBefore: structuredClone(finalSynchronization),
        recoveredAuthorAddress: ATTACKER_ADDRESS,
        semanticAfter: structuredClone(semanticAfterNegative),
        semanticBefore: structuredClone(semanticBeforeNegative),
        servedByPeerId: authorReady.peerId,
        testedByPeerId: receiverReady.peerId,
      },
      gate: 'OT-RFC-64 Gate 2 multi-asset completeness',
      gateEvaluation: {
        reason:
          'two real DKGAgent processes completed production 1-to-2-to-3 exact-set publication, '
            + 'synchronization, authorization-negative, SIGKILL, same-head replay, and exact readback',
        status: 'PASS',
      },
      harnessChecksPassed: true,
      inventory: {
        authored: structuredClone(authored),
        received: structuredClone(received),
      },
      invocation: 'pnpm test:gate2:rfc64-multi-asset-harness',
      policy: {
        authorPolicyDigest,
        contextGraphId: CONTEXT_GRAPH_ID,
        networkId: NETWORK_ID,
        receiverPolicyDigest,
      },
      processBoundary: {
        authorInstances: 1,
        model: 'two real DKGAgent peer processes plus one receiver restart',
        receiverInstances: 2,
        stoppedExits: {
          author: selectExit(authorBoundary.exit),
          restartedReceiver: selectExit(restartedReceiverBoundary.exit),
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
      restartReplay: {
        appliedReadBack: structuredClone(replayApplied),
        crashExit: receiverCrashBoundary.exit,
        processLocalSynchronization: replayedSynchronization,
        reannouncementAcknowledgedByPeerId: restartedReady.peerId,
        receiverStats: {
          applied: requiredSafeInteger(restartStats.applied, 'restart stats applied'),
          dedupedAlreadyApplied: requiredSafeInteger(
            restartStats.dedupedAlreadyApplied,
            'restart stats dedupedAlreadyApplied',
          ),
        },
        restartedReady: selectReady(restartedReady),
        semanticPostRead: structuredClone(semanticAfterRestart),
        successorServedByPeerId: authorReady.peerId,
      },
      schemaVersion: GATE2_RAW_SCHEMA_VERSION,
      runtimeProvenance: structuredClone(runtimeProvenance),
      transitions: structuredClone(transitions),
      transport: {
        finalAnnouncementPolicyDigest: requiredDigest(
          finalAnnouncement.policyDigest,
          'final announcement policy digest',
        ),
        finalSignatureVariantDigest: requiredDigest(
          finalPublication.signatureVariantDigest,
          'final signature variant digest',
        ),
        receivedByPeerId: receiverReady.peerId,
        servedByPeerId: authorReady.peerId,
        verifiedControlObjectCount: verifiedControlObjectCount(
          finalSynchronization,
          'final synchronization',
        ),
      },
    };
    const publication = atomicWriteExactBytes(
      rawArtifactPath,
      new TextEncoder().encode(canonicalDocument(artifact as unknown as CanonicalValue)),
    );
    process.stdout.write(
      `[rfc64-gate2-harness] wrote ${rawArtifactPath} sha256=${publication.sha256}\n`,
    );
    operationFailed = false;
  } catch (error) {
    primaryFailure = error;
  } finally {
    await cleanupPreservingPrimaryFailure({
      operationFailed,
      primaryFailure,
      cleanup: () => children.terminateAllThenCleanup(() => {
        rmSync(authorDataDir, { force: true, recursive: true });
        rmSync(receiverDataDir, { force: true, recursive: true });
      }),
      reportSecondaryFailure: (primary, secondary) => {
        process.stderr.write(
          `[rfc64-gate2-harness] cleanup failure after ${String(primary)}: ${String(secondary)}\n`,
        );
      },
    });
  }
}

async function publishExactSetSuccessor(
  author: Gate2AgentChild,
  input: {
    readonly requestId: string;
    readonly previousHead: Record<string, unknown>;
    readonly catalogIssuerAuthorization: Record<string, unknown>;
    readonly assets: readonly Record<string, unknown>[];
    readonly issuedAt: string;
  },
): Promise<Record<string, unknown>> {
  const event = await author.request(
    'publishExactSetSuccessor',
    input.requestId,
    'operation-completed',
    {
      previousHead: input.previousHead,
      authorPrivateKey: AUTHOR_PRIVATE_KEY,
      catalogIssuerAuthorization: input.catalogIssuerAuthorization,
      assets: input.assets,
      deployment: DEPLOYMENT,
      issuedAt: input.issuedAt,
      peers: [],
    },
  );
  return outputRecord(event, input.requestId);
}

async function announceAndDrain(
  author: Gate2AgentChild,
  receiver: Gate2AgentChild,
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
  child: Gate2AgentChild,
  requestId: string,
  contextGraphId: string,
): Promise<Gate2AgentEvent> {
  return child.request('acceptOpenPolicy', requestId, 'operation-completed', {
    networkId: NETWORK_ID,
    contextGraphId,
    ownerAddress: AUTHOR_ADDRESS,
  });
}

async function connectBothWays(
  author: Gate2AgentChild,
  receiver: Gate2AgentChild,
  authorReady: Gate2AgentEvent,
  receiverReady: Gate2AgentEvent,
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
  receiver: Gate2AgentChild,
  catalogScopeDigest: string,
  authorAddress: string,
  label: string,
): Promise<Gate2AppliedHeadReadBack> {
  const value = await readAppliedNullable(receiver, catalogScopeDigest, authorAddress, label);
  if (value === null) throw new Error(`${label} applied-head readback is missing`);
  return value;
}

async function readAppliedNullable(
  receiver: Gate2AgentChild,
  catalogScopeDigest: string,
  authorAddress: string,
  label: string,
): Promise<Gate2AppliedHeadReadBack | null> {
  const event = await receiver.request(
    'appliedHeadReadback',
    `${label}-applied-head-v1`,
    'operation-completed',
    { catalogScopeDigest, authorAddress },
  );
  if (event.output === null) return null;
  const output = outputRecord(event, `${label} applied head`);
  return Object.freeze({
    appliedInventoryDigest: requiredDigest(
      output.appliedInventoryDigest,
      `${label}.appliedInventoryDigest`,
    ),
    catalogVersion: requiredDecimal(output.catalogVersion, `${label}.catalogVersion`),
    currentCatalogHeadDigest: requiredDigest(
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
  receiver: Gate2AgentChild,
  catalogHeadDigest: string,
  label: string,
): Promise<Record<string, unknown>> {
  const value = await readSynchronizationNullable(receiver, catalogHeadDigest, label);
  if (value === null) throw new Error(`${label} synchronization evidence is missing`);
  return value;
}

async function readSynchronizationNullable(
  receiver: Gate2AgentChild,
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
  receiver: Gate2AgentChild,
  label: string,
): Promise<Record<string, unknown>> {
  return outputRecord(
    await receiver.request('receiverStats', `${label}-receiver-stats-v1`, 'operation-completed'),
    `${label} receiver stats`,
  );
}

async function readSemanticGraph(
  receiver: Gate2AgentChild,
  swmGraph: string,
  label: string,
): Promise<Gate2SemanticReadBack> {
  const output = outputRecord(await receiver.request(
    'semanticGraphReadback',
    `${label}-semantic-graph-v1`,
    'operation-completed',
    { swmGraph },
  ), `${label} semantic graph`);
  return Object.freeze({
    activatedQuadCount: requiredSafeInteger(
      output.activatedQuadCount,
      `${label}.activatedQuadCount`,
    ),
    projectionNQuads: requiredString(output.projectionNQuads, `${label}.projectionNQuads`),
    swmGraph: requiredString(output.swmGraph, `${label}.swmGraph`),
  });
}

async function readExactSemanticState(
  receiver: Gate2AgentChild,
  synchronization: Record<string, unknown>,
  label: string,
): Promise<readonly Record<string, unknown>[]> {
  const rows = plainArray(synchronization.rows, `${label}.rows`).map((value, index) =>
    outputRecordValue({ row: value }, 'row', `${label}.rows[${index}]`));
  const result: Record<string, unknown>[] = [];
  for (const [index, row] of rows.entries()) {
    const kaUal = requiredString(row.kaUal, `${label}.rows[${index}].kaUal`);
    const kaNumber = Number(kaUal.slice(kaUal.lastIndexOf('/') + 1));
    const expectedIndex = KA_NUMBERS.findIndex((candidate) => candidate === BigInt(kaNumber));
    if (expectedIndex < 0) throw new Error(`${label} row UAL is outside the exact Gate 2 set`);
    const readBack = await readSemanticGraph(
      receiver,
      requiredString(row.swmGraph, `${label}.rows[${index}].swmGraph`),
      `${label}-${index}`,
    );
    exact(
      readBack.activatedQuadCount,
      requiredSafeInteger(row.activatedTripleCount, `${label}.rows[${index}].tripleCount`),
      `${label} semantic triple count ${index}`,
    );
    exact(
      readBack.projectionNQuads,
      PROJECTION_NQUADS[expectedIndex],
      `${label} semantic projection ${index}`,
    );
    result.push(Object.freeze({
      kaId: requiredDecimal(row.kaId, `${label}.rows[${index}].kaId`),
      readBack,
    }));
  }
  return Object.freeze(result);
}

function authoredInventoryFromPublication(
  publication: Record<string, unknown>,
): Gate2AuthoredInventory {
  const scope = outputRecordValue(publication, 'catalogScope', 'publication');
  exact(scope.bucketCount, '1', 'catalog scope bucketCount');
  exact(scope.subGraphName, null, 'catalog scope subGraphName');
  const catalogScope = Object.freeze({
    networkId: requiredString(scope.networkId, 'catalogScope.networkId'),
    contextGraphId: requiredString(scope.contextGraphId, 'catalogScope.contextGraphId'),
    governanceChainId: nullableString(scope.governanceChainId, 'catalogScope.governanceChainId'),
    governanceContractAddress: nullableString(
      scope.governanceContractAddress,
      'catalogScope.governanceContractAddress',
    ),
    ownershipTransitionDigest: nullableString(
      scope.ownershipTransitionDigest,
      'catalogScope.ownershipTransitionDigest',
    ),
    subGraphName: null,
    authorAddress: requiredString(scope.authorAddress, 'catalogScope.authorAddress'),
    era: requiredDecimal(scope.era, 'catalogScope.era'),
    bucketCount: '1',
  }) satisfies CatalogScopeV1;
  const signedRows = Object.freeze(plainArray(publication.assets, 'publication.assets').map(
    (value, index) => {
      const asset = outputRecordValue({ asset: value }, 'asset', `publication.assets[${index}]`);
      exact(
        requiredSafeInteger(
          asset.stagedBundleByteLength,
          `publication.assets[${index}].stagedBundleByteLength`,
        ),
        decimalToSafeInteger(
          asset.bundleByteLength,
          `publication.assets[${index}].bundleByteLength`,
        ),
        `publication.assets[${index}] durable bundle byte length`,
      );
      decimalToSafeInteger(
        asset.contentByteLength,
        `publication.assets[${index}].contentByteLength`,
      );
      return assetRow(asset, `publication.assets[${index}]`);
    },
  ));
  return Object.freeze({
    catalogScope,
    declaredCatalogScopeDigest: requiredDigest(
      publication.catalogScopeDigest,
      'publication.catalogScopeDigest',
    ),
    catalogHeadDigest: requiredDigest(publication.headObjectDigest, 'publication.headObjectDigest'),
    catalogHeadTotalRows: requiredDecimal(
      publication.inventoryRowCount,
      'publication.inventoryRowCount',
    ),
    signedBucketRowCount: requiredDecimal(
      publication.signedBucketRowCount,
      'publication.signedBucketRowCount',
    ),
    signedRows,
  });
}

function receivedInventoryFromSynchronization(
  synchronization: Record<string, unknown>,
): Gate2ReceivedInventory {
  const activatedRows = Object.freeze(plainArray(
    synchronization.rows,
    'synchronization.rows',
  ).map((value, index) => assetRow(
    outputRecordValue({ row: value }, 'row', `synchronization.rows[${index}]`),
    `synchronization.rows[${index}]`,
  )));
  const inventoryRowCount = requiredSafeInteger(
    synchronization.inventoryRowCount,
    'synchronization.inventoryRowCount',
  );
  exact(inventoryRowCount, activatedRows.length, 'synchronization row count');
  exact(
    requiredSafeInteger(
      synchronization.activatedTripleCount,
      'synchronization.activatedTripleCount',
    ),
    activatedRows.reduce((total, row) => total + row.activatedTripleCount, 0),
    'synchronization total triple count',
  );
  return Object.freeze({
    catalogHeadDigest: requiredDigest(
      synchronization.catalogHeadDigest,
      'synchronization.catalogHeadDigest',
    ),
    declaredInventoryDigest: requiredDigest(
      synchronization.inventoryDigest,
      'synchronization.inventoryDigest',
    ),
    inventoryRowCount,
    activatedRows,
  });
}

function assetRow(value: Record<string, unknown>, label: string): AssetRowV1 {
  return Object.freeze({
    kaId: requiredDecimal(value.kaId, `${label}.kaId`),
    catalogRowDigest: requiredDigest(value.catalogRowDigest, `${label}.catalogRowDigest`),
    contentDigest: requiredDigest(value.contentDigest, `${label}.contentDigest`),
    sealDigest: requiredDigest(value.sealDigest, `${label}.sealDigest`),
    bundleDigest: requiredDigest(value.bundleDigest, `${label}.bundleDigest`),
    kaUal: requiredString(value.kaUal, `${label}.kaUal`),
    activatedTripleCount: requiredSafeInteger(
      value.activatedTripleCount,
      `${label}.activatedTripleCount`,
    ),
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

async function authorSeal(
  kaNumber: bigint,
  publicTripleCount: number,
  assertionRoot: string,
): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR_ADDRESS) << 96n) | kaNumber).toString();
  const kaUal = `did:dkg:${NETWORK_ID}/${AUTHOR_ADDRESS}/${kaNumber}`;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(assertionRoot),
    authorAddress: AUTHOR_ADDRESS,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: assertionRoot,
    authorAddress: AUTHOR_ADDRESS,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10_ADDRESS,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal,
    assertionVersion: '1',
    publicTripleCount: publicTripleCount.toString(),
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function stagedHeadRef(output: Record<string, unknown>, label: string): Record<string, unknown> {
  return {
    objectDigest: requiredDigest(output.headObjectDigest, `${label}.headObjectDigest`),
    signatureVariantDigest: requiredDigest(
      output.signatureVariantDigest,
      `${label}.signatureVariantDigest`,
    ),
  };
}

function spawnAgent(
  role: 'author' | 'receiver',
  dataDir: string,
  registry: ChildProcessRegistry,
  runtimeManifestDigest: string,
  sourceCommit: string,
): Gate2AgentChild {
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_PATH;
  delete childEnv.TSX_TSCONFIG_PATH;
  return new Gate2AgentChild({
    eventTimeoutMs: PROCESS_TIMEOUT_MS,
    registry,
    role,
    spawn: {
      command: process.execPath,
      args: ['--import', 'tsx', '--import', RUNTIME_LOAD_HOOK, ADAPTER_PROCESS, role],
      cwd: REPO_ROOT,
      env: {
        ...childEnv,
        DKG_RFC64_GATE2_ADAPTER_DATA_DIR: dataDir,
        DKG_RFC64_GATE2_AGENT_MASTER_KEY_HEX: ROLE_MASTER_KEYS[role],
        DKG_RFC64_GATE2_RUNTIME_MANIFEST_DIGEST: runtimeManifestDigest,
        DKG_RFC64_GATE2_RUNTIME_SOURCE_COMMIT: sourceCommit,
        NODE_ENV: 'production',
      },
    },
  });
}

function requireRealReady(
  event: Gate2AgentEvent,
  expectedRole: 'author' | 'receiver',
  runtimeManifestDigest: string,
): void {
  requireCondition(event.role === expectedRole, 'ready role differs from the spawned role');
  requireCondition(
    event.adapterId === GATE2_REAL_DKG_AGENT_ADAPTER_ID,
    'adapter did not identify the real DKGAgent boundary',
  );
  requireCondition(
    event.protocolVersion === GATE2_ADAPTER_PROTOCOL_VERSION,
    'adapter protocol version changed',
  );
  requireCondition(event.agentClass === 'DKGAgent', 'child did not boot a real DKGAgent');
  requireCondition(event.catalogServiceStarted === true, 'production catalog service did not start');
  requireCondition(event.startupRepair === null, 'adapter claimed nonexistent automatic startup repair');
  exact(event.runtimeBuildManifestDigest, runtimeManifestDigest, 'child runtime build manifest digest');
  requireCondition(typeof event.peerId === 'string' && event.peerId.length > 0, 'peer ID is missing');
  requireCondition(
    typeof event.multiaddr === 'string' && event.multiaddr.includes('/tcp/'),
    'TCP multiaddr is missing',
  );
}

function assertGate2ProductCapabilities(value: unknown, role: string): void {
  const capabilities = outputRecordValue({ capabilities: value }, 'capabilities', role);
  for (const name of [
    'acceptOpenPolicy',
    'announce',
    'appliedHeadReadback',
    'exactInventoryReadback',
    'publishExactSetSuccessor',
    'publishGenesis',
    'terminalFailureReadback',
  ]) {
    exact(capabilities[name], true, `${role} capability ${name}`);
  }
}

function selectReady(event: Gate2AgentEvent): Record<string, unknown> {
  return {
    adapterId: event.adapterId,
    peerId: event.peerId,
    protocolVersion: event.protocolVersion,
    role: event.role,
    runtimeBuildManifestDigest: event.runtimeBuildManifestDigest,
    startupRepair: event.startupRepair,
  };
}

function requiredExecutedRuntimeManifest(
  event: Gate2AgentEvent,
  label: string,
): Gate2ExecutedRuntimeManifestV1 {
  if (
    event.executedRuntimeManifest === null
    || typeof event.executedRuntimeManifest !== 'object'
    || Array.isArray(event.executedRuntimeManifest)
  ) {
    throw new Error(`${label} omitted its executed runtime manifest`);
  }
  return event.executedRuntimeManifest as Gate2ExecutedRuntimeManifestV1;
}

function selectExit(exit: ProcessExitEvidence): Record<string, unknown> {
  return { code: exit.code, signal: exit.signal };
}

function outputRecord(event: Gate2AgentEvent, label: string): Record<string, unknown> {
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

function plainArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new Error(`${label} is not a bounded Array`);
  }
  return value;
}

function requiredOutputDigest(event: Gate2AgentEvent, key: string): string {
  return requiredDigest(outputRecord(event, `${event.role}/${event.event}`)[key], key);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^0x[0-9a-f]{64}$/u.test(digest)) throw new Error(`${label} is not a canonical digest`);
  return digest;
}

function requiredDecimal(value: unknown, label: string): string {
  const decimal = requiredString(value, label);
  if (!/^(0|[1-9][0-9]*)$/u.test(decimal)) throw new Error(`${label} is not canonical decimal`);
  return decimal;
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function decimalToSafeInteger(value: unknown, label: string): number {
  const number = Number(requiredDecimal(value, label));
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
