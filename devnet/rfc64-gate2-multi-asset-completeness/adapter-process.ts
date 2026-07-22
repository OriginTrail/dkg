import { mkdir, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { multiaddr } from '@multiformats/multiaddr';
import {
  DKGAgent,
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  produceDirectAuthorCatalogIssuerDelegationV1,
  produceEmptyAuthorCatalogGenesisV1,
} from '@origintrail-official/dkg-agent';
import {
  MockChainAdapter,
  verifyControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import {
  assertAssertionCoordinateV1,
  assertAuthorCatalogScopeV1,
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalGraphScopedAuthorSealV1,
  assertCanonicalTimestampMs,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSubGraphNameV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  computeControlSignatureVariantDigestHex,
  parseDeterministicKnowledgeAssetUal,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  OxigraphStore,
  quadsToNQuads,
  type Quad,
} from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

import {
  GATE2_ADAPTER_PROTOCOL_VERSION,
  GATE2_AGENT_EVENT_PREFIX,
  GATE2_REAL_DKG_AGENT_ADAPTER_ID,
} from './model.js';
import {
  RFC64_GATE2_DEPLOYMENT,
  parseFinalizedVmHarnessConfigV1,
  startFinalizedVmHarnessRuntimeV1,
  type FinalizedVmHarnessRuntimeV1,
} from './finalized-vm-harness-runtime.ts';
import { sealGate2ExecutedRuntimeManifestV1 } from './runtime-load-hook.ts';

const role = process.argv[2];
const dataDirInput = process.env.DKG_RFC64_GATE2_ADAPTER_DATA_DIR;
const masterKeyHex = process.env.DKG_RFC64_GATE2_AGENT_MASTER_KEY_HEX;
const runtimeBuildManifestDigest = process.env.DKG_RFC64_GATE2_RUNTIME_MANIFEST_DIGEST;
const finalizedVmConfigInput = process.env.DKG_RFC64_GATE2_FINALIZED_VM_CONFIG;
const networkChainIdInput = process.env.DKG_RFC64_GATE2_NETWORK_CHAIN_ID;
if (role !== 'author' && role !== 'receiver') throw new Error('adapter role is required');
if (!dataDirInput) throw new Error('DKG_RFC64_GATE2_ADAPTER_DATA_DIR is required');
if (!masterKeyHex || !/^[0-9a-f]{64}$/u.test(masterKeyHex)) {
  throw new Error('DKG_RFC64_GATE2_AGENT_MASTER_KEY_HEX must be 32 lowercase hex bytes');
}
if (!runtimeBuildManifestDigest || !/^0x[0-9a-f]{64}$/u.test(runtimeBuildManifestDigest)) {
  throw new Error('DKG_RFC64_GATE2_RUNTIME_MANIFEST_DIGEST must be a canonical digest');
}

const dataDir = resolve(dataDirInput);
const pinnedMasterKeyHex = masterKeyHex;
let agent: DKGAgent | undefined;
let finalizedVmRuntime: Readonly<FinalizedVmHarnessRuntimeV1> | undefined;
let stopping = false;
let commandTail = Promise.resolve();

interface Command {
  readonly command: string;
  readonly input?: unknown;
  readonly requestId: string;
}

function emit(event: Record<string, unknown>): void {
  const line = JSON.stringify({ role, ...event });
  if (Buffer.byteLength(line) > 1_000_000) {
    throw new Error('Gate 2 adapter event exceeds the 1 MiB process-protocol bound');
  }
  process.stdout.write(`${GATE2_AGENT_EVENT_PREFIX}${line}\n`);
}

async function emitAndFlush(event: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ role, ...event });
  if (Buffer.byteLength(line) > 1_000_000) {
    throw new Error('Gate 2 adapter event exceeds the 1 MiB process-protocol bound');
  }
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(`${GATE2_AGENT_EVENT_PREFIX}${line}\n`, (error) => {
      if (error === null || error === undefined) resolveWrite();
      else rejectWrite(error);
    });
  });
}

async function ensureDeterministicAgentKey(): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, 'agent-key.bin');
  const expected = Buffer.from(pinnedMasterKeyHex, 'hex');
  try {
    const handle = await open(keyPath, 'wx', 0o600);
    try {
      await handle.writeFile(expected);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    const existing = await readFile(keyPath);
    if (!existing.equals(expected)) {
      throw new Error('existing DKGAgent master key differs from the role-pinned harness key');
    }
  }
}

