import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  spawnGate2HarnessAgentV1,
} from '../rfc64-gate2-multi-asset-completeness/two-agent-harness.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ARTIFACT = process.env.DKG_RFC64_PRIVATE_CP3_ARTIFACT
  ?? join(import.meta.dirname, 'artifacts/cp3-private-provider-failover.json');
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CHAIN_ID = '20430' as DecimalU256V1;
const ZERO_U64 = '0' as DecimalU64V1;
const ZERO_U256 = '0' as DecimalU256V1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/cp3-private-failover' as ContextGraphIdV1;
const ON_CHAIN_CONTEXT_GRAPH_ID = '15';
const CG_STORAGE = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const AUTHOR_WALLET = new ethers.Wallet(`0x${'74'.repeat(32)}`);
const PROVIDER_A_WALLET = new ethers.Wallet(`0x${'75'.repeat(32)}`);
const PROVIDER_B_WALLET = new ethers.Wallet(`0x${'76'.repeat(32)}`);
const RECEIVER_WALLET = new ethers.Wallet(`0x${'77'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const PROVIDER_A = PROVIDER_A_WALLET.address.toLowerCase() as EvmAddressV1;
const PROVIDER_B = PROVIDER_B_WALLET.address.toLowerCase() as EvmAddressV1;
const RECEIVER = RECEIVER_WALLET.address.toLowerCase() as EvmAddressV1;
const ASSET_COUNT = boundedAssetCount(
  process.env.DKG_RFC64_PRIVATE_FAILOVER_ASSET_COUNT,
  32,
);
const PROCESS_EVENT_TIMEOUT_MS = Math.max(120_000, ASSET_COUNT * 4_000);
const PROVIDER_A_BUNDLE_DELAY_MS = 150;
const PROVIDER_A_KILL_DELAY_MS = 750;
const FIRST_KA_NUMBER = 2_000n;
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
const PROJECTION_NQUADS =
  '<https://example.org/failover> <https://schema.org/name> "Release 3" .\n'
  + '<https://example.org/failover> <https://schema.org/version> "3" .\n';
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: CHAIN_ID,
  assertedAtKav10Address: KAV10,
});
const POLICY = privateRegisteredPolicy();
const POLICY_DIGEST = computeContextGraphPolicyObjectDigestV1(unsignedPolicyEnvelope(POLICY));
const ROSTER = privateRoster(POLICY_DIGEST);

await execute();

async function execute(): Promise<void> {
  const launch = consumeGate2RuntimeLaunchReceiptV1();
  const head = assertGate2HarnessSourceStateV1(REPO_ROOT, launch.sourceCommit, launch.manifest);
  rmSync(ARTIFACT, { force: true });
  const dataDirs = {
    author: mkdtempSync(join(tmpdir(), 'dkg-rfc64-cp3-author-')),
    providerA: mkdtempSync(join(tmpdir(), 'dkg-rfc64-cp3-provider-a-')),
    providerB: mkdtempSync(join(tmpdir(), 'dkg-rfc64-cp3-provider-b-')),
    receiver: mkdtempSync(join(tmpdir(), 'dkg-rfc64-cp3-receiver-')),
  };
  const registry = new ChildProcessRegistry(20_000);
  let primaryFailure: unknown;
  let operationFailed = true;
  try {
    const assets = await Promise.all(Array.from({ length: ASSET_COUNT }, async (_, index) => {
      const kaNumber = FIRST_KA_NUMBER + BigInt(index);
      return Object.freeze({
        assertionCoordinate: `cp3-private-asset-${String(index).padStart(3, '0')}`,
        projectionNQuads: PROJECTION_NQUADS,
        seal: await authorSeal(kaNumber),
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
    const common = {
      eventTimeoutMs: PROCESS_EVENT_TIMEOUT_MS,
      networkChainId: NETWORK_ID,
      registry,
      repoRoot: REPO_ROOT,
      runtimeManifestDigest: launch.manifest.manifestDigest,
      sourceCommit: head,
    } as const;
    const author = spawnGate2HarnessAgentV1({
      ...common,
      role: 'author',
      catalogLocalAgentAddress: AUTHOR,
      dataDir: dataDirs.author,
    });
    const providerA = spawnGate2HarnessAgentV1({
      ...common,
      role: 'receiver',
      catalogLocalAgentAddress: PROVIDER_A,
      dataDir: dataDirs.providerA,
      finalizedVmConfigJson,
      masterKeyHex: '3c'.repeat(32),
      bundleServeDelayMs: PROVIDER_A_BUNDLE_DELAY_MS,
    });
    const providerB = spawnGate2HarnessAgentV1({
      ...common,
      role: 'receiver',
      catalogLocalAgentAddress: PROVIDER_B,
      dataDir: dataDirs.providerB,
      finalizedVmConfigJson,
      masterKeyHex: '4d'.repeat(32),
    });
    const receiver = spawnGate2HarnessAgentV1({
      ...common,
      role: 'receiver',
      catalogLocalAgentAddress: RECEIVER,
      dataDir: dataDirs.receiver,
      finalizedVmConfigJson,
    });
    const [authorReady, providerAReady, providerBReady, receiverReady] = await Promise.all([
      author.waitFor('ready'),
      providerA.waitFor('ready'),
      providerB.waitFor('ready'),
      receiver.waitFor('ready'),
    ]);
    assertGate2HarnessReadyV1(authorReady, 'author', launch.manifest.manifestDigest);
    for (const ready of [providerAReady, providerBReady, receiverReady]) {
      assertGate2HarnessReadyV1(ready, 'receiver', launch.manifest.manifestDigest);
      exact(ready.finalizedVmRuntime, true, 'receiver finalized VM runtime');
    }
    const authorPeerId = requiredString(authorReady.peerId, 'author peer ID');
    const providerAPeerId = requiredString(providerAReady.peerId, 'provider A peer ID');
    const providerBPeerId = requiredString(providerBReady.peerId, 'provider B peer ID');
    const receiverPeerId = requiredString(receiverReady.peerId, 'receiver peer ID');
    exact(new Set([authorPeerId, providerAPeerId, providerBPeerId, receiverPeerId]).size, 4,
      'distinct peer count');

    await Promise.all([
      connectGate2HarnessAgentsV1(author, providerA, authorReady, providerAReady, 'cp3-a'),
      connectGate2HarnessAgentsV1(author, providerB, authorReady, providerBReady, 'cp3-b'),
      connectGate2HarnessAgentsV1(providerA, receiver, providerAReady, receiverReady, 'cp3-ra'),
      connectGate2HarnessAgentsV1(providerB, receiver, providerBReady, receiverReady, 'cp3-rb'),
    ]);
    await Promise.all([
      acceptPrivatePolicy(author, 'author-policy'),
      acceptPrivatePolicy(providerA, 'provider-a-policy'),
      acceptPrivatePolicy(providerB, 'provider-b-policy'),
      acceptPrivatePolicy(receiver, 'receiver-policy'),
    ]);
    await Promise.all([
      bindPeer(author, providerAPeerId, PROVIDER_A, 'author-bind-a'),
      bindPeer(author, providerBPeerId, PROVIDER_B, 'author-bind-b'),
      bindPeer(providerA, authorPeerId, AUTHOR, 'a-bind-author'),
      bindPeer(providerB, authorPeerId, AUTHOR, 'b-bind-author'),
      bindPeer(providerA, receiverPeerId, RECEIVER, 'a-bind-receiver'),
      bindPeer(providerB, receiverPeerId, RECEIVER, 'b-bind-receiver'),
      bindPeer(receiver, providerAPeerId, PROVIDER_A, 'receiver-bind-a'),
      bindPeer(receiver, providerBPeerId, PROVIDER_B, 'receiver-bind-b'),
    ]);

    const genesis = output(await author.request(
      'publishCatalogGenesis',
      'private-genesis',
      'operation-completed',
      {
        scope: catalogScope(),
        authorPrivateKey: AUTHOR_WALLET.privateKey,
        issuedAt: '1774000000000',
        catalogIssuerDelegationEffectiveAt: '1773999999000',
        catalogIssuerDelegationExpiresAt: '1774100000000',
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
          issuedAt: String(1774000001000 + index),
        },
      ), `private successor ${index + 1}`);
      previousHead = stagedHead(publication, `private successor ${index + 1}`);
    }
    if (publication === null) throw new Error('private successor publication is missing');
    const announcement = record(publication.announcement, 'private successor announcement');
    const headDigest = requiredDigest(publication.headObjectDigest, 'private head digest');
    const providerDelivery = output(await author.request(
      'announce',
      'private-provider-announce',
      'operation-completed',
      { announcement, peers: [providerAPeerId, providerBPeerId] },
    ), 'private provider delivery');
    exact(array(providerDelivery.announcedPeers, 'provider delivery peers').length, 2,
      'provider delivery success count');
    exact(array(providerDelivery.failedPeers, 'provider delivery failures').length, 0,
      'provider delivery failure count');
    await Promise.all([
      providerA.request('awaitReceiverIdle', 'provider-a-idle', 'receiver-idle'),
      providerB.request('awaitReceiverIdle', 'provider-b-idle', 'receiver-idle'),
    ]);
    for (const [label, child] of [['provider A', providerA], ['provider B', providerB]] as const) {
      const evidence = output(await child.request(
        'exactInventoryReadback',
        `${label.replaceAll(' ', '-')}-inventory`,
        'operation-completed',
        { catalogHeadDigest: headDigest },
      ), `${label} inventory`);
      exact(evidence.inventoryRowCount, ASSET_COUNT, `${label} exact row count`);
      exact(evidence.activatedTripleCount, ASSET_COUNT * 2, `${label} SWM triple count`);
      exact(evidence.appliedHeadStatus, 'applied', `${label} applied head`);
    }

    const synchronizationPromise = receiver.request(
      'synchronizeCatalogProviders',
      'receiver-provider-failover',
      'operation-completed',
      { remotePeerIds: [providerAPeerId, providerBPeerId], scope: catalogScope() },
    );
    await delay(PROVIDER_A_KILL_DELAY_MS);
    const providerAExit = await registry.terminateAndWait(providerA.tracked, 'SIGKILL');
    exact(providerAExit.code, null, 'provider A exit code');
    exact(providerAExit.signal, 'SIGKILL', 'provider A exit signal');
    const synchronization = output(await synchronizationPromise, 'receiver failover sync');
    exactJson(
      synchronization.providerPeerIds,
      [providerAPeerId, providerBPeerId],
      'discovered exact-head providers',
    );

    const failure = await receiver.request(
      'terminalFailureReadback',
      'receiver-terminal-failure',
      'operation-completed',
      { catalogHeadDigest: headDigest },
    );
    exact(failure.output, null, 'receiver terminal failure');
    const finalInventory = output(await receiver.request(
      'exactInventoryReadback',
      'receiver-final-inventory',
      'operation-completed',
      { catalogHeadDigest: headDigest },
    ), 'receiver exact inventory');
    const rows = array(finalInventory.rows, 'receiver exact rows');
    exact(rows.length, ASSET_COUNT, 'receiver SWM row count');
    exact(finalInventory.inventoryRowCount, ASSET_COUNT, 'receiver inventory row count');
    exact(finalInventory.activatedTripleCount, ASSET_COUNT * 2, 'receiver SWM triple count');
    exact(finalInventory.appliedHeadStatus, 'applied', 'receiver applied head status');

    let vmRecovered = 0;
    const ordinals = new Set<number>();
    for (const [index, value] of rows.entries()) {
      const row = record(value, `receiver row ${index}`);
      const kaId = requiredString(row.kaId, `receiver row ${index} KA ID`);
      const kaNumber = BigInt(kaId) & ((1n << 96n) - 1n);
      const ordinal = Number(kaNumber - FIRST_KA_NUMBER);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= ASSET_COUNT) {
        throw new Error(`receiver row ${index} has an unexpected KA ordinal`);
      }
      if (ordinals.has(ordinal)) throw new Error(`receiver duplicated KA ordinal ${ordinal}`);
      ordinals.add(ordinal);
      const vm = output(await receiver.request(
        'vmGraphReadback',
        `receiver-vm-${index}`,
        'operation-completed',
        {
          vmGraph: contextGraphLayerUri(
            CONTEXT_GRAPH_ID,
            MemoryLayer.VerifiableMemory,
            AUTHOR,
            Number(kaNumber),
          ),
          metaGraph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
          ual: requiredString(row.kaUal, `receiver row ${index} UAL`),
        },
      ), `receiver VM ${index}`);
      exact(vm.tripleCount, 2, `receiver VM ${index} triple count`);
      exact(vm.projectionNQuads, PROJECTION_NQUADS, `receiver VM ${index} projection`);
      vmRecovered += 1;
    }
    exact(ordinals.size, ASSET_COUNT, 'receiver finalized ordinal count');

    const stats = output(await receiver.request(
      'catalogStats',
      'receiver-catalog-stats',
      'operation-completed',
    ), 'receiver catalog stats');
    const receiverStats = record(stats.receiver, 'receiver scheduler stats');
    const resourceStats = record(stats.nativeReceiver, 'receiver resource stats');
    atLeast(receiverStats.providerAttempts, 2, 'provider attempts');
    atLeast(receiverStats.providerSwitches, 1, 'provider switches');
    exact(receiverStats.providerSuccesses, 1, 'provider successes');
    exact(receiverStats.failed, 0, 'receiver failures');
    atLeast(resourceStats.kaBundleNetworkFetches, 1, 'bundle network fetches');
    atLeast(resourceStats.kaBundleCacheHits, 1, 'bundle cache hits after failover');

    const [authorStopped, providerBStopped, receiverStopped] = await Promise.all([
      author.stop('author-stop'),
      providerB.stop('provider-b-stop'),
      receiver.stop('receiver-stop'),
    ]);
    const testedHeadCommit = assertGate2HarnessSourceStateV1(
      REPO_ROOT,
      head,
      launch.manifest,
    );
    const artifact = Object.freeze({
      accessPolicy: 1,
      catalogTransport: 'private-v2-only',
      providers: { configured: 2, discoveredExactHead: 2, terminatedDuringTransfer: 1 },
      failover: {
        providerAttempts: receiverStats.providerAttempts,
        providerSwitches: receiverStats.providerSwitches,
        providerSuccesses: receiverStats.providerSuccesses,
      },
      swm: { expected: ASSET_COUNT, recovered: rows.length },
      vm: { expected: ASSET_COUNT, recovered: vmRecovered },
      resources: {
        controlObjectCacheHits: resourceStats.controlObjectCacheHits,
        controlObjectNetworkFetches: resourceStats.controlObjectNetworkFetches,
        kaBundleCacheHits: resourceStats.kaBundleCacheHits,
        kaBundleNetworkFetches: resourceStats.kaBundleNetworkFetches,
      },
      processBoundary: {
        authorExitCode: authorStopped.exit.code,
        providerAExitSignal: providerAExit.signal,
        providerBExitCode: providerBStopped.exit.code,
        receiverExitCode: receiverStopped.exit.code,
      },
      policyDigest: POLICY_DIGEST,
      repository: { testedHeadCommit, trackedSourceClean: true },
      runtimeManifestDigest: launch.manifest.manifestDigest,
      schemaVersion: 'dkg-rfc64-cp3-private-provider-failover-v1',
      status: 'PASS',
    });
    const receipt = atomicWriteExactBytes(
      ARTIFACT,
      new TextEncoder().encode(canonicalDocument(artifact as unknown as CanonicalValue)),
    );
    process.stdout.write(
      `[rfc64-private-cp3] PASS swm=${rows.length}/${ASSET_COUNT} `
      + `vm=${vmRecovered}/${ASSET_COUNT} switches=${String(receiverStats.providerSwitches)} `
      + `artifact=${ARTIFACT} sha256=${receipt.sha256}\n`,
    );
    operationFailed = false;
  } catch (error) {
    primaryFailure = error;
  } finally {
    await cleanupPreservingPrimaryFailure({
      operationFailed,
      primaryFailure,
      cleanup: () => registry.terminateAllThenCleanup(() => {
        for (const path of Object.values(dataDirs)) {
          rmSync(path, { recursive: true, force: true });
        }
      }),
      reportSecondaryFailure: (primary, secondary) => {
        process.stderr.write(
          `[rfc64-private-cp3] cleanup failure after ${String(primary)}: ${String(secondary)}\n`,
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
      blockNumber: '130' as DecimalU64V1,
      blockHash: `0x${'86'.repeat(32)}` as Digest32V1,
    },
    effectiveAt: '1774000000000' as DecimalU64V1,
    issuedAt: '1774000000000' as DecimalU64V1,
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
      { agentAddress: PROVIDER_A, roles: ['holder', 'provider'] as const },
      { agentAddress: PROVIDER_B, roles: ['holder', 'provider'] as const },
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
    assertionFinalizedAt: '2026-07-20T12:34:56.789Z',
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

function boundedAssetCount(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]{0,2}$/u.test(value)) {
    throw new TypeError('DKG_RFC64_PRIVATE_FAILOVER_ASSET_COUNT must be an integer from 2 to 128');
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 2 || count > 128) {
    throw new TypeError('DKG_RFC64_PRIVATE_FAILOVER_ASSET_COUNT must be an integer from 2 to 128');
  }
  return count;
}

function atLeast(value: unknown, minimum: number, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} is below ${minimum}: ${JSON.stringify(value)}`);
  }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
