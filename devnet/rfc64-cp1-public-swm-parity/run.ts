import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  type CanonicalGraphScopedAuthorSealV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type EvmAddressV1,
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
import {
  Gate2AgentChild,
  type Gate2AgentEvent,
} from '../rfc64-gate2-multi-asset-completeness/agent-child.js';
import {
  GATE2_ADAPTER_PROTOCOL_VERSION,
  GATE2_REAL_DKG_AGENT_ADAPTER_ID,
} from '../rfc64-gate2-multi-asset-completeness/model.js';
import {
  assertGate2RuntimeManifestEqualV1,
  buildGate2RuntimeManifestV1,
  consumeGate2RuntimeLaunchReceiptV1,
} from '../rfc64-gate2-multi-asset-completeness/runtime-provenance.ts';
import { canonicalDocument, type CanonicalValue } from
  '../rfc64-gate2-multi-asset-completeness/src/canonical.ts';
import {
  CP1_PUBLIC_SWM_PARITY_SCHEMA,
  semanticSha256,
  verifyCp1PublicSwmParity,
} from './verifier.ts';
import {
  CP1_NETWORK_ID,
  CP1_OWNER_ADDRESS,
  CP1_PUBLIC_CELL_SPECS,
  cp1CatalogScope,
  cp1PolicyDigest,
  cp1PublicPolicy,
  type Cp1PublicCellName,
  type Cp1PublicCellSpec,
} from './policy-cells.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const GATE2_DIR = resolve(import.meta.dirname, '../rfc64-gate2-multi-asset-completeness');
const ADAPTER_PROCESS = join(GATE2_DIR, 'adapter-process.ts');
const RUNTIME_LOAD_HOOK = join(GATE2_DIR, 'runtime-load-hook.ts');
const ARTIFACT = process.env.DKG_RFC64_CP1_ARTIFACT
  ?? join(import.meta.dirname, 'artifacts/cp1-public-swm-parity.json');
const PROCESS_TIMEOUT_MS = 90_000;
const NETWORK_ID = CP1_NETWORK_ID;
const OWNER_PRIVATE_KEY = `0x${'64'.repeat(32)}`;
const OWNER_WALLET = new ethers.Wallet(OWNER_PRIVATE_KEY);
const OWNER = OWNER_WALLET.address.toLowerCase() as EvmAddressV1;
if (OWNER !== CP1_OWNER_ADDRESS) {
  throw new Error('CP1 owner fixture does not match its pinned private key');
}
const KAV10 = '0x4444444444444444444444444444444444444444';
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
});
// This is the exact two-triple corpus committed by ASSERTION_ROOT below. The
// same signed KA bundle is deliberately reused in both public policy cells.
const PROJECTION_NQUADS =
  '<https://example.org/alice> <https://schema.org/age> '
  + '"42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f';
const ROLE_MASTER_KEYS = Object.freeze({ author: '1a'.repeat(32), receiver: '2b'.repeat(32) });

interface Cp1PublicationAsset {
  readonly bundleDigest: Digest32V1;
  readonly contentDigest: Digest32V1;
}

interface Cp1SynchronizationRow extends Cp1PublicationAsset {
  readonly swmGraph: string;
}

interface Cp1SemanticReadback {
  readonly projectionNQuads: string;
}

interface Cp1CellEvidence extends Cp1PublicationAsset {
  readonly accessPolicy: 0;
  readonly activatedTripleCount: number;
  readonly announcementPolicyDigest: Digest32V1;
  readonly announcedPeerId: string;
  readonly appliedHeadStatus: string;
  readonly authorPolicyDigest: Digest32V1;
  readonly cell: Cp1PublicCellName;
  readonly contextGraphId: string;
  readonly inventoryRowCount: number;
  readonly projectionNQuads: string;
  readonly publishPolicy: 0 | 1;
  readonly receiverPolicyDigest: Digest32V1;
  readonly semanticSha256: string;
}

interface RunPolicyCellContext {
  readonly author: Gate2AgentChild;
  readonly receiver: Gate2AgentChild;
  readonly receiverPeerId: string;
  readonly seal: CanonicalGraphScopedAuthorSealV1;
}