async function boot(): Promise<void> {
  await ensureDeterministicAgentKey();
  const finalizedVmConfig = finalizedVmConfigInput === undefined
    ? null
    : parseFinalizedVmHarnessConfigV1(finalizedVmConfigInput);
  if (finalizedVmConfig !== null && role !== 'receiver') {
    throw new Error('finalized VM harness runtime is receiver-only');
  }
  if (networkChainIdInput !== undefined) {
    assertNetworkIdV1(networkChainIdInput);
  }
  if (
    finalizedVmConfig !== null
    && networkChainIdInput !== RFC64_GATE2_DEPLOYMENT.networkId
  ) {
    throw new Error('finalized VM harness network chain id differs from its deployment');
  }
  if (finalizedVmConfig !== null) {
    finalizedVmRuntime = await startFinalizedVmHarnessRuntimeV1(finalizedVmConfig);
  }
  const networkChainAdapter = finalizedVmRuntime?.chainAdapter
    ?? (networkChainIdInput === undefined ? undefined : new MockChainAdapter(networkChainIdInput));
  const created = await DKGAgent.create({
    name: `RFC64Gate2${role}`,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(join(dataDir, 'store.nq')),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
    rfc64CatalogDeploymentProfile: RFC64_GATE2_DEPLOYMENT as never,
    ...(networkChainAdapter === undefined ? {} : { chainAdapter: networkChainAdapter }),
    ...(finalizedVmRuntime === undefined ? {} : {
      chainConfig: {
        rpcUrl: finalizedVmRuntime.rpcUrl,
        hubAddress: '0x3333333333333333333333333333333333333333',
        operationalKeys: [`0x${'12'.repeat(32)}`],
      },
    }),
    ...(finalizedVmConfig === null ? {} : {
      initialContextGraphSubscriptions: [{
        contextGraphId: finalizedVmConfig.contextGraphId,
        state: { subscribed: true, synced: false },
      }],
    }),
  });
  agent = created;
  await created.start();
  if (finalizedVmConfig !== null) {
    await created.awaitInitialChainPoll();
  }
  const tcp = created.multiaddrs.find((address) => address.includes('/tcp/'));
  if (tcp === undefined) throw new Error('real DKGAgent exposed no TCP multiaddr');
  emit({
    adapterId: GATE2_REAL_DKG_AGENT_ADAPTER_ID,
    agentClass: created.constructor.name,
    capabilities: inspectGate2ProductCapabilities(created),
    catalogServiceStarted: created.rfc64PublicCatalogStatsV1()?.started === true,
    event: 'ready',
    multiaddr: tcp,
    peerId: created.peerId,
    protocolVersion: GATE2_ADAPTER_PROTOCOL_VERSION,
    processId: process.pid,
    runtimeBuildManifestDigest,
    finalizedVmRuntime: finalizedVmConfig !== null,
    startupRepair: null,
  });
}

