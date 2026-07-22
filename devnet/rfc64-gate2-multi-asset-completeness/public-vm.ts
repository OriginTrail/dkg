import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  MemoryLayer,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  contextGraphLayerUri,
  contextGraphMetaUri,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import {
  atomicWriteExactBytes,
  readCleanRepositoryHead,
} from '../rfc64-persistence-lifecycle/evidence.js';
import {
  ChildProcessRegistry,
  cleanupPreservingPrimaryFailure,
} from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import { type Gate2AgentEvent } from './agent-child.js';
import { canonicalDocument, type CanonicalValue } from './src/canonical.ts';
import {
  assertGate2ExecutedRuntimeMatchesBuildV1,
  consumeGate2RuntimeLaunchReceiptV1,
  type Gate2ExecutedRuntimeManifestV1,
} from './runtime-provenance.ts';
import {
  assertGate2HarnessReadyV1,
  assertGate2HarnessSourceStateV1,
  connectGate2HarnessAgentsV1,
  createGate2TwoAgentDataDirsV1,
  spawnGate2HarnessAgentV1,
} from './two-agent-harness.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const DEFAULT_ARTIFACT = join(import.meta.dirname, 'artifacts/m2-public-vm-result.json');
const NETWORK_ID = 'otp:20430';
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/m2-public-vm-process';
const ON_CHAIN_CONTEXT_GRAPH_ID = '14';
const CG_STORAGE = '0x3333333333333333333333333333333333333333';
const KA_STORAGE = '0x4444444444444444444444444444444444444444';
const AUTHOR_PRIVATE_KEY = `0x${'64'.repeat(32)}`;
const AUTHOR_WALLET = new ethers.Wallet(AUTHOR_PRIVATE_KEY);
const AUTHOR_ADDRESS = AUTHOR_WALLET.address.toLowerCase();
const KA_NUMBER = 7n;
const KA_ID = ((BigInt(AUTHOR_ADDRESS) << 96n) | KA_NUMBER).toString();
const KA_UAL = `did:dkg:${NETWORK_ID}/${AUTHOR_ADDRESS}/${KA_NUMBER}`;
const ASSERTION_VERSION = '1';
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f';
const POLICY_DIGEST = `0x${'cd'.repeat(32)}`;
const PROJECTION_NQUADS =
  '<https://example.org/alice> <https://schema.org/age> '
    + '"42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
    + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KA_STORAGE,
});
const POLICY = Object.freeze({
  networkId: NETWORK_ID,
  contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: '20430',
  governanceContractAddress: CG_STORAGE,
  ownershipTransitionDigest: null,
  era: '0',
  version: '0',
  previousPolicyDigest: null,
  accessPolicy: 0,
  publishPolicy: 1,
  publishAuthority: null,
  publishAuthorityAccountId: '0',
  projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  administrativeDelegationDigest: null,
  source: {
    kind: 'finalized-chain',
    chainId: '20430',
    contractAddress: CG_STORAGE,
    blockNumber: '120',
    blockHash: `0x${'76'.repeat(32)}`,
  },
  effectiveAt: '1773900000000',
  issuedAt: '1773900000000',
});

await execute();