async function execute(): Promise<void> {
  const launch = consumeGate2RuntimeLaunchReceiptV1();
  const head = readCleanRepositoryHead(REPO_ROOT);
  exact(head, launch.sourceCommit, 'launch source commit');
  assertGate2RuntimeManifestEqualV1(
    buildGate2RuntimeManifestV1(REPO_ROOT, head),
    launch.manifest,
  );
  rmSync(ARTIFACT, { force: true });

  const authorDataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-cp1-author-'));
  const receiverDataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-cp1-receiver-'));
  const registry = new ChildProcessRegistry(20_000);
  let primaryFailure: unknown;
  let operationFailed = true;
  try {
    const author = spawnAgent('author', authorDataDir, registry, launch.manifest.manifestDigest, head);
    const receiver = spawnAgent(
      'receiver',
      receiverDataDir,
      registry,
      launch.manifest.manifestDigest,
      head,
    );
    const [authorReady, receiverReady] = await Promise.all([
      author.waitFor('ready'),
      receiver.waitFor('ready'),
    ]);
    requireReady(authorReady, 'author', launch.manifest.manifestDigest);
    requireReady(receiverReady, 'receiver', launch.manifest.manifestDigest);
    const authorPeerId = requiredString(authorReady.peerId, 'author peer ID');
    const receiverPeerId = requiredString(receiverReady.peerId, 'receiver peer ID');
    if (authorPeerId === receiverPeerId) throw new Error('CP1 peer identities are not distinct');
    const authorPid = requiredPid(author.child.pid, 'author PID');
    const receiverPid = requiredPid(receiver.child.pid, 'receiver PID');
    if (authorPid === receiverPid) throw new Error('CP1 process identities are not distinct');
    await connectBothWays(author, receiver, authorReady, receiverReady);

    const context: RunPolicyCellContext = {
      author,
      receiver,
      receiverPeerId,
      seal: await authorSeal(70n),
    };
    const cellEvidence: Cp1CellEvidence[] = [];
    for (const [index, spec] of CP1_PUBLIC_CELL_SPECS.entries()) {
      cellEvidence.push(await runPolicyCell(context, spec, index));
    }

    const [authorStopped, receiverStopped] = await Promise.all([
      author.stop('cp1-author-stop'),
      receiver.stop('cp1-receiver-stop'),
    ]);
    const artifact = {
      cells: cellEvidence,
      expectedProjectionNQuads: PROJECTION_NQUADS,
      expectedSemanticSha256: semanticSha256(PROJECTION_NQUADS),
      peers: { authorPeerId, receiverPeerId },
      processBoundary: {
        authorExitCode: authorStopped.exit.code,
        authorPid,
        receiverExitCode: receiverStopped.exit.code,
        receiverPid,
      },
      repository: { testedHeadCommit: head, trackedSourceClean: true },
      runtimeManifestDigest: launch.manifest.manifestDigest,
      schemaVersion: CP1_PUBLIC_SWM_PARITY_SCHEMA,
      status: 'PASS',
    };
    verifyCp1PublicSwmParity(artifact);
    const publication = atomicWriteExactBytes(
      ARTIFACT,
      new TextEncoder().encode(canonicalDocument(artifact as unknown as CanonicalValue)),
    );
    process.stdout.write(
      `[rfc64-cp1] PASS artifact=${ARTIFACT} sha256=${publication.sha256}\n`,
    );
    operationFailed = false;
  } catch (error) {
    primaryFailure = error;
  } finally {
    await cleanupPreservingPrimaryFailure({
      operationFailed,
      primaryFailure,
      cleanup: () => registry.terminateAllThenCleanup(() => {
        rmSync(authorDataDir, { recursive: true, force: true });
        rmSync(receiverDataDir, { recursive: true, force: true });
      }),
      reportSecondaryFailure: (primary, secondary) => {
        process.stderr.write(`[rfc64-cp1] cleanup failure after ${String(primary)}: ${String(secondary)}\n`);
      },
    });
  }
}