async function handle(command: Command): Promise<void> {
  if (typeof command.requestId !== 'string' || command.requestId.length === 0) {
    throw new Error('requestId is required');
  }
  const currentAgent = requireAgent();
  switch (command.command) {
    case 'dial': {
      const input = plainRecord(command.input, 'dial input');
      const address = requiredString(input.multiaddr, 'dial.multiaddr');
      const expectedPeerId = requiredString(input.peerId, 'dial.peerId');
      const connection = await currentAgent.node.libp2p.dial(multiaddr(address));
      const connectedPeerId = connection.remotePeer.toString();
      if (connectedPeerId !== expectedPeerId) {
        throw new Error(`dial connected to ${connectedPeerId}, expected ${expectedPeerId}`);
      }
      emit({ event: 'dialed', peerId: connectedPeerId, requestId: command.requestId });
      return;
    }
    case 'acceptOpenPolicy': {
      const accepted = currentAgent.acceptOpenContextGraphPolicyV1(
        plainRecord(command.input, 'acceptOpenPolicy input') as never,
      );
      emit({
        event: 'operation-completed',
        operation: command.command,
        output: accepted,
        requestId: command.requestId,
      });
      return;
    }
    case 'acceptPolicySnapshot': {
      const accepted = currentAgent.acceptRfc64CatalogAccessSnapshotV1(
        plainRecord(command.input, 'acceptPolicySnapshot input') as never,
      );
      emitOperationResult(command, accepted);
      return;
    }
    case 'publishGenesis': {
      requireRole('author');
      const output = await currentAgent.publishOpenAuthorCatalogGenesisV1(
        normalizeOpenGenesisInput(command),
      );
      emitOperationResult(command, output);
      return;
    }
    case 'publishCatalogGenesis': {
      requireRole('author');
      const output = await currentAgent.publishAuthorCatalogGenesisV1(
        normalizePolicyBoundGenesisInput(command),
      );
      emitOperationResult(command, output);
      return;
    }
    case 'publishExactSetSuccessor': {
      requireRole('author');
      const output = await publishExactSetSuccessorVia(
        currentAgent,
        command,
        'open',
      );
      emitOperationResult(command, output);
      return;
    }
    case 'publishCatalogExactSetSuccessor': {
      requireRole('author');
      const output = await publishExactSetSuccessorVia(
        currentAgent,
        command,
        'policy-bound',
      );
      emitOperationResult(command, output);
      return;
    }
    case 'announce': {
      requireRole('author');
      const output = await currentAgent.announceRfc64PublicCatalogHeadV1(
        plainRecord(command.input, 'announce input') as never,
      );
      emitOperationResult(command, output);
      return;
    }
    case 'appliedHeadReadback': {
      requireRole('receiver');
      const output = currentAgent.readRfc64AppliedCatalogHeadV1(
        plainRecord(command.input, 'appliedHeadReadback input') as never,
      );
      emitOperationResult(command, output);
      return;
    }
    case 'exactInventoryReadback': {
      requireRole('receiver');
      const input = plainRecord(command.input, 'exactInventoryReadback input');
      const catalogHeadDigest = requiredDigest(
        input.catalogHeadDigest,
        'exactInventoryReadback.catalogHeadDigest',
      );
      const output = currentAgent.readRfc64PublicCatalogSynchronizationEvidenceV1(
        catalogHeadDigest,
      );
      emitOperationResult(command, wireSynchronizationEvidence(output));
      return;
    }
    case 'prepareForgedAuthorizationGenesis': {
      requireRole('author');
      const output = await prepareForgedAuthorizationGenesis(
        currentAgent,
        plainRecord(command.input, 'prepareForgedAuthorizationGenesis input'),
      );
      emitOperationResult(command, output);
      return;
    }
    case 'receiverStats': {
      requireRole('receiver');
      emitOperationResult(command, currentAgent.rfc64PublicCatalogStatsV1()?.receiver ?? null);
      return;
    }
    case 'semanticGraphReadback': {
      requireRole('receiver');
      const input = plainRecord(command.input, 'semanticGraphReadback input');
      const swmGraph = requiredString(input.swmGraph, 'semanticGraphReadback.swmGraph');
      if (!/^did:dkg:context-graph:[A-Za-z0-9:._/-]+$/u.test(swmGraph)) {
        throw new TypeError('semanticGraphReadback.swmGraph is not a safe production graph IRI');
      }
      const result = await currentAgent.store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
        { source: 'rfc64-gate2-semantic-readback' },
      );
      if (result.type !== 'quads') {
        throw new Error('semantic graph readback did not return quads');
      }
      const quads = [...result.quads]
        .map((quad): Quad => ({ ...quad, graph: '' }))
        .sort(compareQuad);
      emitOperationResult(command, {
        activatedQuadCount: quads.length,
        projectionNQuads: `${quadsToNQuads(quads)}\n`,
        swmGraph,
      });
      return;
    }
    case 'contextGraphOnChainIdReadback': {
      requireRole('receiver');
      const input = plainRecord(command.input, 'contextGraphOnChainIdReadback input');
      const contextGraphId = requiredString(
        input.contextGraphId,
        'contextGraphOnChainIdReadback.contextGraphId',
      );
      assertContextGraphIdV1(contextGraphId);
      const output = await currentAgent.getContextGraphOnChainId(contextGraphId);
      emitOperationResult(command, output);
      return;
    }
    case 'vmGraphReadback': {
      requireRole('receiver');
      const input = plainRecord(command.input, 'vmGraphReadback input');
      const vmGraph = safeHarnessIri(input.vmGraph, 'vmGraphReadback.vmGraph');
      const metaGraph = safeHarnessIri(input.metaGraph, 'vmGraphReadback.metaGraph');
      const ual = safeHarnessIri(input.ual, 'vmGraphReadback.ual');
      const graphResult = await currentAgent.store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
        { source: 'rfc64-m2-public-vm-graph-readback' },
      );
      if (graphResult.type !== 'quads') {
        throw new Error('VM graph readback did not return quads');
      }
      const projection = [...graphResult.quads]
        .map((quad): Quad => ({ ...quad, graph: '' }))
        .sort(compareQuad);
      const metadataResult = await currentAgent.store.query(
        `SELECT ?p ?o WHERE { GRAPH <${metaGraph}> { <${ual}> ?p ?o } } ORDER BY ?p ?o`,
        { source: 'rfc64-m2-public-vm-metadata-readback' },
      );
      if (metadataResult.type !== 'bindings') {
        throw new Error('VM metadata readback did not return bindings');
      }
      emitOperationResult(command, {
        metadataBindings: metadataResult.bindings,
        projectionNQuads: `${quadsToNQuads(projection)}\n`,
        tripleCount: projection.length,
        vmGraph,
      });
      return;
    }
    case 'terminalFailureReadback': {
      requireRole('receiver');
      const input = plainRecord(command.input, 'terminalFailureReadback input');
      const catalogHeadDigest = requiredDigest(
        input.catalogHeadDigest,
        'terminalFailureReadback.catalogHeadDigest',
      );
      const method = (currentAgent as unknown as Record<string, unknown>)[
        'readRfc64PublicCatalogReconciliationFailureV1'
      ];
      if (typeof method !== 'function') {
        throw new Error(
          'missing read-only product API: '
            + 'DKGAgent.readRfc64PublicCatalogReconciliationFailureV1('
            + 'catalogHeadDigest: Digest32V1): '
            + '{ catalogHeadDigest: Digest32V1; errorName: string; errorCode: '
            + 'Rfc64PublicCatalogNativeReceiverErrorCodeV1 | null } | null',
        );
      }
      const output = await (method as (digest: string) => unknown).call(
        currentAgent,
        catalogHeadDigest,
      );
      emitOperationResult(command, output);
      return;
    }
    case 'awaitReceiverIdle':
      requireRole('receiver');
      await currentAgent.whenRfc64PublicCatalogReceiverIdleV1();
      emit({ event: 'receiver-idle', requestId: command.requestId });
      return;
    case 'killRestart':
      requireRole('receiver');
      // The parent process owns SIGKILL and replacement. This command only
      // establishes an explicit process-protocol boundary; it creates no fake
      // repair record and intentionally does not stop the DKGAgent.
      emit({
        event: 'kill-restart-ready',
        executedRuntimeManifest: sealGate2ExecutedRuntimeManifestV1(),
        requestId: command.requestId,
      });
      return;
    case 'stop':
      await stop(0, command.requestId);
      return;
    default:
      throw new Error(`unknown adapter command: ${command.command}`);
  }
}

