import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  MemoryLayer,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeContextGraphPolicyObjectDigestV1,
  contextGraphLayerUri,
  contextGraphMetaUri,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type DecimalU64V1,
  type DecimalU256V1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterV1,
  type NetworkIdV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import { atomicWriteExactBytes } from '../rfc64-persistence-lifecycle/evidence.js';
import {
  ChildProcessRegistry,
  cleanupPreservingPrimaryFailure,
} from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import { type Gate2AgentChild, type Gate2AgentEvent } from
  '../rfc64-gate2-multi-asset-completeness/agent-child.js';
import { canonicalDocument, type CanonicalValue } from
  '../rfc64-gate2-multi-asset-completeness/src/canonical.ts';
import { consumeGate2RuntimeLaunchReceiptV1 } from
  '../rfc64-gate2-multi-asset-completeness/runtime-provenance.ts';
import {
  assertGate2HarnessReadyV1,
  assertGate2HarnessSourceStateV1,
  connectGate2HarnessAgentsV1,
  createGate2TwoAgentDataDirsV1,
  spawnGate2HarnessAgentV1,
} from '../rfc64-gate2-multi-asset-completeness/two-agent-harness.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ARTIFACT = process.env.DKG_RFC64_PRIVATE_CP2_ARTIFACT
  ?? join(import.meta.dirname, 'artifacts/cp2-private-swm-vm-recovery.json');
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CHAIN_ID = '20430' as DecimalU256V1;
const ZERO_U64 = '0' as DecimalU64V1;
const ZERO_U256 = '0' as DecimalU256V1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/cp2-private-swm-vm' as ContextGraphIdV1;
const ON_CHAIN_CONTEXT_GRAPH_ID = '14';
const CG_STORAGE = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const RECEIVER_WALLET = new ethers.Wallet(`0x${'65'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const RECEIVER = RECEIVER_WALLET.address.toLowerCase() as EvmAddressV1;
const ASSET_COUNT = 32;
const FIRST_KA_NUMBER = 1_000n;
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
const PROJECTION_NQUADS =
  '<https://example.org/alice> <https://schema.org/age> '
  + '"42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: CHAIN_ID,
  assertedAtKav10Address: KAV10,
});
const POLICY = privateRegisteredPolicy();
const POLICY_DIGEST = computeContextGraphPolicyObjectDigestV1(
  unsignedPolicyEnvelope(POLICY),
);
const ROSTER = privateRoster(POLICY_DIGEST);

await execute();

async function execute(): Promise<void> {
  const launch = consumeGate2RuntimeLaunchReceiptV1();
  const head = assertGate2HarnessSourceStateV1(
    REPO_ROOT,
    launch.sourceCommit,
    launch.manifest,
  );
  rmSync(ARTIFACT, { force: true });
  const dataDirs = createGate2TwoAgentDataDirsV1('cp2-private');
  const registry = new ChildProcessRegistry(20_000);
  let primaryFailure: unknown;
  let operationFailed = true;
  try {
    const author = spawnGate2HarnessAgentV1({
      role: 'author',
      catalogLocalAgentAddress: AUTHOR,
      dataDir: dataDirs.author,
      networkChainId: NETWORK_ID,
      registry,
      repoRoot: REPO_ROOT,
      runtimeManifestDigest: launch.manifest.manifestDigest,
      sourceCommit: head,
    });
    const assets = await Promise.all(Array.from({ length: ASSET_COUNT }, async (_, index) => {
      const kaNumber = FIRST_KA_NUMBER + BigInt(index);
      const seal = await authorSeal(kaNumber);
      return Object.freeze({
        assertionCoordinate: `cp2-private-asset-${String(index).padStart(2, '0')}`,
        projectionNQuads: PROJECTION_NQUADS,
        seal,
      });
    }));
    const finalizedVmConfigJson = JSON.stringify({
      accessPolicy: 1,
      assets: assets.map(({ seal }) => ({
        assertionRoot: seal.assertionMerkleRoot,
        assertionVersion: seal.assertionVersion,
        authorAddress: seal.authorAddress,
        kaId: seal.reservedKaId,
      })),
      contextGraphId: CONTEXT_GRAPH_ID,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase(),
      onChainContextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
    });
    const receiver = spawnGate2HarnessAgentV1({
      role: 'receiver',
      catalogLocalAgentAddress: RECEIVER,
      dataDir: dataDirs.receiver,
      finalizedVmConfigJson,
      networkChainId: NETWORK_ID,
      registry,
      repoRoot: REPO_ROOT,
      runtimeManifestDigest: launch.manifest.manifestDigest,
      sourceCommit: head,
    });
    const [authorReady, receiverReady] = await Promise.all([
      author.waitFor('ready'),
      receiver.waitFor('ready'),
    ]);
    assertGate2HarnessReadyV1(authorReady, 'author', launch.manifest.manifestDigest);
    assertGate2HarnessReadyV1(receiverReady, 'receiver', launch.manifest.manifestDigest);
    exact(authorReady.finalizedVmRuntime, false, 'author finalized VM runtime');
    exact(receiverReady.finalizedVmRuntime, true, 'receiver finalized VM runtime');
    const authorPeerId = requiredString(authorReady.peerId, 'author peer ID');
    const receiverPeerId = requiredString(receiverReady.peerId, 'receiver peer ID');
    if (authorPeerId === receiverPeerId) throw new Error('private canary peer IDs are equal');
    await connectGate2HarnessAgentsV1(author, receiver, authorReady, receiverReady, 'cp2-private');

    await Promise.all([
      acceptPrivatePolicy(author, 'author-policy'),
      acceptPrivatePolicy(receiver, 'receiver-policy'),
    ]);
    const genesis = output(await author.request(
      'publishCatalogGenesis',
      'private-genesis',
      'operation-completed',
      {
        scope: catalogScope(),
        authorPrivateKey: AUTHOR_WALLET.privateKey,
        issuedAt: '1773900000000',
        catalogIssuerDelegationEffectiveAt: '1773899999000',
        catalogIssuerDelegationExpiresAt: '1774000000000',
      },
    ), 'private genesis');
    let previousHead = stagedHead(genesis, 'private genesis');
    let publication: Record<string, unknown> | null = null;
    for (let index = 0; index < assets.length; index += 1) {
      publication = output(await author.request(
        'publishCatalogExactSetSuccessor',
        `private-successor-${index + 1}`,
        'operation-completed',
        {
          previousHead,
          authorPrivateKey: AUTHOR_WALLET.privateKey,
          catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
          assets: assets.slice(0, index + 1),
          deployment: DEPLOYMENT,
          issuedAt: String(1773900001000 + index),
        },
      ), `private successor ${index + 1}`);
      previousHead = stagedHead(publication, `private successor ${index + 1}`);
    }
    if (publication === null) throw new Error('private successor publication is missing');
    const announcement = record(publication.announcement, 'private successor announcement');
    exact(announcement.policyDigest, POLICY_DIGEST, 'private announcement policy digest');

    const denied = output(await author.request(
      'announce',
      'private-unbound-denial',
      'operation-completed',
      { announcement, peers: [receiverPeerId] },
    ), 'unbound announcement denial');
    exactJson(denied.announcedPeers, [], 'unbound announcement accepted peers');
    exact(array(denied.failedPeers, 'unbound announcement failed peers').length, 1,
      'unbound announcement failure count');

    await Promise.all([
      bindPeer(author, receiverPeerId, RECEIVER, 'author-bind-receiver'),
      bindPeer(receiver, authorPeerId, AUTHOR, 'receiver-bind-author'),
    ]);
    const delivery = output(await author.request(
      'announce',
      'private-authorized-announce',
      'operation-completed',
      { announcement, peers: [receiverPeerId] },
    ), 'authorized announcement');
    exactJson(delivery.announcedPeers, [receiverPeerId], 'authorized announcement peers');
    exactJson(delivery.failedPeers, [], 'authorized announcement failures');
    await receiver.request('awaitReceiverIdle', 'private-receiver-idle', 'receiver-idle');

    const headDigest = requiredDigest(publication.headObjectDigest, 'private head digest');
    const terminalFailure = await receiver.request(
      'terminalFailureReadback',
      'private-terminal-failure',
      'operation-completed',
      { catalogHeadDigest: headDigest },
    );
    exact(terminalFailure.output, null, 'private terminal failure');
    const synchronization = output(await receiver.request(
      'exactInventoryReadback',
      'private-inventory',
      'operation-completed',
      { catalogHeadDigest: headDigest },
    ), 'private inventory');
    const rows = array(synchronization.rows, 'private inventory rows');
    exact(rows.length, ASSET_COUNT, 'private recovered SWM row count');
    exact(synchronization.inventoryRowCount, ASSET_COUNT, 'private inventory row count');
    exact(synchronization.activatedTripleCount, ASSET_COUNT * 2, 'private SWM triple count');
    exact(synchronization.appliedHeadStatus, 'applied', 'private applied head status');

    let swmRecovered = 0;
    let vmRecovered = 0;
    for (const [index, value] of rows.entries()) {
      const row = record(value, `private row ${index}`);
      const semantic = output(await receiver.request(
        'semanticGraphReadback',
        `private-semantic-${index}`,
        'operation-completed',
        { swmGraph: requiredString(row.swmGraph, `private row ${index} graph`) },
      ), `private semantic ${index}`);
      exact(semantic.projectionNQuads, PROJECTION_NQUADS, `private SWM ${index}`);
      swmRecovered += 1;

      const kaNumber = FIRST_KA_NUMBER + BigInt(index);
      const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
      const ual = `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`;
      const vmGraph = contextGraphLayerUri(
        CONTEXT_GRAPH_ID,
        MemoryLayer.VerifiableMemory,
        AUTHOR,
        Number(kaNumber),
      );
      const vm = output(await receiver.request(
        'vmGraphReadback',
        `private-vm-${index}`,
        'operation-completed',
        { vmGraph, metaGraph: contextGraphMetaUri(CONTEXT_GRAPH_ID), ual },
      ), `private VM ${index}`);
      exact(vm.tripleCount, 2, `private VM ${index} triple count`);
      exact(vm.projectionNQuads, PROJECTION_NQUADS, `private VM ${index} projection`);
      const metadata = array(vm.metadataBindings, `private VM ${index} metadata`)
        .map((item, metadataIndex) => record(item, `private VM ${index} metadata ${metadataIndex}`));
      metadataObject(metadata, 'status', '"confirmed"');
      metadataObject(
        metadata,
        'batchId',
        `"${kaId}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      );
      metadataObject(metadata, 'materializedVersion', `"123:${index}"`);
      vmRecovered += 1;
    }

    const [authorStopped, receiverStopped] = await Promise.all([
      author.stop('private-author-stop'),
      receiver.stop('private-receiver-stop'),
    ]);
    const testedHeadCommit = assertGate2HarnessSourceStateV1(
      REPO_ROOT,
      head,
      launch.manifest,
    );
    const artifact = Object.freeze({
      accessPolicy: 1,
      policySource: 'finalized-chain',
      catalogTransport: 'private-v2-only',
      chainExpectedAssets: ASSET_COUNT,
      swm: { expected: ASSET_COUNT, recovered: swmRecovered },
      vm: { expected: ASSET_COUNT, recovered: vmRecovered },
      deniedUnboundPeer: true,
      noPublicOrCuratorFallback: true,
      processBoundary: {
        authorExitCode: authorStopped.exit.code,
        receiverExitCode: receiverStopped.exit.code,
      },
      policyDigest: POLICY_DIGEST,
      repository: { testedHeadCommit, trackedSourceClean: true },
      runtimeManifestDigest: launch.manifest.manifestDigest,
      schemaVersion: 'dkg-rfc64-cp2-private-swm-vm-recovery-v1',
      status: 'PASS',
    });
    const receipt = atomicWriteExactBytes(
      ARTIFACT,
      new TextEncoder().encode(canonicalDocument(artifact as unknown as CanonicalValue)),
    );
    process.stdout.write(
      `[rfc64-private-cp2] PASS swm=${swmRecovered}/${ASSET_COUNT} `
      + `vm=${vmRecovered}/${ASSET_COUNT} artifact=${ARTIFACT} sha256=${receipt.sha256}\n`,
    );
    operationFailed = false;
  } catch (error) {
    primaryFailure = error;
  } finally {
    await cleanupPreservingPrimaryFailure({
      operationFailed,
      primaryFailure,
      cleanup: () => registry.terminateAllThenCleanup(() => {
        rmSync(dataDirs.author, { recursive: true, force: true });
        rmSync(dataDirs.receiver, { recursive: true, force: true });
      }),
      reportSecondaryFailure: (primary, secondary) => {
        process.stderr.write(
          `[rfc64-private-cp2] cleanup failure after ${String(primary)}: ${String(secondary)}\n`,
        );
      },
    });
  }
}