async function runPolicyCell(
  context: RunPolicyCellContext,
  spec: Cp1PublicCellSpec,
  index: number,
): Promise<Cp1CellEvidence> {
  const { author, receiver, receiverPeerId, seal } = context;
  const policy = cp1PublicPolicy(spec);
  const policyDigest = cp1PolicyDigest(spec);
  const [authorAccepted, receiverAccepted] = await Promise.all([
    acceptPolicy(author, `author-${spec.cell}`, policy, policyDigest),
    acceptPolicy(receiver, `receiver-${spec.cell}`, policy, policyDigest),
  ]);
  exact(authorAccepted, policyDigest, `${spec.cell} author policy digest`);
  exact(receiverAccepted, policyDigest, `${spec.cell} receiver policy digest`);

  const genesis = output(await author.request(
    'publishCatalogGenesis',
    `${spec.cell}-genesis`,
    'operation-completed',
    {
      scope: cp1CatalogScope(spec),
      authorPrivateKey: OWNER_PRIVATE_KEY,
      issuedAt: String(1773900000000 + index * 10_000),
      catalogIssuerDelegationEffectiveAt: '1773899999000',
      catalogIssuerDelegationExpiresAt: '1774000000000',
    },
  ), `${spec.cell} genesis`);
  const genesisAnnouncement = record(genesis.announcement, `${spec.cell} genesis announcement`);
  exact(genesisAnnouncement.policyDigest, policyDigest, `${spec.cell} genesis policy digest`);
  await announceAndDrain(
    author,
    receiver,
    genesisAnnouncement,
    receiverPeerId,
    `${spec.cell}-genesis`,
  );

  const publication = output(await author.request(
    'publishCatalogExactSetSuccessor',
    `${spec.cell}-successor`,
    'operation-completed',
    {
      previousHead: stagedHead(genesis, `${spec.cell} genesis`),
      authorPrivateKey: OWNER_PRIVATE_KEY,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [{
        assertionCoordinate: 'cp1-byte-identical-public-corpus',
        projectionNQuads: PROJECTION_NQUADS,
        seal,
      }],
      deployment: DEPLOYMENT,
      issuedAt: String(1773900001000 + index * 10_000),
    },
  ), `${spec.cell} successor`);
  const announcement = record(publication.announcement, `${spec.cell} successor announcement`);
  exact(announcement.policyDigest, policyDigest, `${spec.cell} successor policy digest`);
  await announceAndDrain(
    author,
    receiver,
    announcement,
    receiverPeerId,
    `${spec.cell}-successor`,
  );

  const headDigest = requiredDigest(publication.headObjectDigest, `${spec.cell} head digest`);
  const synchronization = output(await receiver.request(
    'exactInventoryReadback',
    `${spec.cell}-inventory`,
    'operation-completed',
    { catalogHeadDigest: headDigest },
  ), `${spec.cell} inventory`);
  const rows = array(synchronization.rows, `${spec.cell} inventory rows`);
  if (rows.length !== 1) throw new Error(`${spec.cell} did not apply exactly one row`);
  const row = synchronizationRow(rows[0], `${spec.cell} inventory row`);
  const semantic = semanticReadback(output(await receiver.request(
    'semanticGraphReadback',
    `${spec.cell}-semantic`,
    'operation-completed',
    { swmGraph: row.swmGraph },
  ), `${spec.cell} semantic readback`), `${spec.cell} semantic readback`);
  exact(semantic.projectionNQuads, PROJECTION_NQUADS, `${spec.cell} exact semantic bytes`);

  const publishedAssets = array(publication.assets, `${spec.cell} published assets`);
  if (publishedAssets.length !== 1) throw new Error(`${spec.cell} publication has wrong row count`);
  const publishedAsset = publicationAsset(publishedAssets[0], `${spec.cell} published asset`);
  exact(publishedAsset.bundleDigest, row.bundleDigest, `${spec.cell} bundle transfer digest`);
  exact(publishedAsset.contentDigest, row.contentDigest, `${spec.cell} content transfer digest`);

  return {
    accessPolicy: 0,
    activatedTripleCount: requiredInteger(
      synchronization.activatedTripleCount,
      `${spec.cell} activated triple count`,
    ),
    announcementPolicyDigest: requiredDigest(
      announcement.policyDigest,
      `${spec.cell} announcement policy digest`,
    ),
    announcedPeerId: receiverPeerId,
    appliedHeadStatus: requiredString(
      synchronization.appliedHeadStatus,
      `${spec.cell} applied status`,
    ),
    authorPolicyDigest: authorAccepted,
    bundleDigest: row.bundleDigest,
    cell: spec.cell,
    contentDigest: row.contentDigest,
    contextGraphId: spec.contextGraphId,
    inventoryRowCount: requiredInteger(
      synchronization.inventoryRowCount,
      `${spec.cell} inventory row count`,
    ),
    projectionNQuads: semantic.projectionNQuads,
    publishPolicy: spec.publishPolicy,
    receiverPolicyDigest: receiverAccepted,
    semanticSha256: semanticSha256(semantic.projectionNQuads),
  };
}