type OpenGenesisInput = Parameters<DKGAgent['publishOpenAuthorCatalogGenesisV1']>[0];
type PolicyBoundGenesisInput = Parameters<DKGAgent['publishAuthorCatalogGenesisV1']>[0];
type ExactSetSuccessorInput = Parameters<DKGAgent['publishAuthorCatalogExactSetSuccessorV1']>[0];

function normalizeOpenGenesisInput(
  command: Command,
): OpenGenesisInput {
  const label = command.command;
  const input = plainRecord(command.input, `${label} input`);
  const authorPrivateKey = requiredString(
    input.authorPrivateKey,
    `${label}.authorPrivateKey`,
  );
  const networkId = requiredString(input.networkId, `${label}.networkId`);
  assertNetworkIdV1(networkId);
  const contextGraphId = requiredString(input.contextGraphId, `${label}.contextGraphId`);
  assertContextGraphIdV1(contextGraphId);
  const issuedAt = optionalTimestamp(input.issuedAt, `${label}.issuedAt`);
  const catalogIssuerDelegationEffectiveAt = canonicalTimestamp(
    input.catalogIssuerDelegationEffectiveAt,
    `${label}.catalogIssuerDelegationEffectiveAt`,
  );
  const catalogIssuerDelegationExpiresAt = canonicalTimestamp(
    input.catalogIssuerDelegationExpiresAt,
    `${label}.catalogIssuerDelegationExpiresAt`,
  );
  return {
    networkId,
    contextGraphId,
    author: new ethers.Wallet(authorPrivateKey),
    peers: [],
    ...(issuedAt === undefined ? {} : { issuedAt }),
    ...(input.subGraphName === undefined
      ? {}
      : { subGraphName: nullableSubGraphName(input.subGraphName, `${label}.subGraphName`) }),
    ...(input.policyIssuedAt === undefined
      ? {}
      : { policyIssuedAt: canonicalTimestamp(input.policyIssuedAt, `${label}.policyIssuedAt`) }),
    ...(input.policyEffectiveAt === undefined
      ? {}
      : {
        policyEffectiveAt: canonicalTimestamp(
          input.policyEffectiveAt,
          `${label}.policyEffectiveAt`,
        ),
      }),
    ...(input.ownerAuthorityEra === undefined
      ? {}
      : {
        ownerAuthorityEra: canonicalDecimalU64(
          input.ownerAuthorityEra,
          `${label}.ownerAuthorityEra`,
        ),
      }),
    catalogIssuerDelegationEffectiveAt,
    catalogIssuerDelegationExpiresAt,
  } satisfies OpenGenesisInput;
}

function normalizePolicyBoundGenesisInput(
  command: Command,
): PolicyBoundGenesisInput {
  const label = command.command;
  const input = plainRecord(command.input, `${label} input`);
  const authorPrivateKey = requiredString(
    input.authorPrivateKey,
    `${label}.authorPrivateKey`,
  );
  assertAuthorCatalogScopeV1(input.scope);
  return {
    scope: input.scope,
    author: new ethers.Wallet(authorPrivateKey),
    peers: [],
    ...(input.issuedAt === undefined
      ? {}
      : { issuedAt: canonicalTimestamp(input.issuedAt, `${label}.issuedAt`) }),
    catalogIssuerDelegationEffectiveAt: canonicalTimestamp(
      input.catalogIssuerDelegationEffectiveAt,
      `${label}.catalogIssuerDelegationEffectiveAt`,
    ),
    catalogIssuerDelegationExpiresAt: canonicalTimestamp(
      input.catalogIssuerDelegationExpiresAt,
      `${label}.catalogIssuerDelegationExpiresAt`,
    ),
  } satisfies PolicyBoundGenesisInput;
}

