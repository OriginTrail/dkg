import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';

import {
  MemoryLayer,
  computeAuthorCatalogScopeDigestV1,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';

import { ChildProcessRegistry } from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import { Gate1AgentChild, type Gate1AgentEvent } from './agent-child.js';
import {
  GATE1_AUTHOR_ADDRESS as AUTHOR_ADDRESS,
  GATE1_AUTHOR_PRIVATE_KEY as AUTHOR_PRIVATE_KEY,
  GATE1_DEPLOYMENT as DEPLOYMENT,
  GATE1_NETWORK_ID as NETWORK_ID,
  GATE1_PROJECTION_NQUADS as PROJECTION_NQUADS,
  GATE1_PROJECTION_QUADS as PROJECTION_QUADS,
  GATE1_ROLE_MASTER_KEYS as ROLE_KEYS,
  createGate1AuthorSealV1 as authorSeal,
  createGate1CatalogScopeV1,
} from './fixture.js';
import {
  GATE1_ROLLOUT_COMMANDS,
  GATE1_VM_CHAIN_READ_KEYS,
  parseGate1RolloutCommandOutput,
  type Gate1RolloutCommand,
  Gate1RolloutMode,
  Gate1RolloutStatusResult,
  Gate1VmChainScenario,
  Gate1VmReconcileResult,
} from './rollout-process-protocol.js';
import {
  cleanupRolloutStoreFixture,
  createRolloutStoreFixture,
  parseRolloutStoreBackend,
  type RolloutStoreFixture,
} from './rollout-store-fixture.js';
import { ROLLOUT_STORE_BACKEND_ENV } from './rollout-store-config.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ADAPTER_PROCESS = join(import.meta.dirname, 'adapter-process.ts');
const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/rollout-transition';
const AUTHOR_STORE_PROBE_GRAPH =
  'did:dkg:context-graph:rfc64-rollout-author-store-probe';
const children = new ChildProcessRegistry(20_000);
const temporaryRoots: string[] = [];
const STORE_BACKEND = parseRolloutStoreBackend(process.env[ROLLOUT_STORE_BACKEND_ENV]);
let storeFixture: RolloutStoreFixture | undefined;

after(async () => {
  await children.terminateAllThenCleanup(async () => {
    await cleanupRolloutStoreFixture(storeFixture, temporaryRoots);
  });
});

test('routes every registered rollout command through its own output decoder', () => {
  const digest = `0x${'ab'.repeat(32)}`;
  const outputs: Readonly<Record<Gate1RolloutCommand, unknown>> = Object.freeze({
    writeAuthorStoreProbe: Object.freeze({
      graphUri: AUTHOR_STORE_PROBE_GRAPH,
      tripleCount: PROJECTION_QUADS.length,
    }),
    rolloutStatus: Object.freeze({
      bootstrapStarted: true,
      catalogServiceStarted: true,
      legacyConfiguredScope: false,
      manualLegacySwmTargetCount: 0,
      vmChainInventorySelected: true,
    }),
    vmReconcile: Object.freeze({
      chainReadDelta: Object.freeze(Object.fromEntries(
        GATE1_VM_CHAIN_READ_KEYS.map((key) => [key, 0]),
      )),
      replicationEvents: Object.freeze([]),
      result: Object.freeze({
        contextGraphId: CONTEXT_GRAPH_ID,
        onChainId: '1',
        source: 'manual',
        status: 'current',
        attempted: true,
        headOrdinal: 0,
        watermarkBefore: 0,
        watermarkAfter: 0,
        reconciledOrdinals: 0,
        unresolvedOrdinals: 0,
      }),
    }),
    seedVmSourceSwm: Object.freeze({ swmGraph: 'did:dkg:context-graph:test', tripleCount: 0 }),
    stagedHeadReadback: digest,
  });
  for (const command of GATE1_ROLLOUT_COMMANDS) {
    assert.doesNotThrow(() => parseGate1RolloutCommandOutput(command, outputs[command]));
    for (const otherCommand of GATE1_ROLLOUT_COMMANDS) {
      if (otherCommand === command) continue;
      assert.throws(() => parseGate1RolloutCommandOutput(command, outputs[otherCommand]));
    }
  }
});

test(`certifies restart-stable shadow, catalog, kill, re-enable, and legacy authority on ${STORE_BACKEND}`, {
  timeout: 180_000,
}, async (context) => {
  const authorDataDir = await makeTemp('author');
  const receiverDataDir = await makeTemp('receiver');
  const inactiveDataDir = await makeTemp('inactive-chain');
  const legacyDataDir = await makeTemp('legacy-fresh');
  storeFixture = await createRolloutStoreFixture({
    backendInput: process.env[ROLLOUT_STORE_BACKEND_ENV],
    blazegraphTestUrl: process.env.BLAZEGRAPH_TEST_URL,
    signal: context.signal,
    storeDataDirs: {
      author: [authorDataDir],
      receiver: [receiverDataDir, inactiveDataDir, legacyDataDir],
    },
  });
  let author = spawnAgent('author', authorDataDir, 'catalog');
  let authorReady = await author.waitFor('ready');
  assertReady(authorReady, 'catalog', false);
  await acceptPolicy(author, 'author-policy');
  const authorStoreProbe = await author.requestRollout(
    'writeAuthorStoreProbe',
    'author-store-probe',
    {
      graphUri: AUTHOR_STORE_PROBE_GRAPH,
      quads: PROJECTION_QUADS.map(({ subject, predicate, object }) => ({
        subject,
        predicate,
        object,
      })),
    },
  );
  assert.equal(authorStoreProbe.graphUri, AUTHOR_STORE_PROBE_GRAPH);
  assert.equal(authorStoreProbe.tripleCount, PROJECTION_QUADS.length);
  await author.stop('stop-author-store-probe');
  await requireStoreFixture().assertGraphExact(
    'author',
    authorDataDir,
    AUTHOR_STORE_PROBE_GRAPH,
    PROJECTION_QUADS,
  );
  author = spawnAgent('author', authorDataDir, 'catalog');
  authorReady = await author.waitFor('ready');
  assertReady(authorReady, 'catalog', false);
  await acceptPolicy(author, 'author-policy-after-store-probe');

  const genesis = output(await author.request(
    'publishGenesis',
    'publish-genesis',
    'operation-completed',
    {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      authorPrivateKey: AUTHOR_PRIVATE_KEY,
      issuedAt: '1773900000000',
      catalogIssuerDelegationEffectiveAt: '1773899999000',
      catalogIssuerDelegationExpiresAt: '1774000000000',
    },
  ));
  const successor = output(await author.request(
    'publishSuccessor',
    'publish-successor',
    'operation-completed',
    {
      previousHead: stagedHeadRef(genesis),
      authorPrivateKey: AUTHOR_PRIVATE_KEY,
      catalogIssuerAuthorization: record(genesis.catalogIssuerAuthorization, 'authorization'),
      assertionCoordinate: 'rollout-transition-object',
      projectionNQuads: PROJECTION_NQUADS,
      seal: await authorSeal(),
      deployment: DEPLOYMENT,
      issuedAt: '1773900001000',
      peers: [],
    },
  ));
  const announcement = record(successor.announcement, 'successor announcement');
  const headDigest = string(successor.headObjectDigest, 'successor head digest');
  const signatureVariantDigest = string(
    successor.signatureVariantDigest,
    'successor signature variant digest',
  );
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(
    createGate1CatalogScopeV1(CONTEXT_GRAPH_ID),
  );
  const kaUal = string(successor.kaUal, 'successor KA UAL');
  const assetScope = createGraphKnowledgeAssetScope(kaUal, '1');
  const swmGraph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.SharedWorkingMemory,
    assetScope,
  );
  const vmGraph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.VerifiableMemory,
    assetScope,
  );

  const shadow = await startReceiver(
    'shadow',
    false,
    receiverDataDir,
    author,
    authorReady,
    false,
  );
  assert.deepEqual(await rolloutStatus(
    shadow.child,
    authorReady.peerId as string,
    'shadow',
  ), expectedStatus({
    service: true,
    legacy: true,
    manualTargets: 1,
    bootstrap: true,
  }));
  const seededVmSource = await shadow.child.requestRollout(
    'seedVmSourceSwm',
    'shadow-seed-vm-source',
    { contextGraphId: CONTEXT_GRAPH_ID },
  );
  assert.equal(seededVmSource.tripleCount, 2);
  const shadowVm = await reconcileVm(shadow.child, 'shadow');
  assertVmChainRead(shadowVm, 'shadow');
  assertShadowVmEvidence(shadowVm);
  assertVmReconciled(shadowVm, 'shadow');
  assertSemanticExact(await semanticGraph(shadow.child, vmGraph, 'shadow-vm'), vmGraph);
  await connectBothWays(author, shadow.child, authorReady, shadow.ready, 'shadow-connect');
  await announceAndDrain(author, shadow.child, announcement, shadow.ready, 'shadow');
  assert.equal(await stagedHead(shadow.child, headDigest, signatureVariantDigest, 'shadow'), headDigest);
  assert.equal(await appliedHead(shadow.child, catalogScopeDigest, 'shadow'), null);
  assertSemanticExact(await semanticGraph(shadow.child, swmGraph, 'shadow'), swmGraph);
  await shadow.child.stop('stop-shadow');
  await requireStoreFixture().assertGraphExact(
    'receiver',
    receiverDataDir,
    swmGraph,
    PROJECTION_QUADS,
  );

  const catalog = await startReceiver('catalog', false, receiverDataDir, author, authorReady);
  assert.deepEqual(await rolloutStatus(
    catalog.child,
    authorReady.peerId as string,
    'catalog',
  ), expectedStatus({
    service: true,
    legacy: false,
    manualTargets: 0,
    bootstrap: true,
  }));
  await announceAndDrain(author, catalog.child, announcement, catalog.ready, 'catalog');
  assertSemanticExact(
    await semanticGraph(catalog.child, vmGraph, 'catalog-vm-before'),
    vmGraph,
  );
  const catalogVm = await reconcileVm(catalog.child, 'catalog');
  assertVmChainRead(catalogVm, 'catalog');
  const catalogVmGraph = await semanticGraph(catalog.child, vmGraph, 'catalog-vm');
  assertVmReconciled(catalogVm, 'catalog');
  assertSemanticExact(catalogVmGraph, vmGraph);
  assertAppliedExact(await appliedHead(catalog.child, catalogScopeDigest, 'catalog'), headDigest);
  assertSemanticExact(await semanticGraph(catalog.child, swmGraph, 'catalog'), swmGraph);
  await catalog.child.stop('stop-catalog');
  await requireStoreFixture().assertGraphExact(
    'receiver',
    receiverDataDir,
    swmGraph,
    PROJECTION_QUADS,
  );

  const killed = await startReceiver('catalog', true, receiverDataDir, author, authorReady, false);
  assert.deepEqual(await rolloutStatus(
    killed.child,
    authorReady.peerId as string,
    'killed',
  ), expectedStatus({
    service: false,
    legacy: false,
    manualTargets: 0,
    bootstrap: false,
  }));
  const killedVm = await reconcileVm(killed.child, 'killed');
  assertVmChainRead(killedVm, 'killed');
  assertVmReconciled(killedVm, 'killed');
  assertSemanticExact(await semanticGraph(killed.child, vmGraph, 'killed-vm'), vmGraph);
  assertAppliedExact(await appliedHead(killed.child, catalogScopeDigest, 'killed'), headDigest);
  assertSemanticExact(await semanticGraph(killed.child, swmGraph, 'killed'), swmGraph);
  await killed.child.stop('stop-killed');

  const reenabled = await startReceiver('catalog', false, receiverDataDir, author, authorReady);
  assert.deepEqual(await rolloutStatus(
    reenabled.child,
    authorReady.peerId as string,
    'reenabled',
  ), expectedStatus({
    service: true,
    legacy: false,
    manualTargets: 0,
    bootstrap: true,
  }));
  await announceAndDrain(author, reenabled.child, announcement, reenabled.ready, 'reenabled');
  const reenabledVm = await reconcileVm(reenabled.child, 'reenabled');
  assertVmChainRead(reenabledVm, 'reenabled');
  assertVmReconciled(reenabledVm, 'reenabled');
  assertSemanticExact(await semanticGraph(reenabled.child, vmGraph, 'reenabled-vm'), vmGraph);
  assertAppliedExact(await appliedHead(reenabled.child, catalogScopeDigest, 'reenabled'), headDigest);
  assertSemanticExact(await semanticGraph(reenabled.child, swmGraph, 'reenabled'), swmGraph);
  await reenabled.child.stop('stop-reenabled');

  const transitionedLegacy = await startReceiver(
    'legacy',
    false,
    receiverDataDir,
    author,
    authorReady,
    false,
  );
  assert.deepEqual(await rolloutStatus(
    transitionedLegacy.child,
    authorReady.peerId as string,
    'transitioned-legacy',
  ), expectedStatus({
    service: false,
    legacy: true,
    manualTargets: 1,
    bootstrap: true,
  }));
  assert.equal(
    await appliedHead(transitionedLegacy.child, catalogScopeDigest, 'transitioned-legacy'),
    null,
  );
  assert.equal(
    (await semanticGraph(
      transitionedLegacy.child,
      swmGraph,
      'transitioned-legacy-swm',
    )).activatedQuadCount,
    0,
  );
  const transitionedLegacyVm = await reconcileVm(
    transitionedLegacy.child,
    'transitioned-legacy',
  );
  assertVmChainRead(transitionedLegacyVm, 'transitioned-legacy');
  assertVmReconciled(transitionedLegacyVm, 'transitioned-legacy');
  assertSemanticExact(
    await semanticGraph(
      transitionedLegacy.child,
      vmGraph,
      'transitioned-legacy-vm',
    ),
    vmGraph,
  );
  await transitionedLegacy.child.stop('stop-transitioned-legacy');

  const inactive = await startReceiver(
    'shadow',
    false,
    inactiveDataDir,
    author,
    authorReady,
    false,
    'inactive',
  );
  await inactive.child.requestRollout(
    'seedVmSourceSwm',
    'inactive-seed-vm-source',
    { contextGraphId: CONTEXT_GRAPH_ID },
  );
  const inactiveVm = await reconcileVm(inactive.child, 'inactive');
  assertVmAuthorityRejected(inactiveVm, 'inactive');
  assert.equal((await semanticGraph(inactive.child, vmGraph, 'inactive-vm')).activatedQuadCount, 0);
  await inactive.child.stop('stop-inactive');

  const legacy = await startReceiver('legacy', false, legacyDataDir, author, authorReady, false);
  assert.deepEqual(await rolloutStatus(
    legacy.child,
    authorReady.peerId as string,
    'legacy',
  ), expectedStatus({
    service: false,
    legacy: true,
    manualTargets: 1,
    bootstrap: true,
  }));
  await legacy.child.requestRollout(
    'seedVmSourceSwm',
    'legacy-seed-vm-source',
    { contextGraphId: CONTEXT_GRAPH_ID },
  );
  const legacyVm = await reconcileVm(legacy.child, 'legacy');
  assertVmChainRead(legacyVm, 'legacy');
  assertVmReconciled(legacyVm, 'legacy');
  assertSemanticExact(await semanticGraph(legacy.child, vmGraph, 'legacy-vm'), vmGraph);
  assert.equal(await appliedHead(legacy.child, catalogScopeDigest, 'legacy'), null);
  assertSemanticExact(await semanticGraph(legacy.child, swmGraph, 'legacy'), swmGraph);
  await legacy.child.stop('stop-legacy');
  await author.stop('stop-author');
});

