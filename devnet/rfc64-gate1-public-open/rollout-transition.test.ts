import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';

import {
  MemoryLayer,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import { ChildProcessRegistry } from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import { Gate1AgentChild, type Gate1AgentEvent } from './agent-child.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ADAPTER_PROCESS = join(import.meta.dirname, 'adapter-process.ts');
const NETWORK_ID = 'otp:20430';
const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/rollout-transition';
const AUTHOR_PRIVATE_KEY = `0x${'64'.repeat(32)}`;
const AUTHOR_WALLET = new ethers.Wallet(AUTHOR_PRIVATE_KEY);
const AUTHOR_ADDRESS = AUTHOR_WALLET.address.toLowerCase();
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
});
const PROJECTION_NQUADS =
  '<https://example.org/alice> <https://schema.org/age> '
    + '"42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
    + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
const ROLE_KEYS = Object.freeze({ author: '1a'.repeat(32), receiver: '2b'.repeat(32) });
const children = new ChildProcessRegistry(20_000);
const temporaryRoots: string[] = [];

type RolloutMode = 'legacy' | 'shadow' | 'catalog';

after(async () => {
  await children.terminateAllThenCleanup(async () => {
    await Promise.all(temporaryRoots.splice(0).map((path) => (
      rm(path, { force: true, recursive: true })
    )));
  });
});

test('certifies restart-stable shadow, catalog, kill, re-enable, and legacy authority', {
  timeout: 180_000,
}, async () => {
  const authorDataDir = await makeTemp('author');
  const receiverDataDir = await makeTemp('receiver');
  const author = spawnAgent('author', authorDataDir, 'catalog');
  const authorReady = await author.waitFor('ready');
  assertReady(authorReady, 'catalog', false);
  await acceptPolicy(author, 'author-policy');

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
  const kaUal = string(successor.kaUal, 'successor KA UAL');
  const swmGraph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.SharedWorkingMemory,
    createGraphKnowledgeAssetScope(kaUal, '1'),
  );

  const shadow = await startReceiver('shadow', false, receiverDataDir, author, authorReady);
  assert.deepEqual(await rolloutStatus(shadow.child, 'shadow'), expectedStatus({
    service: true,
    legacy: true,
    manualTargets: 0,
    bootstrap: true,
  }));
  await announceAndDrain(author, shadow.child, announcement, shadow.ready, 'shadow');
  assert.equal(await stagedHead(shadow.child, headDigest, signatureVariantDigest, 'shadow'), headDigest);
  assert.equal(await appliedHead(shadow.child, catalogScopeDigest, 'shadow'), null);
  assert.equal((await semanticGraph(shadow.child, swmGraph, 'shadow')).activatedQuadCount, 0);
  await shadow.child.stop('stop-shadow');

  const catalog = await startReceiver('catalog', false, receiverDataDir, author, authorReady);
  assert.deepEqual(await rolloutStatus(catalog.child, 'catalog'), expectedStatus({
    service: true,
    legacy: false,
    manualTargets: 0,
    bootstrap: true,
  }));
  await announceAndDrain(author, catalog.child, announcement, catalog.ready, 'catalog');
  assertAppliedExact(await appliedHead(catalog.child, catalogScopeDigest, 'catalog'), headDigest);
  assertSemanticExact(await semanticGraph(catalog.child, swmGraph, 'catalog'), swmGraph);
  await catalog.child.stop('stop-catalog');

  const killed = await startReceiver('catalog', true, receiverDataDir, author, authorReady, false);
  assert.deepEqual(await rolloutStatus(killed.child, 'killed'), expectedStatus({
    service: false,
    legacy: false,
    manualTargets: 0,
    bootstrap: false,
  }));
  assertAppliedExact(await appliedHead(killed.child, catalogScopeDigest, 'killed'), headDigest);
  assertSemanticExact(await semanticGraph(killed.child, swmGraph, 'killed'), swmGraph);
  await killed.child.stop('stop-killed');

  const reenabled = await startReceiver('catalog', false, receiverDataDir, author, authorReady);
  assert.deepEqual(await rolloutStatus(reenabled.child, 'reenabled'), expectedStatus({
    service: true,
    legacy: false,
    manualTargets: 0,
    bootstrap: true,
  }));
  await announceAndDrain(author, reenabled.child, announcement, reenabled.ready, 'reenabled');
  assertAppliedExact(await appliedHead(reenabled.child, catalogScopeDigest, 'reenabled'), headDigest);
  assertSemanticExact(await semanticGraph(reenabled.child, swmGraph, 'reenabled'), swmGraph);
  await reenabled.child.stop('stop-reenabled');

  const legacy = await startReceiver('legacy', false, receiverDataDir, author, authorReady, false);
  assert.deepEqual(await rolloutStatus(legacy.child, 'legacy'), expectedStatus({
    service: false,
    legacy: true,
    manualTargets: 0,
    bootstrap: false,
  }));
  assertAppliedExact(await appliedHead(legacy.child, catalogScopeDigest, 'legacy'), headDigest);
  assertSemanticExact(await semanticGraph(legacy.child, swmGraph, 'legacy'), swmGraph);
  await legacy.child.stop('stop-legacy');
  await author.stop('stop-author');
});

async function startReceiver(
  mode: RolloutMode,
  killSwitch: boolean,
  dataDir: string,
  author: Gate1AgentChild,
  authorReady: Gate1AgentEvent,
  connect = true,
): Promise<Readonly<{ child: Gate1AgentChild; ready: Gate1AgentEvent }>> {
  const child = spawnAgent('receiver', dataDir, mode, killSwitch);
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
  mode: RolloutMode | null = null,
  killSwitch = false,
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
        NODE_ENV: 'production',
        ...(mode === null ? {} : {
          DKG_RFC64_ROLLOUT_MODE: mode,
          DKG_RFC64_ROLLOUT_KILL_SWITCH: killSwitch ? 'true' : 'false',
          DKG_RFC64_ROLLOUT_CONTEXT_GRAPH_ID: CONTEXT_GRAPH_ID,
          DKG_RFC64_ROLLOUT_OWNER_ADDRESS: AUTHOR_ADDRESS,
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

async function rolloutStatus(child: Gate1AgentChild, label: string): Promise<unknown> {
  return output(await child.request('rolloutStatus', `${label}-status`, 'operation-completed', {
    contextGraphId: CONTEXT_GRAPH_ID,
  }));
}

function expectedStatus(input: Readonly<{
  service: boolean;
  legacy: boolean;
  manualTargets: number;
  bootstrap: boolean;
}>): Record<string, unknown> {
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
  return (await child.request(
    'stagedHeadReadback',
    `${label}-staged`,
    'operation-completed',
    { objectDigest, signatureVariantDigest },
  )).output;
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
  mode: RolloutMode | null,
  killSwitch: boolean,
): void {
  assert.equal(event.agentClass, 'DKGAgent');
  assert.equal(event.rolloutMode, mode);
  assert.equal(event.rolloutKillSwitch, killSwitch);
  assert.equal(typeof event.peerId, 'string');
  assert.equal(typeof event.multiaddr, 'string');
}

async function authorSeal(): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaNumber = 7n;
  const kaId = ((BigInt(AUTHOR_ADDRESS) << 96n) | kaNumber).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address as never,
    merkleRoot: ethers.getBytes(
      '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
    ),
    authorAddress: AUTHOR_ADDRESS as never,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot:
      '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
    authorAddress: AUTHOR_ADDRESS,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: DEPLOYMENT.assertedAtKav10Address,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR_ADDRESS}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
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