async function publishExactSetSuccessorVia(
  currentAgent: DKGAgent,
  command: Command,
  mode: 'open' | 'policy-bound',
): Promise<Record<string, unknown>> {
  const forwarded = normalizeExactSetSuccessorInput(command);
  const published = mode === 'open'
    ? await currentAgent.publishOpenAuthorCatalogExactSetSuccessorV1(forwarded)
    : await currentAgent.publishAuthorCatalogExactSetSuccessorV1(forwarded);
  return addDurableBundleReceipts(currentAgent, published, command.command);
}

function normalizeExactSetSuccessorInput(command: Command): ExactSetSuccessorInput {
  const label = command.command;
  const input = plainRecord(command.input, `${label} input`);
  const authorPrivateKey = requiredString(
    input.authorPrivateKey,
    `${label}.authorPrivateKey`,
  );
  const assets: ExactSetSuccessorInput['assets'] = plainArray(
    input.assets,
    `${label}.assets`,
  ).map((value, index) => {
    const assetLabel = `${label}.assets[${index}]`;
    const asset = plainRecord(value, assetLabel);
    assertAssertionCoordinateV1(asset.assertionCoordinate, `${assetLabel}.assertionCoordinate`);
    assertCanonicalGraphScopedAuthorSealV1(asset.seal);
    const projectionNQuads = requiredString(
      asset.projectionNQuads,
      `${assetLabel}.projectionNQuads`,
    );
    return Object.freeze({
      assertionCoordinate: asset.assertionCoordinate,
      projectionBytes: new TextEncoder().encode(projectionNQuads),
      seal: asset.seal,
    });
  });
  const previousHead = plainRecord(input.previousHead, `${label}.previousHead`);
  const authorization = plainRecord(
    input.catalogIssuerAuthorization,
    `${label}.catalogIssuerAuthorization`,
  );
  const catalogIssuerDelegation =
    authorization.catalogIssuerDelegation as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(catalogIssuerDelegation);
  if (authorization.parentAuthorAgentEvidence !== null) {
    throw new TypeError(`${label}.catalogIssuerAuthorization must use direct-author evidence`);
  }
  const deployment = plainRecord(input.deployment, `${label}.deployment`);
  const networkId = requiredString(deployment.networkId, `${label}.deployment.networkId`);
  assertNetworkIdV1(networkId);
  const assertedAtChainId = requiredString(
    deployment.assertedAtChainId,
    `${label}.deployment.assertedAtChainId`,
  );
  assertCanonicalChainId(assertedAtChainId, `${label}.deployment.assertedAtChainId`);
  const assertedAtKav10Address = canonicalEvmAddress(
    deployment.assertedAtKav10Address,
    `${label}.deployment.assertedAtKav10Address`,
  );
  return {
    previousHead: {
      objectDigest: requiredDigest(previousHead.objectDigest, `${label}.previousHead.objectDigest`),
      signatureVariantDigest: requiredDigest(
        previousHead.signatureVariantDigest,
        `${label}.previousHead.signatureVariantDigest`,
      ),
    },
    author: new ethers.Wallet(authorPrivateKey),
    catalogIssuerAuthorization: {
      catalogIssuerDelegation,
      parentAuthorAgentEvidence: null,
    },
    assets,
    deployment: { networkId, assertedAtChainId, assertedAtKav10Address },
    ...(input.issuedAt === undefined
      ? {}
      : { issuedAt: canonicalTimestamp(input.issuedAt, `${label}.issuedAt`) }),
    peers: [],
  } satisfies ExactSetSuccessorInput;
}

async function addDurableBundleReceipts(
  currentAgent: DKGAgent,
  published: unknown,
  label: string,
): Promise<Record<string, unknown>> {
  const result = plainRecord(published, `${label} output`);
  const outputAssets = plainArray(result.assets, `${label}.output.assets`);
  const assetsWithReceipts = await Promise.all(outputAssets.map(async (value, index) => {
    const assetLabel = `${label}.output.assets[${index}]`;
    const asset = plainRecord(value, assetLabel);
    const bundleDigest = requiredDigest(asset.bundleDigest, `${assetLabel}.bundleDigest`);
    const stagedBundle = await currentAgent.readRfc64StagedKaBundleV1(bundleDigest);
    if (stagedBundle === null) {
      throw new Error(`published bundle ${bundleDigest} is absent from durable storage`);
    }
    return Object.freeze({
      ...asset,
      stagedBundleByteLength: stagedBundle.byteLength,
    });
  }));
  return Object.freeze({ ...result, assets: Object.freeze(assetsWithReceipts) });
}

function canonicalTimestamp(
  value: unknown,
  label: string,
): NonNullable<OpenGenesisInput['issuedAt']> {
  assertCanonicalTimestampMs(value, label);
  return value;
}