function privateRegisteredPolicy(): ContextGraphPolicyV1 {
  return Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: CHAIN_ID,
    governanceContractAddress: CG_STORAGE,
    ownershipTransitionDigest: null,
    era: ZERO_U64,
    version: ZERO_U64,
    previousPolicyDigest: null,
    accessPolicy: 1,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: ZERO_U256,
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'finalized-chain' as const,
      chainId: CHAIN_ID,
      contractAddress: CG_STORAGE,
      blockNumber: '120' as DecimalU64V1,
      blockHash: `0x${'76'.repeat(32)}` as Digest32V1,
    },
    effectiveAt: '1773900000000' as DecimalU64V1,
    issuedAt: '1773900000000' as DecimalU64V1,
  });
}

function privateRoster(policyDigest: Digest32V1): MemberRosterV1 {
  return Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownershipTransitionDigest: null,
    era: ZERO_U64,
    version: ZERO_U64,
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest: null,
    members: [
      { agentAddress: AUTHOR, roles: ['holder', 'provider'] as const },
      { agentAddress: RECEIVER, roles: ['holder'] as const },
    ].sort((left, right) => left.agentAddress.localeCompare(right.agentAddress)),
    issuedAt: ZERO_U64,
  });
}

function unsignedPolicyEnvelope(policy: ContextGraphPolicyV1): UnsignedControlEnvelopeV1 {
  return {
    issuer: AUTHOR,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: policy,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
}

function catalogScope(): AuthorCatalogScopeV1 {
  return Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: CHAIN_ID,
    governanceContractAddress: CG_STORAGE,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: ZERO_U64,
    bucketCount: '1' as DecimalU64V1,
  });
}

