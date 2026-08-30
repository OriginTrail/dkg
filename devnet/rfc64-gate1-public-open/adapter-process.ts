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
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import {
  computeControlSignatureVariantDigestHex,
  assertSafeIri,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  createTripleStore,
  quadsToNQuads,
  type Quad,
} from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

import {
  GATE1_ADAPTER_PROTOCOL_VERSION,
  GATE1_AGENT_EVENT_PREFIX,
  GATE1_REAL_DKG_AGENT_ADAPTER_ID,
  type Gate1ProductionAdapterOperation,
} from './model.js';
import {
  inspectGate1ProductCapabilities,
  requireGate1ProductMethod,
} from './product-capabilities.js';
import {
  GATE1_DEPLOYMENT,
} from './fixture.js';
import {
  Gate1RolloutAdapterFixture,
  parseGate1RolloutAdapterConfig,
} from './rollout-adapter-fixture.js';
import {
  buildGate1RolloutStoreConfig,
  ROLLOUT_BLAZEGRAPH_URL_ENV,
  ROLLOUT_STORE_BACKEND_ENV,
  ROLLOUT_STORE_SENTINEL_GRAPH_ENV,
} from './rollout-store-config.js';

const roleInput = process.argv[2];
const dataDirInput = process.env.DKG_RFC64_GATE1_ADAPTER_DATA_DIR;
const masterKeyHex = process.env.DKG_RFC64_GATE1_AGENT_MASTER_KEY_HEX;
if (roleInput !== 'author' && roleInput !== 'receiver') throw new Error('adapter role is required');
if (!dataDirInput) throw new Error('DKG_RFC64_GATE1_ADAPTER_DATA_DIR is required');
if (!masterKeyHex || !/^[0-9a-f]{64}$/u.test(masterKeyHex)) {
  throw new Error('DKG_RFC64_GATE1_AGENT_MASTER_KEY_HEX must be 32 lowercase hex bytes');
}

const dataDir = resolve(dataDirInput);
const role: 'author' | 'receiver' = roleInput;
const storeConfig = buildGate1RolloutStoreConfig({
  backendInput: process.env[ROLLOUT_STORE_BACKEND_ENV],
  blazegraphUrl: process.env[ROLLOUT_BLAZEGRAPH_URL_ENV],
  dataDir,
});
const storeBackend = storeConfig.backend;
const storeSentinelGraphInput = process.env[ROLLOUT_STORE_SENTINEL_GRAPH_ENV];
if (storeSentinelGraphInput === undefined || storeSentinelGraphInput.length === 0) {
  throw new Error(`${ROLLOUT_STORE_SENTINEL_GRAPH_ENV} is required`);
}
const storeSentinelGraph = assertSafeIri(storeSentinelGraphInput);
const pinnedMasterKeyHex = masterKeyHex;
const rolloutConfig = parseGate1RolloutAdapterConfig(process.env);
const rolloutMode = rolloutConfig?.mode ?? null;
const rolloutKillSwitch = rolloutConfig?.killSwitch ?? false;
let agent: DKGAgent | undefined;
let rolloutFixture: Gate1RolloutAdapterFixture | undefined;
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
    throw new Error('Gate 1 adapter event exceeds the 1 MiB process-protocol bound');
  }
  process.stdout.write(`${GATE1_AGENT_EVENT_PREFIX}${line}\n`);
}