function optionalTimestamp(
  value: unknown,
  label: string,
): NonNullable<OpenGenesisInput['issuedAt']> | undefined {
  return value === undefined ? undefined : canonicalTimestamp(value, label);
}

function canonicalDecimalU64(
  value: unknown,
  label: string,
): NonNullable<OpenGenesisInput['ownerAuthorityEra']> {
  assertCanonicalDecimalU64(value, label);
  return value;
}

function nullableSubGraphName(
  value: unknown,
  label: string,
): OpenGenesisInput['subGraphName'] {
  if (value === null) return null;
  assertSubGraphNameV1(value, label);
  return value;
}

function canonicalEvmAddress(value: unknown, label: string): EvmAddressV1 {
  const address = requiredString(value, label);
  if (!/^0x[0-9a-f]{40}$/u.test(address) || address === `0x${'0'.repeat(40)}`) {
    throw new TypeError(`${label} is not a canonical non-zero EVM address`);
  }
  return address as EvmAddressV1;
}

function compareQuad(left: Quad, right: Quad): number {
  const leftKey = `${left.subject}\n${left.predicate}\n${left.object}\n${left.graph}`;
  const rightKey = `${right.subject}\n${right.predicate}\n${right.object}\n${right.graph}`;
  return leftKey.localeCompare(rightKey);
}

function wireSynchronizationEvidence(output: unknown): unknown {
  if (output === null) return null;
  const evidence = plainRecord(output, 'exact synchronization evidence');
  if (evidence.inventoryRowCount === 0) return evidence;
  const wired = evidence.inventoryRowCount === 1
    ? [wireLegacySingleRowSynchronizationEvidence(evidence)]
    : plainArray(evidence.rows, 'synchronization.rows').map(
      (value, index) => wireMultiRowSynchronizationEvidence(value, index),
    );
  const verifiedControlObjectCount = requireUniformControlObjectCount(wired);
  return Object.freeze({
    inventoryDigest: evidence.inventoryDigest,
    catalogHeadDigest: evidence.catalogHeadDigest,
    inventoryRowCount: evidence.inventoryRowCount,
    activatedTripleCount: evidence.activatedTripleCount,
    appliedHeadStatus: evidence.appliedHeadStatus,
    rows: Object.freeze(wired.map((entry) => entry.row)),
    verifiedControlObjectCount,
  });
}

interface WiredSynchronizationRow {
  readonly row: Readonly<Record<string, unknown>>;
  readonly verifiedControlObjectCount: number;
}

function wireLegacySingleRowSynchronizationEvidence(
  evidence: Record<string, unknown>,
): WiredSynchronizationRow {
  const label = 'synchronization.legacySingleRow';
  const kaUal = requiredString(evidence.kaUal, `${label}.kaUal`);
  return wireSynchronizationRow(
    evidence,
    label,
    canonicalDecimalWire(packedKaIdFromUal(kaUal), `${label}.kaId`),
    null,
  );
}

function wireMultiRowSynchronizationEvidence(
  value: unknown,
  index: number,
): WiredSynchronizationRow {
  const label = `synchronization.rows[${index}]`;
  const row = plainRecord(value, label);
  return wireSynchronizationRow(
    row,
    label,
    canonicalDecimalWire(row.kaId, `${label}.kaId`),
    requiredDigest(row.sealDigest, `${label}.sealDigest`),
  );
}

function wireSynchronizationRow(
  row: Record<string, unknown>,
  label: string,
  kaId: string,
  sealDigest: Digest32V1 | null,
): WiredSynchronizationRow {
  const authorship = plainRecord(row.authorship, `${label}.authorship`);
  const path = plainArray(
    authorship.directoryPathObjectDigests,
    `${label}.authorship.directoryPathObjectDigests`,
  );
  const variants = plainArray(
    authorship.directoryPathSignatureVariantDigests,
    `${label}.authorship.directoryPathSignatureVariantDigests`,
  );
  if (path.length !== variants.length) {
    throw new Error('synchronization authorship path evidence is incomplete');
  }
  return Object.freeze({
    row: Object.freeze({
      kaId,
      catalogRowDigest: row.catalogRowDigest,
      contentDigest: row.contentDigest,
      sealDigest,
      bundleDigest: row.bundleDigest,
      kaUal: requiredString(row.kaUal, `${label}.kaUal`),
      activatedTripleCount: row.activatedTripleCount,
      swmGraph: row.swmGraph,
    }),
    verifiedControlObjectCount: 3 + path.length,
  });
}

function requireUniformControlObjectCount(
  rows: readonly WiredSynchronizationRow[],
): number {
  const first = rows[0];
  if (first === undefined) {
    throw new Error('non-empty synchronization evidence contains no exact rows');
  }
  for (const row of rows.slice(1)) {
    if (row.verifiedControlObjectCount !== first.verifiedControlObjectCount) {
      throw new Error('synchronization rows disagree on the verified control-object closure');
    }
  }
  return first.verifiedControlObjectCount;
}