async function execute(): Promise<void> {
  const launchReceipt = consumeGate2RuntimeLaunchReceiptV1();
  const headBefore = assertGate2HarnessSourceStateV1(
    REPO_ROOT,
    launchReceipt.sourceCommit,
    launchReceipt.manifest,
  );
  const dataDirs = createGate2TwoAgentDataDirsV1('m2-public-vm');
  const children = new ChildProcessRegistry(20_000);
  let operationFailed = true;
  let primaryFailure: unknown;
  try {
    const author = spawnGate2HarnessAgentV1({
      role: 'author',
      dataDir: dataDirs.author,
      networkChainId: NETWORK_ID,
      registry: children,
      repoRoot: REPO_ROOT,
      runtimeManifestDigest: launchReceipt.manifest.manifestDigest,
      sourceCommit: headBefore,
    });
    const finalizedVmConfigJson = JSON.stringify({
      assertionRoot: ASSERTION_ROOT,
      assertionVersion: ASSERTION_VERSION,
      authorAddress: AUTHOR_ADDRESS,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaId: KA_ID,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase(),
      onChainContextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
    });
    const receiver = spawnGate2HarnessAgentV1({
      role: 'receiver',
      dataDir: dataDirs.receiver,
      finalizedVmConfigJson,
      networkChainId: NETWORK_ID,
      registry: children,
      repoRoot: REPO_ROOT,
      runtimeManifestDigest: launchReceipt.manifest.manifestDigest,
      sourceCommit: headBefore,
    });
    const [authorReady, receiverReady] = await Promise.all([
      author.waitFor('ready'),
      receiver.waitFor('ready'),
    ]);
    assertGate2HarnessReadyV1(authorReady, 'author', launchReceipt.manifest.manifestDigest);
    assertGate2HarnessReadyV1(receiverReady, 'receiver', launchReceipt.manifest.manifestDigest);
    exact(authorReady.finalizedVmRuntime, false, 'author finalized VM runtime');
    exact(receiverReady.finalizedVmRuntime, true, 'receiver finalized VM runtime');
    requireCondition(authorReady.peerId !== receiverReady.peerId, 'peer identities are distinct');
    requireCondition(
      authorReady.processId !== receiverReady.processId
        && authorReady.processId !== process.pid
        && receiverReady.processId !== process.pid,
      'author, receiver, and harness use distinct OS processes',
    );
    await connectGate2HarnessAgentsV1(author, receiver, authorReady, receiverReady, 'm2-public-vm');

    const acceptedSnapshot = { policy: POLICY, policyDigest: POLICY_DIGEST, roster: null };
    const [authorPolicy, receiverPolicy] = await Promise.all([
      author.request(
        'acceptPolicySnapshot',
        'author-finalized-policy-v1',
        'operation-completed',
        acceptedSnapshot,
      ),
      receiver.request(
        'acceptPolicySnapshot',
        'receiver-finalized-policy-v1',
        'operation-completed',
        acceptedSnapshot,
      ),
    ]);
    exact(outputRecord(authorPolicy, 'author policy').policyDigest, POLICY_DIGEST, 'author policy');
    exact(
      outputRecord(receiverPolicy, 'receiver policy').policyDigest,
      POLICY_DIGEST,
      'receiver policy',
    );

    const scope = Object.freeze({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: CG_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR_ADDRESS,
      era: '0',
      bucketCount: '1',
    });
    const genesis = outputRecord(await author.request(
      'publishCatalogGenesis',
      'm2-public-vm-genesis-v1',
      'operation-completed',
      {
        scope,
        authorPrivateKey: AUTHOR_PRIVATE_KEY,
        issuedAt: '1773900000000',
        catalogIssuerDelegationEffectiveAt: '1773899999000',
        catalogIssuerDelegationExpiresAt: '1774000000000',
      },
    ), 'genesis');
    await announceAndDrain(
      author,
      receiver,
      record(genesis.announcement, 'genesis announcement'),
      string(receiverReady.peerId, 'receiver peer id'),
      'genesis',
    );

    const successor = outputRecord(await author.request(
      'publishCatalogExactSetSuccessor',
      'm2-public-vm-successor-v1',
      'operation-completed',
      {
        previousHead: stagedHead(genesis, 'genesis'),
        authorPrivateKey: AUTHOR_PRIVATE_KEY,
        catalogIssuerAuthorization: record(
          genesis.catalogIssuerAuthorization,
          'genesis authorization',
        ),
        assets: [{
          assertionCoordinate: 'm2-public-vm-process-object',
          projectionNQuads: PROJECTION_NQUADS,
          seal: await authorSeal(),
        }],
        deployment: DEPLOYMENT,
        issuedAt: '1773900001000',
      },
    ), 'successor');
    const successorDigest = digest(successor.headObjectDigest, 'successor head');
    await announceAndDrain(
      author,
      receiver,
      record(successor.announcement, 'successor announcement'),
      string(receiverReady.peerId, 'receiver peer id'),
      'successor',
    );

    const scopeDigest = computeAuthorCatalogScopeDigestV1(scope as never);
    const applied = outputRecord(await receiver.request(
      'appliedHeadReadback',
      'm2-public-vm-applied-v1',
      'operation-completed',
      { catalogScopeDigest: scopeDigest, authorAddress: AUTHOR_ADDRESS },
    ), 'applied head');
    const terminalFailure = await receiver.request(
      'terminalFailureReadback',
      'm2-public-vm-failure-v1',
      'operation-completed',
      { catalogHeadDigest: successorDigest },
    );
    if (applied.currentCatalogHeadDigest !== successorDigest) {
      throw new Error(
        `durable applied head differs: ${JSON.stringify(applied.currentCatalogHeadDigest)}`
          + ` != ${JSON.stringify(successorDigest)}; terminal failure: `
          + `${JSON.stringify(terminalFailure.output)}\n`
          + receiver.diagnosticTail(),
      );
    }
    exact(applied.inventoryRowCount, '1', 'durable inventory row count');

    const synchronization = outputRecord(await receiver.request(
      'exactInventoryReadback',
      'm2-public-vm-inventory-v1',
      'operation-completed',
      { catalogHeadDigest: successorDigest },
    ), 'synchronization evidence');
    exact(synchronization.catalogHeadDigest, successorDigest, 'synchronized head');
    exact(synchronization.inventoryRowCount, 1, 'synchronized inventory row count');
    exact(synchronization.appliedHeadStatus, 'applied', 'synchronized applied status');

    const numericId = await receiver.request(
      'contextGraphOnChainIdReadback',
      'm2-public-vm-numeric-id-v1',
      'operation-completed',
      { contextGraphId: CONTEXT_GRAPH_ID },
    );
    exact(numericId.output, ON_CHAIN_CONTEXT_GRAPH_ID, 'event-derived numeric context graph id');

    const vmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      AUTHOR_ADDRESS,
      Number(KA_NUMBER),
    );
    const metaGraph = contextGraphMetaUri(CONTEXT_GRAPH_ID);
    const vm = outputRecord(await receiver.request(
      'vmGraphReadback',
      'm2-public-vm-readback-v1',
      'operation-completed',
      { vmGraph, metaGraph, ual: KA_UAL },
    ), 'VM readback');
    exact(vm.tripleCount, 2, 'VM triple count');
    exact(vm.projectionNQuads, PROJECTION_NQUADS, 'exact VM projection');
    const metadata = array(vm.metadataBindings, 'VM metadata').map((row, index) =>
      record(row, `VM metadata row ${index}`));
    metadataObject(metadata, 'status', '"confirmed"');
    metadataObject(
      metadata,
      'batchId',
      `"${KA_ID}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
    );
    metadataObject(metadata, 'materializedVersion', '"123:0"');
    requireCondition(
      metadata.every((row) => !string(row.p, 'metadata predicate').endsWith('transactionHash')),
      'finalized VM metadata contains no synthetic transaction hash',
    );

    exact(terminalFailure.output, null, 'receiver terminal failure');

    const [receiverBoundary, authorBoundary] = await Promise.all([
      receiver.stop('m2-public-vm-receiver-stop-v1'),
      author.stop('m2-public-vm-author-stop-v1'),
    ]);
    const receiverManifest = executedManifest(receiverBoundary.event, 'receiver');
    const authorManifest = executedManifest(authorBoundary.event, 'author');
    assertGate2ExecutedRuntimeMatchesBuildV1(authorManifest, launchReceipt.manifest);
    assertGate2ExecutedRuntimeMatchesBuildV1(receiverManifest, launchReceipt.manifest);
    const headAfter = assertGate2HarnessSourceStateV1(
      REPO_ROOT,
      headBefore,
      launchReceipt.manifest,
    );

    const artifact = Object.freeze({
      gate: 'OT-RFC-64 M2 public finalized VM separate-process proof',
      status: 'PASS',
      repository: { testedHeadCommit: headAfter, cleanBeforeAndAfter: true },
      processes: {
        harnessPid: process.pid,
        authorPid: authorReady.processId,
        receiverPid: receiverReady.processId,
        authorPeerId: authorReady.peerId,
        receiverPeerId: receiverReady.peerId,
      },
      policy: { digest: POLICY_DIGEST, source: 'finalized-chain' },
      chain: {
        numericContextGraphId: numericId.output,
        finalizedBlockNumber: '123',
        finalizedBlockHash: `0x${'77'.repeat(32)}`,
      },
      catalog: {
        headDigest: successorDigest,
        appliedInventoryDigest: applied.appliedInventoryDigest,
        inventoryRowCount: applied.inventoryRowCount,
      },
      verifiableMemory: {
        graph: vmGraph,
        tripleCount: vm.tripleCount,
        exactProjection: vm.projectionNQuads,
        metadataBindings: metadata,
      },
      runtimeBuildManifestDigest: launchReceipt.manifest.manifestDigest,
    });
    const artifactPath = process.env.DKG_RFC64_M2_PUBLIC_VM_ARTIFACT ?? DEFAULT_ARTIFACT;
    const publication = atomicWriteExactBytes(
      artifactPath,
      new TextEncoder().encode(canonicalDocument(artifact as unknown as CanonicalValue)),
    );
    process.stdout.write(
      `[rfc64-m2-public-vm] PASS artifact=${artifactPath} sha256=${publication.sha256}\n`,
    );
    operationFailed = false;
  } catch (error) {
    primaryFailure = error;
  } finally {
    await cleanupPreservingPrimaryFailure({
      operationFailed,
      primaryFailure,
      cleanup: () => children.terminateAllThenCleanup(() => {
        rmSync(dataDirs.author, { force: true, recursive: true });
        rmSync(dataDirs.receiver, { force: true, recursive: true });
      }),
      reportSecondaryFailure: (primary, secondary) => {
        process.stderr.write(
          `[rfc64-m2-public-vm] cleanup failure after ${String(primary)}: ${String(secondary)}\n`,
        );
      },
    });
  }
}

async function announceAndDrain(
  author: ReturnType<typeof spawnGate2HarnessAgentV1>,
  receiver: ReturnType<typeof spawnGate2HarnessAgentV1>,
  announcement: Record<string, unknown>,
  receiverPeerId: string,
  label: string,
): Promise<void> {
  const result = outputRecord(await author.request(
    'announce',
    `${label}-announce-v1`,
    'operation-completed',
    { announcement, peers: [receiverPeerId] },
  ), `${label} announce`);
  if (JSON.stringify(result.failedPeers) !== '[]') {
    throw new Error(
      `${label} failed peers differs: ${JSON.stringify(result.failedPeers)} != []\n`
        + receiver.diagnosticTail(),
    );
  }
  exactJson(result.announcedPeers, [receiverPeerId], `${label} announced peers`);
  await receiver.request(
    'awaitReceiverIdle',
    `${label}-receiver-idle-v1`,
    'receiver-idle',
  );
}

async function authorSeal(): Promise<CanonicalGraphScopedAuthorSealV1> {
  const typedData = buildAuthorAttestationTypedData({
    chainId: 20_430n,
    kav10Address: KA_STORAGE,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR_ADDRESS,
    reservedKaId: BigInt(KA_ID),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: AUTHOR_ADDRESS,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: '20430',
    assertedAtKav10Address: KA_STORAGE,
    reservedKaId: KA_ID,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: KA_UAL,
    assertionVersion: ASSERTION_VERSION,
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function stagedHead(output: Record<string, unknown>, label: string): Record<string, string> {
  return {
    objectDigest: digest(output.headObjectDigest, `${label} object digest`),
    signatureVariantDigest: digest(
      output.signatureVariantDigest,
      `${label} signature variant digest`,
    ),
  };
}

function metadataObject(
  rows: readonly Record<string, unknown>[],
  predicateSuffix: string,
  expectedObject: string,
): void {
  const matching = rows.filter((row) =>
    string(row.p, `metadata ${predicateSuffix} predicate`).endsWith(predicateSuffix));
  exact(matching.length, 1, `metadata ${predicateSuffix} row count`);
  exact(matching[0]!.o, expectedObject, `metadata ${predicateSuffix} object`);
}

function executedManifest(event: Gate2AgentEvent, label: string): Gate2ExecutedRuntimeManifestV1 {
  return record(
    event.executedRuntimeManifest,
    `${label} runtime manifest`,
  ) as unknown as Gate2ExecutedRuntimeManifestV1;
}

function outputRecord(event: Gate2AgentEvent, label: string): Record<string, unknown> {
  return record(event.output, `${label} output`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new Error(`${label} is not a bounded array`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new Error(`${label} is not a bounded string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const selected = string(value, label);
  if (!/^0x[0-9a-f]{64}$/u.test(selected)) throw new Error(`${label} is not a digest`);
  return selected;
}

function exact(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} differs: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

function exactJson(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} differs: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
  }
}

function requireCondition(condition: boolean, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