function publicationAsset(value: unknown, label: string): Cp1PublicationAsset {
  const asset = record(value, label);
  return Object.freeze({
    bundleDigest: requiredDigest(asset.bundleDigest, `${label}.bundleDigest`),
    contentDigest: requiredDigest(asset.contentDigest, `${label}.contentDigest`),
  });
}

function synchronizationRow(value: unknown, label: string): Cp1SynchronizationRow {
  const row = record(value, label);
  return Object.freeze({
    ...publicationAsset(row, label),
    swmGraph: requiredString(row.swmGraph, `${label}.swmGraph`),
  });
}

function semanticReadback(value: unknown, label: string): Cp1SemanticReadback {
  const semantic = record(value, label);
  return Object.freeze({
    projectionNQuads: requiredString(
      semantic.projectionNQuads,
      `${label}.projectionNQuads`,
    ),
  });
}

async function acceptPolicy(
  child: Gate2AgentChild,
  requestId: string,
  policy: ContextGraphPolicyV1,
  policyDigest: Digest32V1,
): Promise<Digest32V1> {
  const accepted = output(await child.request(
    'acceptPolicySnapshot',
    requestId,
    'operation-completed',
    { policy, policyDigest },
  ), `${requestId} accepted policy`);
  return requiredDigest(accepted.policyDigest, `${requestId} policy digest`);
}

async function announceAndDrain(
  author: Gate2AgentChild,
  receiver: Gate2AgentChild,
  announcement: Record<string, unknown>,
  receiverPeerId: string,
  requestId: string,
): Promise<void> {
  const delivery = output(await author.request(
    'announce',
    `${requestId}-announce`,
    'operation-completed',
    { announcement, peers: [receiverPeerId] },
  ), `${requestId} delivery`);
  exact(delivery.announcedPeers, [receiverPeerId], `${requestId} acknowledged peer`);
  exact(delivery.failedPeers, [], `${requestId} failed peers`);
  await receiver.request(
    'awaitReceiverIdle',
    `${requestId}-idle`,
    'receiver-idle',
  );
}

async function connectBothWays(
  author: Gate2AgentChild,
  receiver: Gate2AgentChild,
  authorReady: Gate2AgentEvent,
  receiverReady: Gate2AgentEvent,
): Promise<void> {
  await Promise.all([
    author.request('dial', 'cp1-dial-author', 'dialed', {
      multiaddr: receiverReady.multiaddr,
      peerId: receiverReady.peerId,
    }),
    receiver.request('dial', 'cp1-dial-receiver', 'dialed', {
      multiaddr: authorReady.multiaddr,
      peerId: authorReady.peerId,
    }),
  ]);
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

function requireReady(
  event: Gate2AgentEvent,
  role: 'author' | 'receiver',
  manifestDigest: string,
): void {
  exact(event.role, role, `${role} ready role`);
  exact(event.adapterId, GATE2_REAL_DKG_AGENT_ADAPTER_ID, `${role} adapter`);
  exact(event.protocolVersion, GATE2_ADAPTER_PROTOCOL_VERSION, `${role} protocol`);
  exact(event.agentClass, 'DKGAgent', `${role} agent class`);
  exact(event.catalogServiceStarted, true, `${role} catalog service`);
  exact(event.runtimeBuildManifestDigest, manifestDigest, `${role} runtime manifest`);
  const capabilities = record(event.capabilities, `${role} capabilities`);
  for (const capability of [
    'acceptPolicySnapshot',
    'announce',
    'exactInventoryReadback',
    'publishPolicyBoundExactSetSuccessor',
    'publishPolicyBoundGenesis',
  ]) exact(capabilities[capability], true, `${role} capability ${capability}`);
  requiredString(event.peerId, `${role} peer ID`);
  requiredString(event.multiaddr, `${role} multiaddr`);
}

async function authorSeal(kaNumber: bigint): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(OWNER) << 96n) | kaNumber).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address as never,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: OWNER,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await OWNER_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: OWNER,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${OWNER}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function stagedHead(value: Record<string, unknown>, label: string): Record<string, unknown> {
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
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is missing`);
  return value;
}

function requiredDigest(value: unknown, label: string): Digest32V1 {
  const result = requiredString(value, label);
  if (!/^0x[0-9a-f]{64}$/u.test(result)) throw new TypeError(`${label} is not a digest`);
  return result as Digest32V1;
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} is not a non-negative integer`);
  }
  return value as number;
}

function requiredPid(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${label} missing`);
  return value as number;
}

function exact(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

await execute();