function packedKaIdFromUal(kaUal: string): string {
  const parsed = parseDeterministicKnowledgeAssetUal(kaUal);
  return ((BigInt(parsed.agentAddress) << 96n) | BigInt(parsed.kaNumber)).toString();
}

function canonicalDecimalWire(value: unknown, label: string): string {
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) return value;
  throw new TypeError(`${label} is not a canonical non-negative integer`);
}

function inspectGate2ProductCapabilities(currentAgent: DKGAgent): Record<string, boolean> {
  const surface = currentAgent as unknown as Record<string, unknown>;
  return Object.freeze({
    acceptPolicySnapshot:
      typeof surface.acceptRfc64CatalogAccessSnapshotV1 === 'function',
    acceptOpenPolicy: typeof surface.acceptOpenContextGraphPolicyV1 === 'function',
    announce: typeof surface.announceRfc64PublicCatalogHeadV1 === 'function',
    appliedHeadReadback: typeof surface.readRfc64AppliedCatalogHeadV1 === 'function',
    exactInventoryReadback:
      typeof surface.readRfc64PublicCatalogSynchronizationEvidenceV1 === 'function',
    publishExactSetSuccessor:
      typeof surface.publishOpenAuthorCatalogExactSetSuccessorV1 === 'function',
    publishGenesis: typeof surface.publishOpenAuthorCatalogGenesisV1 === 'function',
    publishPolicyBoundExactSetSuccessor:
      typeof surface.publishAuthorCatalogExactSetSuccessorV1 === 'function',
    publishPolicyBoundGenesis:
      typeof surface.publishAuthorCatalogGenesisV1 === 'function',
    terminalFailureReadback:
      typeof surface.readRfc64PublicCatalogReconciliationFailureV1 === 'function',
  });
}

interface HarnessControlObjectPersistenceV1 {
  readonly controlObjects: {
    stageVerifiedObjects(input: readonly HarnessVerifiedControlObjectV1[]): Promise<{
      readonly objects: ReadonlyArray<{
        readonly objectDigest: Digest32V1;
        readonly signatureVariantDigest: Digest32V1;
      }>;
    }>;
  };
}

interface HarnessVerifiedControlObjectV1 {
  readonly envelope: SignedControlEnvelopeV1;
  readonly issuerSignature: Awaited<ReturnType<typeof verifyControlEnvelopeIssuerSignatureV1>>;
}

/**
 * Harness-only adversarial setup. Both signatures are cryptographically valid,
 * but the head claims the catalog author while naming an attacker-scoped
 * direct-author delegation. The product receiver must reject that exact scope
 * mismatch before activation or applied-head mutation.
 */
async function prepareForgedAuthorizationGenesis(
  currentAgent: DKGAgent,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const networkId = requiredString(input.networkId, 'forged.networkId');
  const contextGraphId = requiredString(input.contextGraphId, 'forged.contextGraphId');
  const policyDigest = requiredDigest(input.policyDigest, 'forged.policyDigest');
  const catalogAuthorPrivateKey = requiredString(
    input.catalogAuthorPrivateKey,
    'forged.catalogAuthorPrivateKey',
  );
  const attackerPrivateKey = requiredString(
    input.attackerPrivateKey,
    'forged.attackerPrivateKey',
  );
  const issuedAt = requiredString(input.issuedAt, 'forged.issuedAt');
  const delegationEffectiveAt = requiredString(
    input.delegationEffectiveAt,
    'forged.delegationEffectiveAt',
  );
  const delegationExpiresAt = requiredString(
    input.delegationExpiresAt,
    'forged.delegationExpiresAt',
  );
  const catalogAuthor = new ethers.Wallet(catalogAuthorPrivateKey);
  const attacker = new ethers.Wallet(attackerPrivateKey);
  const catalogAuthorAddress = catalogAuthor.address.toLowerCase() as EvmAddressV1;
  const recoveredAuthorAddress = attacker.address.toLowerCase() as EvmAddressV1;
  const attackerScope = catalogScope(
    networkId,
    contextGraphId,
    recoveredAuthorAddress,
  );
  const claimedCatalogScope = catalogScope(
    networkId,
    contextGraphId,
    catalogAuthorAddress,
  );
  const forgedDelegation = await produceDirectAuthorCatalogIssuerDelegationV1({
    scope: attackerScope,
    signer: {
      issuer: recoveredAuthorAddress,
      signDigest: (digest) => attacker.signMessage(digest),
    },
    effectiveAt: delegationEffectiveAt as never,
    expiresAt: delegationExpiresAt as never,
    catalogHeadIssuedAt: issuedAt as never,
  });
  const forgedGenesis = await produceEmptyAuthorCatalogGenesisV1({
    scope: claimedCatalogScope,
    catalogIssuerDelegationDigest:
      forgedDelegation.authorization.catalogIssuerDelegation.objectDigest as Digest32V1,
    issuedAt: issuedAt as never,
    signer: {
      issuer: catalogAuthorAddress,
      signDigest: (digest) => catalogAuthor.signMessage(digest),
    },
  });
  const persistence = (
    currentAgent as unknown as { rfc64PersistenceV1?: HarnessControlObjectPersistenceV1 }
  ).rfc64PersistenceV1;
  if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
  await persistence.controlObjects.stageVerifiedObjects([{
    envelope: forgedDelegation.authorization.catalogIssuerDelegation,
    issuerSignature: forgedDelegation.issuerSignature,
  }]);
  const verifiedObjects = await Promise.all(forgedGenesis.stagedObjects.map(async (envelope) => ({
    envelope,
    issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
  })));
  const staged = await persistence.controlObjects.stageVerifiedObjects(verifiedObjects);
  const head = forgedGenesis.head;
  const headReceipt = staged.objects.find((entry) => entry.objectDigest === head.objectDigest);
  if (
    headReceipt === undefined
    || headReceipt.signatureVariantDigest !== computeControlSignatureVariantDigestHex(
      head.objectDigest,
      head.signature,
    )
  ) {
    throw new Error('forged authorization head did not receive an exact durable stage receipt');
  }
  return Object.freeze({
    announcement: Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
      networkId: head.payload.networkId,
      contextGraphId: head.payload.contextGraphId,
      subGraphName: head.payload.subGraphName,
      authorAddress: head.payload.authorAddress,
      catalogEra: head.payload.era,
      catalogVersion: head.payload.version,
      policyDigest,
      catalogHeadObjectDigest: headReceipt.objectDigest,
      signatureVariantDigest: headReceipt.signatureVariantDigest,
    }),
    attemptedCatalogHeadDigest: headReceipt.objectDigest,
    catalogAuthorAddress,
    recoveredAuthorAddress,
  });
}