async function emitAndFlush(event: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ role, ...event });
  if (Buffer.byteLength(line) > 1_000_000) {
    throw new Error('Gate 1 adapter event exceeds the 1 MiB process-protocol bound');
  }
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(`${GATE1_AGENT_EVENT_PREFIX}${line}\n`, (error) => {
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
  const store = await createTripleStore(storeConfig.tripleStore);
  const storeSentinelVerified = await store.hasGraph(storeSentinelGraph);
  if (!storeSentinelVerified) {
    await store.close();
    throw new Error(`selected store does not contain fixture sentinel ${storeSentinelGraph}`);
  }
  rolloutFixture = rolloutConfig === null
    ? undefined
    : await Gate1RolloutAdapterFixture.create(rolloutConfig, role, store);
  const created = await DKGAgent.create({
    name: `RFC64Gate1${role}`,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store,
    syncSharedMemoryOnConnect: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
    ...(rolloutFixture === undefined ? {
      syncReconcilerEnabled: false,
      rfc64CatalogDeploymentProfile: GATE1_DEPLOYMENT,
    } : rolloutFixture.agentOptions),
  });
  agent = created;
  await created.start();
  const tcp = created.multiaddrs.find((address) => address.includes('/tcp/'));
  if (tcp === undefined) throw new Error('real DKGAgent exposed no TCP multiaddr');
  emit({
    adapterId: GATE1_REAL_DKG_AGENT_ADAPTER_ID,
    agentClass: created.constructor.name,
    capabilities: inspectGate1ProductCapabilities(created),
    catalogServiceStarted: created.rfc64PublicCatalogStatsV1()?.started === true,
    event: 'ready',
    multiaddr: tcp,
    peerId: created.peerId,
    protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
    rolloutKillSwitch,
    rolloutMode,
    storeBackend,
    storeSentinelVerified,
    startupRepair: null,
  });
}

async function handle(command: Command): Promise<void> {
  if (typeof command.requestId !== 'string' || command.requestId.length === 0) {
    throw new Error('requestId is required');
  }
  const currentAgent = requireAgent();
  if (rolloutFixture?.supportsCommand(command.command) === true) {
    requireRole('receiver');
    emitOperationResult(command, await rolloutFixture.dispatch(
      currentAgent,
      command.command,
      command.input,
    ));
    return;
  }
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
    case 'publishGenesis':
    case 'publishSuccessor': {
      requireRole('author');
      const input = plainRecord(command.input, `${command.command} input`);
      const authorPrivateKey = requiredString(
        input.authorPrivateKey,
        `${command.command}.authorPrivateKey`,
      );
      const author = new ethers.Wallet(authorPrivateKey);
      const forwarded: Record<string, unknown> = { ...input, author };
      delete forwarded.authorPrivateKey;
      // Publication and announcement are separate frozen operations. Genesis's
      // legacy combined API is driven with an empty peer set to preserve that boundary.
      if (command.command === 'publishGenesis') forwarded.peers = [];
      if (typeof forwarded.projectionNQuads === 'string') {
        forwarded.projectionBytes = new TextEncoder().encode(forwarded.projectionNQuads);
        delete forwarded.projectionNQuads;
      }
      const method = requireGate1ProductMethod(currentAgent, command.command);
      const output = await method(forwarded);
      if (command.command === 'publishSuccessor') {
        const result = plainRecord(output, 'publishSuccessor output');
        const bundleDigest = requiredDigest(result.bundleDigest, 'publishSuccessor.bundleDigest');
        const stagedBundle = await currentAgent.readRfc64StagedKaBundleV1(bundleDigest);
        if (stagedBundle === null) {
          throw new Error('published successor bundle is absent from durable product storage');
        }
        emitOperationResult(command, {
          ...result,
          stagedBundleByteLength: stagedBundle.byteLength,
        });
      } else {
        emitOperationResult(command, output);
      }
      return;
    }
    case 'announce':
    case 'appliedHeadReadback': {
      const requiredRole = command.command === 'announce' ? 'author' : 'receiver';
      requireRole(requiredRole);
      const method = requireGate1ProductMethod(
        currentAgent,
        command.command as Exclude<Gate1ProductionAdapterOperation, 'killRestart'>,
      );
      const output = await method(plainRecord(command.input, `${command.command} input`));
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
        { source: 'rfc64-gate1-semantic-readback' },
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
      emit({ event: 'kill-restart-ready', requestId: command.requestId });
      return;
    case 'stop':
      await stop(0, command.requestId);
      return;
    default:
      throw new Error(`unknown adapter command: ${command.command}`);
  }
}

function compareQuad(left: Quad, right: Quad): number {
  const leftKey = `${left.subject}\n${left.predicate}\n${left.object}\n${left.graph}`;
  const rightKey = `${right.subject}\n${right.predicate}\n${right.object}\n${right.graph}`;
  return leftKey.localeCompare(rightKey);
}

function wireSynchronizationEvidence(output: unknown): unknown {
  if (output === null) return null;
  const evidence = plainRecord(output, 'exact synchronization evidence');
  if (evidence.inventoryRowCount !== 1) return evidence;
  const authorship = plainRecord(evidence.authorship, 'synchronization authorship');
  const path = authorship.directoryPathObjectDigests;
  const variants = authorship.directoryPathSignatureVariantDigests;
  if (!Array.isArray(path) || !Array.isArray(variants) || path.length !== variants.length) {
    throw new Error('synchronization authorship path evidence is incomplete');
  }
  const { authorship: _authorship, ...wire } = evidence;
  return Object.freeze({
    ...wire,
    verifiedControlObjectCount: 3 + path.length,
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
    if (requestId !== undefined) {
      await emitAndFlush({ event: 'stopped', requestId });
    }
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
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