async function acceptPrivatePolicy(child: Gate2AgentChild, requestId: string): Promise<void> {
  const accepted = output(await child.request(
    'acceptPolicySnapshot',
    requestId,
    'operation-completed',
    { policy: POLICY, policyDigest: POLICY_DIGEST, roster: ROSTER },
  ), `${requestId} result`);
  exact(accepted.policyDigest, POLICY_DIGEST, `${requestId} digest`);
}

async function bindPeer(
  child: Gate2AgentChild,
  peerId: string,
  agentAddress: EvmAddressV1,
  requestId: string,
): Promise<void> {
  const binding = output(await child.request(
    'bindCatalogPeerAgent',
    requestId,
    'operation-completed',
    { peerId, agentAddress },
  ), `${requestId} result`);
  exact(binding.peerId, peerId, `${requestId} peer ID`);
  exact(binding.agentAddress, agentAddress, `${requestId} agent address`);
}

async function authorSeal(kaNumber: bigint): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(CHAIN_ID),
    kav10Address: KAV10,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: CHAIN_ID,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function stagedHead(value: Record<string, unknown>, label: string): Record<string, string> {
  return {
    objectDigest: requiredDigest(value.headObjectDigest, `${label} object digest`),
    signatureVariantDigest: requiredDigest(
      value.signatureVariantDigest,
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
    requiredString(row.p, `metadata ${predicateSuffix} predicate`).endsWith(predicateSuffix));
  exact(matching.length, 1, `metadata ${predicateSuffix} row count`);
  exact(matching[0]!.o, expectedObject, `metadata ${predicateSuffix} object`);
}

function output(event: Gate2AgentEvent, label: string): Record<string, unknown> {
  return record(event.output, `${label} output`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new TypeError(`${label} is missing`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): Digest32V1 {
  const result = requiredString(value, label);
  if (!/^0x[0-9a-f]{64}$/u.test(result)) throw new TypeError(`${label} is not a digest`);
  return result as Digest32V1;
}

function exact(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

function exactJson(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