function catalogScope(
  networkId: string,
  contextGraphId: string,
  authorAddress: EvmAddressV1,
): AuthorCatalogScopeV1 {
  return Object.freeze({
    networkId,
    contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress,
    era: '0',
    bucketCount: '1',
  }) as AuthorCatalogScopeV1;
}

function emitOperationResult(command: Command, output: unknown): void {
  assertJsonWireValue(output, `${command.command} output`);
  emit({
    event: 'operation-completed',
    operation: command.command,
    output,
    requestId: command.requestId,
  });
}

function assertJsonWireValue(value: unknown, path: string, depth = 0): void {
  if (depth > 32) throw new Error(`${path} exceeds the adapter JSON depth bound`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error(`${path} exceeds the adapter array bound`);
    value.forEach((entry, index) => assertJsonWireValue(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertJsonWireValue(entry, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`${path} is not a bounded plain JSON value`);
}

async function stop(exitCode: number, requestId?: string): Promise<never> {
  if (stopping) return await new Promise<never>(() => undefined);
  stopping = true;
  try {
    await agent?.stop();
    await finalizedVmRuntime?.close();
    finalizedVmRuntime = undefined;
    if (requestId !== undefined) {
      await emitAndFlush({
        event: 'stopped',
        executedRuntimeManifest: sealGate2ExecutedRuntimeManifestV1(),
        requestId,
      });
    }
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
}

function safeHarnessIri(value: unknown, label: string): string {
  const iri = requiredString(value, label);
  if (!/^did:dkg:[A-Za-z0-9:._/-]+$/u.test(iri)) {
    throw new TypeError(`${label} is not a safe DKG IRI`);
  }
  return iri;
}

function requireAgent(): DKGAgent {
  if (agent === undefined) throw new Error('real DKGAgent is not ready');
  return agent;
}

function requireRole(expected: 'author' | 'receiver'): void {
  if (role !== expected) throw new Error(`${role} cannot handle ${expected} operation`);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function plainArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new TypeError(`${label} must be a bounded Array`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): Digest32V1 {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical digest`);
  }
  return value as Digest32V1;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

process.once('SIGTERM', () => { void stop(0); });
process.once('SIGINT', () => { void stop(130); });

await boot().catch(async (error) => {
  emit({ event: 'boot-failed', message: error instanceof Error ? error.message : String(error) });
  await stop(1);
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (Buffer.byteLength(line) > 1_000_000) {
    emit({ event: 'error', message: 'command exceeds the 1 MiB process-protocol bound' });
    return;
  }
  let command: Command;
  try {
    command = JSON.parse(line) as Command;
  } catch (error) {
    emit({ event: 'error', message: `invalid command JSON: ${String(error)}` });
    return;
  }
  commandTail = commandTail.then(() => handle(command)).catch((error) => {
    emit({
      event: 'error',
      message: error instanceof Error ? error.message : String(error),
      requestId: command.requestId,
    });
  });
});
lines.once('close', () => { void stop(0); });