async function startReceiver(
  mode: Gate1RolloutMode,
  killSwitch: boolean,
  dataDir: string,
  author: Gate1AgentChild,
  authorReady: Gate1AgentEvent,
  connect = true,
  vmChainScenario: Gate1VmChainScenario = 'valid',
): Promise<Readonly<{ child: Gate1AgentChild; ready: Gate1AgentEvent }>> {
  const child = spawnAgent(
    'receiver',
    dataDir,
    mode,
    killSwitch,
    authorReady.peerId as string,
    vmChainScenario,
  );
  const ready = await child.waitFor('ready');
  assertReady(ready, mode, killSwitch);
  if (mode !== 'legacy' && !killSwitch) {
    await acceptPolicy(child, `${mode}-live-policy`);
  }
  if (connect) await connectBothWays(author, child, authorReady, ready, `${mode}-connect`);
  return { child, ready };
}

async function announceAndDrain(
  author: Gate1AgentChild,
  receiver: Gate1AgentChild,
  announcement: Record<string, unknown>,
  ready: Gate1AgentEvent,
  label: string,
): Promise<void> {
  const peerId = string(ready.peerId, `${label} peer ID`);
  const result = output(await author.request('announce', `${label}-announce`, 'operation-completed', {
    announcement,
    peers: [peerId],
  }));
  assert.deepEqual(
    result.announcedPeers,
    [peerId],
    `${label} announcement failed: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(result.failedPeers, [], `${label} announcement failed: ${JSON.stringify(result)}`);
  await receiver.request('awaitReceiverIdle', `${label}-idle`, 'receiver-idle');
}

async function connectBothWays(
  author: Gate1AgentChild,
  receiver: Gate1AgentChild,
  authorReady: Gate1AgentEvent,
  receiverReady: Gate1AgentEvent,
  label: string,
): Promise<void> {
  await Promise.all([
    receiver.request('dial', `${label}-receiver`, 'dialed', {
      multiaddr: authorReady.multiaddr,
      peerId: authorReady.peerId,
    }),
    author.request('dial', `${label}-author`, 'dialed', {
      multiaddr: receiverReady.multiaddr,
      peerId: receiverReady.peerId,
    }),
  ]);
}

function spawnAgent(
  role: 'author' | 'receiver',
  dataDir: string,
  mode: Gate1RolloutMode | null = null,
  killSwitch = false,
  completeSwmProvider?: string,
  vmChainScenario: Gate1VmChainScenario = 'valid',
): Gate1AgentChild {
  return new Gate1AgentChild({
    eventTimeoutMs: 60_000,
    registry: children,
    role,
    spawn: {
      command: process.execPath,
      args: ['--import', 'tsx', ADAPTER_PROCESS, role],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DKG_RFC64_GATE1_ADAPTER_DATA_DIR: dataDir,
        DKG_RFC64_GATE1_AGENT_MASTER_KEY_HEX: ROLE_KEYS[role],
        ...requireStoreFixture().envForRole(role, dataDir),
        NODE_ENV: 'production',
        ...(mode === null ? {} : {
          DKG_RFC64_ROLLOUT_MODE: mode,
          DKG_RFC64_ROLLOUT_KILL_SWITCH: killSwitch ? 'true' : 'false',
          DKG_RFC64_ROLLOUT_CONTEXT_GRAPH_ID: CONTEXT_GRAPH_ID,
          DKG_RFC64_ROLLOUT_OWNER_ADDRESS: AUTHOR_ADDRESS,
          DKG_RFC64_ROLLOUT_VM_CHAIN_SCENARIO: vmChainScenario,
          ...(completeSwmProvider === undefined
            ? {}
            : { DKG_RFC64_ROLLOUT_COMPLETE_SWM_PROVIDER: completeSwmProvider }),
          DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS: '600000',
        }),
      },
    },
  });
}

async function acceptPolicy(child: Gate1AgentChild, requestId: string): Promise<void> {
  const accepted = output(await child.request('acceptOpenPolicy', requestId, 'operation-completed', {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR_ADDRESS,
  }));
  assert.match(string(accepted.policyDigest, 'policy digest'), /^0x[0-9a-f]{64}$/u);
}

async function rolloutStatus(
  child: Gate1AgentChild,
  completeProviderPeerId: string,
  label: string,
): Promise<Gate1RolloutStatusResult> {
  return child.requestRollout('rolloutStatus', `${label}-status`, {
    contextGraphId: CONTEXT_GRAPH_ID,
    completeProviderPeerId,
  });
}

async function reconcileVm(
  child: Gate1AgentChild,
  label: string,
): Promise<Gate1VmReconcileResult> {
  return child.requestRollout('vmReconcile', `${label}-vm-reconcile`, {
    contextGraphId: CONTEXT_GRAPH_ID,
  });
}

function assertVmChainRead(value: Gate1VmReconcileResult, label: string): void {
  const reads = value.chainReadDelta;
  assert.equal(reads.nameHashResolution >= 2, true, `${label} omitted name-hash resolution`);
  assert.equal(reads.count >= 1, true, `${label} omitted chain inventory count`);
  const result = value.result;
  assert.equal(result.contextGraphId, CONTEXT_GRAPH_ID);
  assert.equal(result.source, 'manual');
}

function assertShadowVmEvidence(value: Gate1VmReconcileResult): void {
  const reads = value.chainReadDelta;
  for (const key of [
    'accessPolicy',
    'active',
    'author',
    'kaAt',
    'latestRoot',
    'publisher',
    'rootCount',
    'storageAddress',
  ] as const) {
    assert.equal(reads[key] >= 1, true, `shadow did not perform required ${key} chain read`);
  }
  assert.equal(
    value.replicationEvents.some((event) => (
      event.action === 'promote'
      && event.contextGraphId === CONTEXT_GRAPH_ID
      && event.ordinal === 0
    )),
    true,
    `shadow emitted no exact promotion event: ${JSON.stringify(value.replicationEvents)}`,
  );
}

function assertVmReconciled(value: Gate1VmReconcileResult, label: string): void {
  const result = value.result;
  assert.equal(
    result.status,
    'current',
    `${label} VM reconcile evidence: ${JSON.stringify(value)}`,
  );
  assert.equal(result.headOrdinal, 1);
  assert.equal(result.watermarkAfter, 1);
  assert.equal(result.unresolvedOrdinals, 0);
}

function assertVmAuthorityRejected(value: Gate1VmReconcileResult, label: string): void {
  assert.equal(value.chainReadDelta.active >= 1, true);
  assert.equal(value.chainReadDelta.accessPolicy >= 1, true);
  assert.equal(
    value.replicationEvents.some((event) => event.action === 'promote'),
    false,
    `${label} unexpectedly emitted a VM promotion`,
  );
  assert.equal(value.result.status, 'pending');
  assert.equal(value.result.watermarkAfter, 0);
  assert.equal(value.result.unresolvedOrdinals, 1);
}

function expectedStatus(input: Readonly<{
  service: boolean;
  legacy: boolean;
  manualTargets: number;
  bootstrap: boolean;
}>): Gate1RolloutStatusResult {
  return {
    bootstrapStarted: input.bootstrap,
    catalogServiceStarted: input.service,
    legacyConfiguredScope: input.legacy,
    manualLegacySwmTargetCount: input.manualTargets,
    vmChainInventorySelected: true,
  };
}

async function stagedHead(
  child: Gate1AgentChild,
  objectDigest: string,
  signatureVariantDigest: string,
  label: string,
): Promise<unknown> {
  return child.requestRollout(
    'stagedHeadReadback',
    `${label}-staged`,
    { objectDigest, signatureVariantDigest },
  );
}

async function appliedHead(
  child: Gate1AgentChild,
  catalogScopeDigest: string,
  label: string,
): Promise<unknown> {
  return (await child.request(
    'appliedHeadReadback',
    `${label}-applied`,
    'operation-completed',
    { catalogScopeDigest, authorAddress: AUTHOR_ADDRESS },
  )).output;
}

async function semanticGraph(
  child: Gate1AgentChild,
  swmGraph: string,
  label: string,
): Promise<Record<string, unknown>> {
  return output(await child.request(
    'semanticGraphReadback',
    `${label}-semantic`,
    'operation-completed',
    { swmGraph },
  ));
}

function assertAppliedExact(value: unknown, headDigest: string): void {
  const applied = record(value, 'applied head');
  assert.equal(applied.currentCatalogHeadDigest, headDigest);
  assert.equal(applied.catalogVersion, '1');
  assert.equal(applied.inventoryRowCount, '1');
}

function assertSemanticExact(value: Record<string, unknown>, swmGraph: string): void {
  assert.equal(value.activatedQuadCount, 2);
  assert.equal(value.projectionNQuads, PROJECTION_NQUADS);
  assert.equal(value.swmGraph, swmGraph);
}

function assertReady(
  event: Gate1AgentEvent,
  mode: Gate1RolloutMode | null,
  killSwitch: boolean,
): void {
  assert.equal(event.agentClass, 'DKGAgent');
  assert.equal(event.rolloutMode, mode);
  assert.equal(event.rolloutKillSwitch, killSwitch);
  assert.equal(event.storeBackend, STORE_BACKEND);
  assert.equal(typeof event.peerId, 'string');
  assert.equal(typeof event.multiaddr, 'string');
}

function stagedHeadRef(value: Record<string, unknown>): Record<string, unknown> {
  return {
    objectDigest: string(value.headObjectDigest, 'genesis head digest'),
    signatureVariantDigest: string(
      value.signatureVariantDigest,
      'genesis signature variant digest',
    ),
  };
}

function output(event: Gate1AgentEvent): Record<string, unknown> {
  return record(event.output, `${event.requestId ?? event.event} output`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} missing`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

async function makeTemp(role: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dkg-rfc64-rollout-${role}-`));
  temporaryRoots.push(path);
  return path;
}

function requireStoreFixture(): RolloutStoreFixture {
  if (storeFixture === undefined) throw new Error('rollout store fixture is not prepared');
  return storeFixture;
}
