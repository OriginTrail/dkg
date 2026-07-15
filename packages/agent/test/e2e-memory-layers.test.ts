/**
 * E2E tests for the DKG V10 memory layer progression:
 *
 * 1. Working Memory → SWM: assertion promote moves data to shared memory
 * 2. SWM → Verifiable Memory: publishFromSharedMemory anchors on-chain
 * 3. Full pipeline: WM → promote → SWM gossip → publishFromSharedMemory → VM
 * 4. Memory layer isolation: data in one layer doesn't leak to another
 * 5. Two-node flow: A promotes to SWM → gossip to B → A publishes → B finalizes
 * 6. SWM query view vs default view
 * 7. Working memory view
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { DKGAgent, type DKGAgentConfig } from '../src/index.js';
import { SEAL_CAPABILITY_GAP_CODE } from '../src/dkg-agent-publish.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';
import { TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';
import {
  assertionLifecycleUri,
  contextGraphMetaUri,
  contextGraphAssertionUri,
  contextGraphLayerUri,
  ASSERTION_SEAL_PREDICATES,
  ASSERTION_PUBLISH_RECEIPT_PREDICATES,
  createOperationContext,
  MemoryLayer,
} from '@origintrail-official/dkg-core';

const agents: DKGAgent[] = [];

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

afterEach(async () => {
  for (const a of agents) {
    try { await a.stop(); } catch {}
  }
  agents.length = 0;
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const CG_ID = 'memory-layers-e2e';
const ENTITY_BASE = 'urn:mem:entity';

async function createAgent(name: string, overrides: Partial<DKGAgentConfig> = {}) {
  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  const agent = await DKGAgent.create({
    ...overrides,
    kaNumberAllocator: makeTestKaNumberAllocator(),
    name,
    listenPort: 0,
    chainAdapter: chain,
    nodeRole: 'core',
  });
  agents.push(agent);
  await agent.start();
  await installHardhatACKProvider(agent, chain);
  return agent;
}

describe('Memory layer isolation (single agent)', () => {
  it('resolveByKaId recovers a non-default lifecycle author from the KA record', async () => {
    const agent = await createAgent('ForeignAuthorResolverBot');
    const metaGraph = contextGraphMetaUri(CG_ID);
    const DKG = 'http://dkg.io/ontology/';
    const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
    const foreignAuthor = ethers.getAddress('0x00000000000000000000000000000000000000aa');
    const defaultAuthor = agent.defaultAgentAddress ?? agent.peerId;
    const name = 'foreign-author-ka';
    const decoyName = 'default-author-decoy';
    const kaNumber = 987654n;
    const packedKaId = (BigInt(foreignAuthor) << 96n) | kaNumber;
    const lifecycleUri = assertionLifecycleUri(CG_ID, foreignAuthor, name);
    const decoyLifecycleUri = assertionLifecycleUri(CG_ID, defaultAuthor, decoyName);
    const vmGraph = contextGraphLayerUri(CG_ID, MemoryLayer.VerifiableMemory, foreignAuthor.toLowerCase(), kaNumber);

    await (agent as any).store.insert([
      { subject: decoyLifecycleUri, predicate: `${DKG}kaId`, object: `"${kaNumber}"^^<${XSD_INT}>`, graph: metaGraph },
      { subject: decoyLifecycleUri, predicate: `${DKG}assertionName`, object: `"${decoyName}"`, graph: metaGraph },
      { subject: decoyLifecycleUri, predicate: `${DKG}state`, object: '"published"', graph: metaGraph },
      { subject: decoyLifecycleUri, predicate: `${DKG}memoryLayer`, object: `"${MemoryLayer.VerifiableMemory}"`, graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}kaId`, object: `"${kaNumber}"^^<${XSD_INT}>`, graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}assertionName`, object: `"${name}"`, graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}state`, object: '"published"', graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}memoryLayer`, object: `"${MemoryLayer.VerifiableMemory}"`, graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}assertionGraph`, object: vmGraph, graph: metaGraph },
      { subject: lifecycleUri, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `did:dkg:agent:${foreignAuthor.toLowerCase()}`, graph: metaGraph },
    ]);

    const desc = await (agent as any).assertion.resolveByKaId(CG_ID, packedKaId);

    expect(desc).toBeTruthy();
    expect(desc.agentAddress).toBe(foreignAuthor);
    expect(desc.agentAddress.toLowerCase()).not.toBe(defaultAuthor.toLowerCase());
    expect(desc.name).toBe(name);
    expect(desc.memoryLayer).toBe(MemoryLayer.VerifiableMemory);
  });

  it('WM data is not visible in SWM or default data graph', async () => {
    const agent = await createAgent('IsolationBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Memory Layers E2E' });

    // Write to working memory
    await agent.assertion.create(CG_ID, 'wm-only');
    await agent.assertion.write(CG_ID, 'wm-only', [
      { subject: `${ENTITY_BASE}:wm`, predicate: 'http://schema.org/name', object: '"WM Only"' },
    ]);

    // Visible in WM
    const wmQuads = await agent.assertion.query(CG_ID, 'wm-only');
    expect(wmQuads.length).toBe(1);

    // Not in SWM
    const swm = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:wm> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swm.bindings.length).toBe(0);

    // Not in default data graph
    const data = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:wm> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(data.bindings.length).toBe(0);
  }, 15_000);

  it('SWM data is not visible in default data graph', async () => {
    const agent = await createAgent('SWMIsolationBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Memory Layers E2E' });

    await agent.share(CG_ID, [
      { subject: `${ENTITY_BASE}:swm`, predicate: 'http://schema.org/name', object: '"SWM Only"', graph: '' },
    ], { localOnly: true });

    // Visible in SWM
    const swm = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:swm> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swm.bindings.length).toBe(1);

    // Not in default data graph
    const data = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:swm> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(data.bindings.length).toBe(0);
  }, 15_000);

  it('published data is in data graph but not SWM', async () => {
    const agent = await createAgent('PublishedBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Memory Layers E2E' });

    const quads = [
      { subject: `${ENTITY_BASE}:pub`, predicate: 'http://schema.org/name', object: '"Published"', graph: '' },
    ];
    await agent.publish(CG_ID, quads);

    // Visible in data graph
    const data = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:pub> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(data.bindings.length).toBe(1);
  }, 15_000);
});

describe('WM → SWM → VM pipeline (single agent)', () => {
  it('replays an exact SWM share idempotently after the first response is lost', async () => {
    const agent = await createAgent('AtomicShareReplayBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Atomic Share Replay E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'atomic-share-replay';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:replay`, predicate: 'http://schema.org/name', object: '"Replay"' },
    ]);

    const first = await agent.assertion.promote(CG_ID, name);
    expect(first.promotedCount).toBeGreaterThan(0);
    expect(first.publishReady).toBe(true);
    expect(first.shareOperationId).toBeTruthy();

    const replay = await agent.assertion.promote(CG_ID, name);
    expect(replay).toMatchObject({
      promotedCount: 0,
      sealed: true,
      publishReady: true,
      shareOperationId: first.shareOperationId,
    });
  }, 60_000);

  it('promotes assertion to SWM, then publishes SWM to verifiable memory', async () => {
    const agent = await createAgent('PipelineBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Pipeline E2E' });
    await agent.registerContextGraph(CG_ID);

    // Step 1: Write to working memory
    await agent.assertion.create(CG_ID, 'pipeline');
    await agent.assertion.write(CG_ID, 'pipeline', [
      { subject: `${ENTITY_BASE}:pipeline`, predicate: 'http://schema.org/name', object: '"Pipeline Entity"' },
      { subject: `${ENTITY_BASE}:pipeline`, predicate: 'http://schema.org/version', object: '"v1"' },
    ]);

    const wmQuads = await agent.assertion.query(CG_ID, 'pipeline');
    expect(wmQuads.length).toBe(2);

    // Step 2: Promote to SWM
    const promoteResult = await agent.assertion.promote(CG_ID, 'pipeline');
    expect(promoteResult.promotedCount).toBeGreaterThan(0);

    const swmResult = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:pipeline> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swmResult.bindings.length).toBe(1);
    expect(swmResult.bindings[0]?.['name']).toBe('"Pipeline Entity"');

    // Step 3: Publish from SWM to verifiable memory
    const pubResult = await agent.publishFromSharedMemory(CG_ID, 'all');
    expect(pubResult.status).toBe('confirmed');
    expect(pubResult.ual).toBeDefined();

    // Verify data is now in the canonical data graph
    const dataResult = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:pipeline> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(dataResult.bindings.length).toBe(1);
  }, 20_000);

  it('promote auto-finalizes: publishFromFinalizedAssertion works after a bare promote (no explicit finalize)', async () => {
    // Regression for the UI/HTTP flow: "Promote All → Shared" then "Publish to
    // Verifiable Memory" promotes WM→SWM with NO explicit finalize, and the
    // publish runs publishFromFinalizedAssertion, which requires a seal.
    // Because promote empties WM, you cannot finalize afterwards — so promote
    // now seals BEFORE moving WM→SWM. Pre-fix this threw
    // "publishFromFinalizedAssertion: assertion <...> is not finalized".
    const agent = await createAgent('AutoFinalizeBot');
    await agent.createContextGraph({ id: CG_ID, name: 'AutoFinalize E2E' });
    await agent.registerContextGraph(CG_ID);

    await agent.assertion.create(CG_ID, 'auto-final');
    await agent.assertion.write(CG_ID, 'auto-final', [
      { subject: `${ENTITY_BASE}:auto`, predicate: 'http://schema.org/name', object: '"Auto Finalized"' },
    ]);

    // Promote WITHOUT an explicit finalize() — the exact gap that broke the UI.
    const promoteResult = await agent.assertion.promote(CG_ID, 'auto-final');
    expect(promoteResult.promotedCount).toBeGreaterThan(0);

    // publishFromFinalizedAssertion hard-requires the seal; it must now find
    // the one promote stamped, instead of throwing "is not finalized".
    const pub = await agent.publishFromFinalizedAssertion(CG_ID, 'auto-final');
    expect(pub.status).toBe('confirmed');
    expect(pub.ual).toBeDefined();
    expect(pub.seal).toBeDefined();

    // RC.17 Bug #1 regression (SUBSTRATE-2): a confirmed publish must re-point
    // dkg:assertionGraph in _meta at the per-KA verifiable-memory graph it just
    // wrote (…/_verifiable_memory/{author}/{number}). promote() leaves the pointer
    // on the SWM bucket, which the post-confirm SWM cleanup then EMPTIES — so
    // without the re-stamp the _meta index follows a stale pointer to an empty
    // graph and descriptor reads return no triples. The publish derives the VM
    // graph from the minted kaId, so we re-derive it the same way and assert the
    // pointer AND the data agree.
    const ASSERTION_GRAPH_PRED = 'http://dkg.io/ontology/assertionGraph';
    const author = agent.defaultAgentAddress ?? agent.peerId;
    const lifecycleUri = assertionLifecycleUri(CG_ID, author, 'auto-final');
    const metaGraph = contextGraphMetaUri(CG_ID);
    const kaId = BigInt(pub.kaId!);
    const expectedVmGraph = contextGraphLayerUri(
      CG_ID,
      MemoryLayer.VerifiableMemory,
      '0x' + (kaId >> 96n).toString(16).padStart(40, '0'),
      kaId & ((1n << 96n) - 1n),
    );
    const ptrRes = await (agent as any).store.query(
      `SELECT ?o WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${ASSERTION_GRAPH_PRED}> ?o } } LIMIT 1`,
    );
    expect(ptrRes.type).toBe('bindings');
    expect(ptrRes.bindings.length).toBe(1);
    const assertionGraphPtr = String(ptrRes.bindings[0]['o'])
      .replace(/^"/, '')
      .replace(/"(\^\^<[^>]+>)?$/, '');
    expect(assertionGraphPtr).toBe(expectedVmGraph);
    // …and the pointed-at graph actually holds the published triple (no stale
    // pointer at an emptied SWM bucket).
    const vmData = await (agent as any).store.query(
      `SELECT ?o WHERE { GRAPH <${expectedVmGraph}> { <${ENTITY_BASE}:auto> <http://schema.org/name> ?o } }`,
    );
    expect(vmData.type).toBe('bindings');
    expect(vmData.bindings.length).toBeGreaterThan(0);
  }, 30_000);

  it('F4 regression (Codex #898 after publish): WM-graph marker is UPDATED to "VM" and a stale re-promote is a no-op', async () => {
    // Adversarial review F4: the publish-time SWM→VM flip briefly DELETED the
    // per-KA `<wmGraph> dkg:memoryLayer` row (RFC ka-metadata-trim "orphan
    // marker cleanup"). That row is the witness `assertAssertionDataPersisted`
    // reads to classify a stale re-promote after a successful publish as a
    // harmless no-op (the Codex #898 case, post-publish variant: the lifecycle
    // URN's dkg:assertionGraph back-link has been re-pointed at the VM graph by
    // then, so the URN fallback can no longer vouch for the WM graph). The fix
    // UPDATES the marker in place to "VM" — keeping the witness and killing the
    // misleading orphan "SWM" value.
    const agent = await createAgent('DoublePromoteBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Double Promote E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'double-promote';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:dp`, predicate: 'http://schema.org/name', object: '"Double Promote"' },
    ]);
    const promoteResult = await agent.assertion.promote(CG_ID, name);
    expect(promoteResult.promotedCount).toBeGreaterThan(0);

    const pub = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(pub.status).toBe('confirmed');
    expect(pub.kaId).toBeDefined();

    // 1. The marker must now read "VM" on the per-KA WM graph URI the flip
    //    derives from the minted kaId — present (not deleted), not "SWM".
    const DKG = 'http://dkg.io/ontology/';
    const metaGraph = contextGraphMetaUri(CG_ID);
    const kaId = BigInt(pub.kaId!);
    const wmGraphFromKaId = contextGraphLayerUri(
      CG_ID,
      MemoryLayer.WorkingMemory,
      '0x' + (kaId >> 96n).toString(16).padStart(40, '0'),
      kaId & ((1n << 96n) - 1n),
    );
    const markerRes = await (agent as any).store.query(
      `SELECT ?layer WHERE { GRAPH <${metaGraph}> { <${wmGraphFromKaId}> <${DKG}memoryLayer> ?layer } }`,
    );
    expect(markerRes.type).toBe('bindings');
    expect(markerRes.bindings.map((b: Record<string, string>) => b['layer'])).toEqual([`"${MemoryLayer.VerifiableMemory}"`]);

    // 2. Codex #898 post-publish: import-file extraction markers survive
    //    promote+publish by design. With the WM marker deleted (pre-F4) the
    //    stale re-promote below misfired AssertionNotPersistedError; the "VM"
    //    marker short-circuits it to the harmless `{ promotedCount: 0 }` no-op.
    const author = agent.defaultAgentAddress ?? agent.peerId;
    const wmGraphPromoteSees = await (agent as any).publisher.wmGraphUri(CG_ID, author, name);
    await (agent as any).store.insert([
      { subject: wmGraphPromoteSees, predicate: `${DKG}extractionStatus`, object: '"completed"', graph: metaGraph },
      { subject: wmGraphPromoteSees, predicate: `${DKG}structuralTripleCount`, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: metaGraph },
    ]);
    const second = await (agent as any).publisher.assertionPromote(CG_ID, name, author);
    expect(second.promotedCount).toBe(0);
  }, 30_000);

  it('rejects selective promote because a graph-scoped KA is atomic', async () => {
    const agent = await createAgent('SelectivePromoteBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Selective Promote E2E' });
    await agent.registerContextGraph(CG_ID);

    await agent.assertion.create(CG_ID, 'selective');
    await agent.assertion.write(CG_ID, 'selective', [
      { subject: `${ENTITY_BASE}:a`, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: `${ENTITY_BASE}:b`, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    await expect(
      agent.assertion.promote(CG_ID, 'selective', { entities: [`${ENTITY_BASE}:a`] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });

    // Rejection is pre-commit: the complete draft remains available and no
    // subject subset can escape into SWM under the KA identity.
    expect(await agent.assertion.query(CG_ID, 'selective')).toHaveLength(2);
    expect(
      await agent.publisher.hasSwmShareComplete(
        CG_ID,
        'selective',
        agent.defaultAgentAddress ?? agent.peerId,
      ),
    ).toBe(false);
  }, 20_000);

  it('promote fails fast when the draft was edited after finalize (stale seal, not a silent publish mismatch)', async () => {
    // Regression for the #1004 review: the old auto-finalize only checked whether
    // a seal EXISTED, not whether it matched the current WM. A finalize → edit →
    // promote sequence skipped re-finalize, promoted the new content under the
    // STALE seal, and failed only later at publish with a confusing merkleRoot
    // mismatch. promote now ALWAYS calls assertionFinalize, which detects the
    // post-finalize mutation and throws — so promote fails fast, BEFORE emptying
    // WM, with an actionable "already finalized with a different merkleRoot" error.
    const agent = await createAgent('StaleSealBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Stale Seal E2E' });
    await agent.registerContextGraph(CG_ID);

    await agent.assertion.create(CG_ID, 'stale');
    await agent.assertion.write(CG_ID, 'stale', [
      { subject: `${ENTITY_BASE}:s1`, predicate: 'http://schema.org/name', object: '"First"' },
    ]);
    await agent.assertion.finalize(CG_ID, 'stale');

    // Edit the draft AFTER finalize — the seal is now stale.
    await agent.assertion.write(CG_ID, 'stale', [
      { subject: `${ENTITY_BASE}:s2`, predicate: 'http://schema.org/name', object: '"Added after finalize"' },
    ]);

    // promote must fail fast (assertionFinalize detects the mutation), NOT
    // silently promote the stale-sealed content.
    await expect(agent.assertion.promote(CG_ID, 'stale')).rejects.toThrow(
      /differs from its existing seal|different merkleRoot/i,
    );

    // WM is intact — the failed promote did not empty it.
    const wm = await agent.assertion.query(CG_ID, 'stale');
    expect(wm.length).toBeGreaterThan(0);
  }, 20_000);

  it('WM is empty after promote; SWM clear after publishFromSWM with flag', async () => {
    const agent = await createAgent('CleanupBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Cleanup E2E' });
    await agent.registerContextGraph(CG_ID);

    await agent.assertion.create(CG_ID, 'cleanup');
    await agent.assertion.write(CG_ID, 'cleanup', [
      { subject: `${ENTITY_BASE}:cleanup`, predicate: 'http://schema.org/name', object: '"Cleanup"' },
    ]);
    await agent.assertion.promote(CG_ID, 'cleanup');

    // WM should be empty
    const wmAfterPromote = await agent.assertion.query(CG_ID, 'cleanup');
    expect(wmAfterPromote.length).toBe(0);

    await agent.publishFromSharedMemory(CG_ID, 'all', { clearSharedMemoryAfter: true });

    // SWM should be empty after publish with clear flag
    const swmAfterPublish = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:cleanup> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swmAfterPublish.bindings.length).toBe(0);

    // Data should be in canonical graph
    const data = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:cleanup> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(data.bindings.length).toBe(1);
  }, 20_000);
});

describe('rootless graph-scoped KA lifecycle', () => {
  it('full share seals and publishes; skipSeal is rejected before SWM mutation', async () => {
    const agent = await createAgent('SealDefaultBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Seal Default E2E' });
    await agent.registerContextGraph(CG_ID);

    // --- Full share: seals by default ---
    await agent.assertion.create(CG_ID, 'sealed-share');
    await agent.assertion.write(CG_ID, 'sealed-share', [
      { subject: `${ENTITY_BASE}:sealed`, predicate: 'http://schema.org/name', object: '"Sealed Share"' },
    ]);
    const fullShare = await agent.assertion.promote(CG_ID, 'sealed-share');
    expect(fullShare.sealed).toBe(true);
    expect(fullShare.publishReady).toBe(true);

    // A sealed full share is publishable from the finalized assertion.
    const pub = await agent.publishFromFinalizedAssertion(CG_ID, 'sealed-share');
    expect(pub.status).toBe('confirmed');
    expect(pub.ual).toBeDefined();
    expect(pub.seal).toBeDefined();

    // A new graph-scoped KA may not enter SWM without its v2 seal. The old
    // skipSeal staging path depended on root/member metadata and is read-only.
    await agent.assertion.create(CG_ID, 'unsealed-share');
    await agent.assertion.write(CG_ID, 'unsealed-share', [
      { subject: `${ENTITY_BASE}:unsealed`, predicate: 'http://schema.org/name', object: '"Unsealed Share"' },
    ]);
    await expect(
      agent.assertion.promote(CG_ID, 'unsealed-share', { skipSeal: true }),
    ).rejects.toMatchObject({ code: 'UNSEALED_SHARE_BLOCKED' });
    expect(await agent.assertion.query(CG_ID, 'unsealed-share')).toHaveLength(1);
  }, 30_000);

  it('async publish intent is graph-scoped when provenance events are disabled', async () => {
    const agent = await createAgent('LiteProvenanceAsyncIntentBot', { metadataProvenanceEvents: false });
    await agent.createContextGraph({ id: CG_ID, name: 'Lite Provenance Async Intent E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'lite-provenance-async';
    const root = `${ENTITY_BASE}:lite-provenance`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Lite Provenance Async"' },
    ]);
    const share = await agent.assertion.promote(CG_ID, name);
    expect(share.sealed).toBe(true);
    expect(share.publishReady).toBe(true);

    const history = await agent.assertion.history(CG_ID, name);
    expect(history?.events).toEqual([]);
    expect(history?.currentShareOperationId).toBe(share.shareOperationId);

    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);
    expect(intent.shareOperationId).toBe(share.shareOperationId);
    expect(intent.roots).toEqual([]);
    expect(intent.sealMerkleRoot).toMatch(/^0x[0-9a-f]+$/);
  }, 30_000);

  it('async VM publish executes the queued share snapshot after live SWM is drained', async () => {
    const agent = await createAgent('QueuedAsyncVmPublishBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Publish E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-async-vm';
    const root = `${ENTITY_BASE}:queued-async`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Queued Async VM"' },
    ]);
    const share = await agent.assertion.promote(CG_ID, name);
    expect(share.publishReady).toBe(true);

    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);
    expect(intent.shareOperationId).toBe(share.shareOperationId);

    await (agent as any).publisher.clearPublishedSwmRoots(
      CG_ID,
      [...intent.roots],
      undefined,
      createOperationContext('publishFromSWM'),
    );

    const preflight = vi.fn(async ({ request }) =>
      agent.preflightQueuedKnowledgeAssetVmPublishExecution(request),
    );
    const asyncPublisher = new TripleStoreAsyncLiftPublisher((agent as any).store, {
      knowledgeAssetVmPublishHandler: {
        preflight,
        execute: async ({ request, publishOptions }) =>
          agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions),
      },
    });
    const jobId = await asyncPublisher.enqueueKnowledgeAssetVmPublish(intent);
    const processed = await asyncPublisher.processNext('wallet-1');
    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('finalized');
    expect(processed?.broadcast?.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(processed?.inclusion?.blockNumber).toBeGreaterThan(0);
    expect(processed?.finalization?.mode).not.toBe('local');
    expect(preflight).toHaveBeenCalled();

    const history = await agent.assertion.history(CG_ID, name);
    expect(history?.vmCurrentAssertion).toBe(intent.sealMerkleRoot.slice(2));
    expect(history?.state).toBe('published');
    expect(history?.memoryLayer).toBe(MemoryLayer.VerifiableMemory);

    const vmRows = await agent.query(
      `SELECT ?name WHERE { <${root}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID },
    );
    expect(vmRows.bindings.map((row) => row['name'])).toContain('"Queued Async VM"');
  }, 60_000);

  it('repairs a named lifecycle after its async publish transaction confirmed during downtime', async () => {
    const agent = await createAgent('QueuedAsyncVmRecoveryBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Recovery E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-async-recovery';
    const root = `${ENTITY_BASE}:queued-async-recovery`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Recovered Async VM"' },
    ]);
    const share = await agent.assertion.promote(CG_ID, name);
    expect(share.publishReady).toBe(true);

    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);
    const confirmed = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.onChainResult).toBeDefined();

    const lifecycleAgent = intent.agentAddress ?? agent.defaultAgentAddress ?? agent.peerId;
    const lifecycleUri = assertionLifecycleUri(CG_ID, lifecycleAgent, name);
    const assertionUri = contextGraphAssertionUri(CG_ID, lifecycleAgent, name);
    const metaGraph = contextGraphMetaUri(CG_ID);
    const store = (agent as any).store;
    const DKG = 'http://dkg.io/ontology/';

    // Recreate the exact #1669 post-restart split-brain: chain/VM data exists,
    // while the named descriptor and receipt still look merely promoted.
    for (const predicate of [
      `${DKG}vmCurrentAssertion`,
      `${DKG}publishedUal`,
      `${DKG}assertionGraph`,
      `${DKG}memoryLayer`,
      `${DKG}state`,
    ]) {
      await store.deleteByPattern({ subject: lifecycleUri, predicate, graph: metaGraph });
    }
    await store.deleteByPattern({ subject: assertionUri, predicate: `${DKG}memoryLayer`, graph: metaGraph });
    for (const predicate of Object.values(ASSERTION_PUBLISH_RECEIPT_PREDICATES)) {
      await store.deleteByPattern({ subject: assertionUri, predicate, graph: metaGraph });
    }
    await store.insert([
      { subject: lifecycleUri, predicate: `${DKG}state`, object: '"promoted"', graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}memoryLayer`, object: `"${MemoryLayer.SharedWorkingMemory}"`, graph: metaGraph },
      { subject: assertionUri, predicate: `${DKG}memoryLayer`, object: `"${MemoryLayer.SharedWorkingMemory}"`, graph: metaGraph },
    ]);

    const onChain = confirmed.onChainResult!;
    const kaId = BigInt(intent.seal.reservedKaId!);
    const txHash = onChain.txHash as `0x${string}`;
    const recoveryInput = {
      walletId: 'wallet-1',
      request: intent,
      job: {
        jobId: 'recovery-job',
        jobSlug: 'recovery-job',
        request: { jobType: 'knowledge-asset-vm-publish', knowledgeAssetVmPublish: intent },
        status: 'broadcast',
        broadcast: {
          txHash,
          walletId: 'wallet-1',
          merkleRoot: intent.sealMerkleRoot,
        },
        timestamps: { acceptedAt: 1, broadcastAt: 2, updatedAt: 2 },
        retries: { retryCount: 0, maxRetries: 10 },
        controlPlane: {},
      },
      recovery: {
        inclusion: {
          txHash,
          blockNumber: onChain.blockNumber,
          blockTimestamp: onChain.blockTimestamp,
        },
        finalization: {
          mode: 'published',
          txHash,
          ual: confirmed.ual,
          batchId: kaId.toString(),
          startKAId: kaId.toString(),
          endKAId: kaId.toString(),
          publisherAddress: onChain.publisherAddress as `0x${string}`,
        },
        publishProof: {
          merkleRoot: intent.sealMerkleRoot,
          authorAddress: intent.seal.authorAddress,
        },
      },
      publisher: (agent as any).publisher,
    } as const;

    await expect(agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
      ...recoveryInput,
      recovery: {
        ...recoveryInput.recovery,
        finalization: {
          ...recoveryInput.recovery.finalization,
          endKAId: (kaId + 1n).toString(),
        },
      },
    } as any)).rejects.toMatchObject({ code: 'KA_VM_RECOVERY_INCONSISTENT' });
    expect((await agent.assertion.history(CG_ID, name))?.state).toBe('promoted');

    await expect(agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
      ...recoveryInput,
      recovery: {
        ...recoveryInput.recovery,
        publishProof: {
          ...recoveryInput.recovery.publishProof,
          merkleRoot: `0x${'ff'.repeat(32)}`,
        },
      },
    } as any)).rejects.toMatchObject({ code: 'KA_VM_RECOVERY_INCONSISTENT' });
    expect((await agent.assertion.history(CG_ID, name))?.state).toBe('promoted');

    await expect(agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
      ...recoveryInput,
      recovery: {
        ...recoveryInput.recovery,
        publishProof: {
          ...recoveryInput.recovery.publishProof,
          authorAddress: '0x0000000000000000000000000000000000000001',
        },
      },
    } as any)).rejects.toMatchObject({ code: 'KA_VM_RECOVERY_INCONSISTENT' });
    expect((await agent.assertion.history(CG_ID, name))?.state).toBe('promoted');

    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(recoveryInput as any);
    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(recoveryInput as any);

    const history = await agent.assertion.history(CG_ID, name);
    expect(history?.state).toBe('published');
    expect(history?.memoryLayer).toBe(MemoryLayer.VerifiableMemory);
    expect(history?.status).toBe('vm-confirmed');
    expect(history?.vmCurrentAssertion).toBe(intent.sealMerkleRoot.slice(2));
    expect(history?.publishedUal).toBe(confirmed.ual);

    const receipt = await store.query(`ASK { GRAPH <${metaGraph}> {
      <${assertionUri}> <${ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_TX}> "${txHash}" .
      <${assertionUri}> <${ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_BLOCK}> ?block .
    } }`);
    expect(receipt).toMatchObject({ type: 'boolean', value: true });
    await expect(agent.preflightQueuedKnowledgeAssetVmPublishExecution(intent)).resolves.toMatchObject({
      action: 'noop',
      reason: 'already-published',
    });

    // A later update must not invalidate recovery of the original confirmed
    // transaction, and replaying that recovery must not regress the VM pointer.
    await agent.assertion.pullFrom(CG_ID, name, 'vm', { onConflict: 'replace' });
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Recovered Async VM v2"' },
    ]);
    await agent.assertion.finalize(CG_ID, name);
    await agent.assertion.promote(CG_ID, name);
    const updateIntent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);
    const updated = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(updated.status).toBe('confirmed');
    expect(updateIntent.sealMerkleRoot).not.toBe(intent.sealMerkleRoot);

    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(recoveryInput as any);
    const afterSupersededRecovery = await agent.assertion.history(CG_ID, name);
    expect(afterSupersededRecovery?.vmCurrentAssertion).toBe(updateIntent.sealMerkleRoot.slice(2));
  }, 90_000);

  it('async VM publish no-ops when the queued seal is already current in VM', async () => {
    const agent = await createAgent('QueuedAsyncVmAlreadyPublishedBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Already Published E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-async-already-published';
    const root = `${ENTITY_BASE}:queued-async-already-published`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Already Published"' },
    ]);
    const share = await agent.assertion.promote(CG_ID, name);
    expect(share.publishReady).toBe(true);

    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);
    const executor = vi.fn(async () => {
      throw new Error('executor should not run for already-published queued intent');
    });
    const preflight = vi.fn(async ({ request }) =>
      agent.preflightQueuedKnowledgeAssetVmPublishExecution(request),
    );
    const asyncPublisher = new TripleStoreAsyncLiftPublisher((agent as any).store, {
      knowledgeAssetVmPublishHandler: { preflight, execute: executor },
    });
    const jobId = await asyncPublisher.enqueueKnowledgeAssetVmPublish(intent);

    const syncPublish = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(syncPublish.status).toBe('confirmed');

    const processed = await asyncPublisher.processNext('wallet-1');
    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status, JSON.stringify((processed as any)?.failure)).toBe('finalized');
    expect(processed?.finalization?.mode).toBe('noop');
    expect(preflight).toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  }, 60_000);

  it('async VM publish fails stale when the named KA is shared again before execution', async () => {
    const agent = await createAgent('QueuedAsyncVmStaleAfterReshareBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Stale After Reshare E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-async-stale-after-reshare';
    const root = `${ENTITY_BASE}:queued-async-stale-after-reshare`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Stale v1"' },
    ]);
    const firstShare = await agent.assertion.promote(CG_ID, name);
    expect(firstShare.publishReady).toBe(true);
    const staleIntent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);

    const executor = vi.fn(async () => {
      throw new Error('executor should not run for stale queued intent');
    });
    const preflight = vi.fn(async ({ request }) =>
      agent.preflightQueuedKnowledgeAssetVmPublishExecution(request),
    );
    const asyncPublisher = new TripleStoreAsyncLiftPublisher((agent as any).store, {
      knowledgeAssetVmPublishHandler: { preflight, execute: executor },
    });
    const jobId = await asyncPublisher.enqueueKnowledgeAssetVmPublish(staleIntent);

    const firstPublish = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(firstPublish.status).toBe('confirmed');
    await agent.assertion.pullFrom(CG_ID, name, 'vm', { onConflict: 'replace' });
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Stale v2"' },
    ]);
    await agent.assertion.finalize(CG_ID, name);
    const secondShare = await agent.assertion.promote(CG_ID, name);
    expect(secondShare.publishReady).toBe(true);
    expect(secondShare.shareOperationId).not.toBe(firstShare.shareOperationId);

    const processed = await asyncPublisher.processNext('wallet-1');
    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status, JSON.stringify((processed as any)?.failure)).toBe('failed');
    expect(processed?.failure?.failedFromState, JSON.stringify((processed as any)?.failure)).toBe('claimed');
    expect(processed?.failure?.code).toBe('publish_intent_stale');
    expect(preflight).toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  }, 60_000);

  it('queued async VM publish rejects chain-bound seal mismatches before publisher invocation', async () => {
    const agent = await createAgent('QueuedAsyncVmPublishChainGuardBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Publish Chain Guard E2E' });

    const cases = [
      {
        name: 'queued-async-chain-mismatch',
        root: `${ENTITY_BASE}:queued-chain-mismatch`,
        mutate: (intent: Awaited<ReturnType<typeof agent.resolveFinalizedAssertionVmPublishIntent>>) => ({
          ...intent,
          sealChainId: (BigInt(intent.sealChainId) + 1n).toString() as `${bigint}`,
        }),
        message: /seal binds chainId=/,
      },
      {
        name: 'queued-async-kav10-mismatch',
        root: `${ENTITY_BASE}:queued-kav10-mismatch`,
        mutate: (intent: Awaited<ReturnType<typeof agent.resolveFinalizedAssertionVmPublishIntent>>) => ({
          ...intent,
          sealKav10Address: `0x${'33'.repeat(20)}` as `0x${string}`,
        }),
        message: /seal binds KAv10=/,
      },
    ];

    for (const testCase of cases) {
      await agent.assertion.create(CG_ID, testCase.name);
      await agent.assertion.write(CG_ID, testCase.name, [
        { subject: testCase.root, predicate: 'http://schema.org/name', object: `"${testCase.name}"` },
      ]);
      await agent.assertion.promote(CG_ID, testCase.name);
      const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, testCase.name);
      const badIntent = testCase.mutate(intent);
      const fakePublisher = {
        publish: vi.fn(),
        clearPublishedSwmRoots: vi.fn(),
        clearRemainingSharedMemory: vi.fn(),
      };

      await expect(
        agent.publishQueuedKnowledgeAssetVmPublish(
          badIntent,
          {
            quads: [
              { subject: testCase.root, predicate: 'http://schema.org/name', object: `"${testCase.name}"`, graph: '' },
            ],
            publisherPeerId: 'peer-1',
          },
          { publisherOverride: fakePublisher as any },
        ),
      ).rejects.toThrow(testCase.message);
      expect(fakePublisher.publish).not.toHaveBeenCalled();
      expect(fakePublisher.clearPublishedSwmRoots).not.toHaveBeenCalled();
      expect(fakePublisher.clearRemainingSharedMemory).not.toHaveBeenCalled();
    }
  }, 60_000);

  it('no-op SWM share after VM publish does not re-arm async publish intent', async () => {
    const agent = await createAgent('NoopShareDoesNotRearmAsyncIntentBot');
    await agent.createContextGraph({ id: CG_ID, name: 'No-op Share Async Intent E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'noop-share-after-publish';
    const root = `${ENTITY_BASE}:noop-share-after-publish`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"No-op Share After Publish"' },
    ]);
    const share = await agent.assertion.promote(CG_ID, name);
    expect(share.publishReady).toBe(true);

    const publish = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(publish.status).toBe('confirmed');

    const author = agent.defaultAgentAddress ?? agent.peerId;
    const noopShare = await (agent as any).publisher.assertionPromote(CG_ID, name, author);
    expect(noopShare.promotedCount).toBe(0);
    expect(noopShare.promotedAllRoots).toBe(false);
    expect(noopShare.shareOperationId).toBeUndefined();

    const history = await agent.assertion.history(CG_ID, name);
    expect(history?.currentShareOperationId).not.toBe(share.shareOperationId);
    await expect(
      agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name),
    ).rejects.toMatchObject({ code: 'PUBLISH_NOT_FULL_SHARE' });
  }, 60_000);

  it('async VM publish with clearAfter false clears published roots but leaves unrelated SWM content', async () => {
    const agent = await createAgent('QueuedAsyncVmPublishCleanupBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Cleanup E2E' });
    await agent.registerContextGraph(CG_ID);

    const publishedName = 'queued-async-cleanup-published';
    const retainedName = 'queued-async-cleanup-retained';
    const publishedRoot = `${ENTITY_BASE}:queued-cleanup-published`;
    const retainedRoot = `${ENTITY_BASE}:queued-cleanup-retained`;
    await agent.assertion.create(CG_ID, publishedName);
    await agent.assertion.write(CG_ID, publishedName, [
      { subject: publishedRoot, predicate: 'http://schema.org/name', object: '"Published root"' },
    ]);
    const publishedShare = await agent.assertion.promote(CG_ID, publishedName);
    expect(publishedShare.publishReady).toBe(true);

    await agent.assertion.create(CG_ID, retainedName);
    await agent.assertion.write(CG_ID, retainedName, [
      { subject: retainedRoot, predicate: 'http://schema.org/name', object: '"Retained root"' },
    ]);
    const retainedShare = await agent.assertion.promote(CG_ID, retainedName);
    expect(retainedShare.publishReady).toBe(true);

    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, publishedName, {
      clearSharedMemoryAfter: false,
    });
    const asyncPublisher = new TripleStoreAsyncLiftPublisher((agent as any).store, {
      knowledgeAssetVmPublishHandler: {
        execute: async ({ request, publishOptions }) =>
          agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions),
      },
    });
    const jobId = await asyncPublisher.enqueueKnowledgeAssetVmPublish(intent);
    const processed = await asyncPublisher.processNext('wallet-1');
    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('finalized');

    const publishedSwm = await agent.query(
      `SELECT ?name WHERE { <${publishedRoot}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(publishedSwm.bindings).toHaveLength(0);

    const retainedSwm = await agent.query(
      `SELECT ?name WHERE { <${retainedRoot}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(retainedSwm.bindings).toHaveLength(1);
  }, 60_000);

  it('queued VM publish cleanup preserves a same-root sibling named lifecycle', async () => {
    const agent = await createAgent('QueuedScopedSameRootCleanupBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Scoped Same Root Cleanup E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-scoped-same-root';
    const root = `${ENTITY_BASE}:queued-scoped-same-root`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"primary"' },
    ]);
    const share = await agent.assertion.promote(CG_ID, name);
    expect(share.publishReady).toBe(true);

    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);
    expect(intent.kaNumber).toBeDefined();
    const lifecycleAgent = intent.agentAddress ?? agent.defaultAgentAddress ?? agent.peerId;
    const primaryNumber = BigInt(intent.kaNumber!);
    const primaryGraph = contextGraphLayerUri(
      CG_ID,
      MemoryLayer.SharedWorkingMemory,
      lifecycleAgent.toLowerCase(),
      primaryNumber,
    );
    const siblingGraph = contextGraphLayerUri(
      CG_ID,
      MemoryLayer.SharedWorkingMemory,
      lifecycleAgent.toLowerCase(),
      primaryNumber + 1n,
    );
    await (agent as any).store.insert([{
      subject: root,
      predicate: 'http://schema.org/name',
      object: '"same-root sibling"',
      graph: siblingGraph,
    }]);

    const realPublisher = (agent as any).publisher;
    const publishSpy = vi.spyOn(realPublisher, 'publish').mockResolvedValue({
      kaId: intent.seal.reservedKaId !== undefined ? BigInt(intent.seal.reservedKaId) : 1n,
      ual: 'did:dkg:test/queued-scoped-same-root',
      merkleRoot: ethers.getBytes(intent.sealMerkleRoot),
      kaManifest: [{ tokenId: 1n, rootEntity: root, privateTripleCount: 0 }],
      status: 'confirmed',
      publicQuads: [],
    });
    try {
      const result = await agent.publishQueuedKnowledgeAssetVmPublish(intent, {
        quads: [{ subject: root, predicate: 'http://schema.org/name', object: '"primary"', graph: '' }],
        publisherPeerId: 'queued-scoped-test',
      });
      expect(result.status).toBe('confirmed');
    } finally {
      publishSpy.mockRestore();
    }

    const primary = await (agent as any).store.query(
      `ASK { GRAPH <${primaryGraph}> { <${root}> ?p ?o } }`,
    );
    const sibling = await (agent as any).store.query(
      `ASK { GRAPH <${siblingGraph}> { <${root}> ?p ?o } }`,
    );
    expect(primary).toMatchObject({ type: 'boolean', value: false });
    expect(sibling).toMatchObject({ type: 'boolean', value: true });
  }, 60_000);

  it('async VM publish with clearAfter true clears the remaining SWM scope', async () => {
    const agent = await createAgent('QueuedAsyncVmPublishClearAllBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Clear All E2E' });
    await agent.registerContextGraph(CG_ID);

    const publishedName = 'queued-async-clearall-published';
    const retainedName = 'queued-async-clearall-retained';
    const publishedRoot = `${ENTITY_BASE}:queued-clearall-published`;
    const retainedRoot = `${ENTITY_BASE}:queued-clearall-retained`;
    await agent.assertion.create(CG_ID, publishedName);
    await agent.assertion.write(CG_ID, publishedName, [
      { subject: publishedRoot, predicate: 'http://schema.org/name', object: '"Published root"' },
    ]);
    const publishedShare = await agent.assertion.promote(CG_ID, publishedName);
    expect(publishedShare.publishReady).toBe(true);

    await agent.assertion.create(CG_ID, retainedName);
    await agent.assertion.write(CG_ID, retainedName, [
      { subject: retainedRoot, predicate: 'http://schema.org/name', object: '"Retained root"' },
    ]);
    const retainedShare = await agent.assertion.promote(CG_ID, retainedName);
    expect(retainedShare.publishReady).toBe(true);

    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, publishedName, {
      clearSharedMemoryAfter: true,
    });
    const asyncPublisher = new TripleStoreAsyncLiftPublisher((agent as any).store, {
      knowledgeAssetVmPublishHandler: {
        preflight: async ({ request }) =>
          agent.preflightQueuedKnowledgeAssetVmPublishExecution(request),
        execute: async ({ request, publishOptions }) =>
          agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions),
      },
    });
    const jobId = await asyncPublisher.enqueueKnowledgeAssetVmPublish(intent);
    const processed = await asyncPublisher.processNext('wallet-1');
    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('finalized');

    const publishedSwm = await agent.query(
      `SELECT ?name WHERE { <${publishedRoot}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(publishedSwm.bindings).toHaveLength(0);

    const retainedSwm = await agent.query(
      `SELECT ?name WHERE { <${retainedRoot}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(retainedSwm.bindings).toHaveLength(0);
  }, 60_000);

  it('async VM publish tentative private-no-acks fails without VM published metadata', async () => {
    const agent = await createAgent('QueuedAsyncVmPublishTentativeNoAcksBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Tentative E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-async-tentative-no-acks';
    const root = `${ENTITY_BASE}:queued-tentative-no-acks`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Tentative no ACKs"' },
    ]);
    const share = await agent.assertion.promote(CG_ID, name);
    expect(share.publishReady).toBe(true);

    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);
    const fakePublisher = {
      publish: vi.fn(async () => ({
        status: 'tentative' as const,
        localChainSkipReason: 'private-no-acks' as const,
        ual: 'did:dkg:local/private-no-acks',
        merkleRoot: ethers.getBytes(intent.sealMerkleRoot),
        kaManifest: [],
      })),
      clearPublishedSwmRoots: vi.fn(),
      clearRemainingSharedMemory: vi.fn(),
    };
    const asyncPublisher = new TripleStoreAsyncLiftPublisher((agent as any).store, {
      knowledgeAssetVmPublishHandler: {
        execute: async ({ request, publishOptions }) =>
          agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions, {
            publisherOverride: fakePublisher as any,
          }),
      },
    });
    const jobId = await asyncPublisher.enqueueKnowledgeAssetVmPublish(intent);
    const processed = await asyncPublisher.processNext('wallet-1');
    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('failed');
    expect(fakePublisher.publish).toHaveBeenCalledOnce();
    expect(fakePublisher.clearPublishedSwmRoots).not.toHaveBeenCalled();
    expect(fakePublisher.clearRemainingSharedMemory).not.toHaveBeenCalled();

    const history = await agent.assertion.history(CG_ID, name);
    expect(history?.vmCurrentAssertion).not.toBe(intent.sealMerkleRoot.slice(2));
    expect(history?.state).not.toBe('published');
    expect(history?.memoryLayer).not.toBe(MemoryLayer.VerifiableMemory);
  }, 60_000);

  it('async VM publish updates a sub-graph KA in the sub-graph VM graph', async () => {
    const agent = await createAgent('QueuedAsyncVmSubgraphUpdateBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Subgraph Update E2E' });
    await agent.registerContextGraph(CG_ID);
    const subGraphName = 'async-update';
    await agent.createSubGraph(CG_ID, subGraphName);

    const name = 'queued-async-subgraph-update';
    const root = `${ENTITY_BASE}:queued-subgraph-update`;
    await agent.assertion.create(CG_ID, name, { subGraphName });
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Subgraph v1"' },
    ], { subGraphName });
    const firstShare = await agent.assertion.promote(CG_ID, name, { subGraphName });
    expect(firstShare.publishReady).toBe(true);
    const firstPublish = await agent.publishFromFinalizedAssertion(CG_ID, name, { subGraphName });
    expect(firstPublish.status).toBe('confirmed');

    const reopened = await agent.assertion.pullFrom(CG_ID, name, 'vm', {
      subGraphName,
      onConflict: 'replace',
    });
    expect(reopened.seeded).toBe(1);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Subgraph v2"' },
    ], { subGraphName });
    await agent.assertion.finalize(CG_ID, name, { subGraphName });
    const updateShare = await agent.assertion.promote(CG_ID, name, { subGraphName });
    expect(updateShare.publishReady).toBe(true);

    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name, { subGraphName });
    expect(intent.vmCurrentAssertion).toBeDefined();
    const asyncPublisher = new TripleStoreAsyncLiftPublisher((agent as any).store, {
      knowledgeAssetVmPublishHandler: {
        execute: async ({ request, publishOptions }) =>
          agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions),
      },
    });
    const jobId = await asyncPublisher.enqueueKnowledgeAssetVmPublish(intent);
    const processed = await asyncPublisher.processNext('wallet-1');
    expect(processed?.jobId).toBe(jobId);

    if (processed?.status !== 'finalized') {
      throw new Error(`Expected queued sub-graph update to finalize: ${JSON.stringify((processed as any)?.failure)}`);
    }

    const subgraphVm = await agent.query(
      `SELECT ?name WHERE { <${root}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, subGraphName },
    );
    expect(subgraphVm.bindings.map((row) => row['name'])).toContain('"Subgraph v2"');

    const rootVm = await agent.query(
      `SELECT ?name WHERE { <${root}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID },
    );
    expect(rootVm.bindings.map((row) => row['name'])).not.toContain('"Subgraph v2"');

    const history = await agent.assertion.history(CG_ID, name, { subGraphName });
    expect(history?.state).toBe('published');
    expect(history?.memoryLayer).toBe(MemoryLayer.VerifiableMemory);
    expect(history?.vmCurrentAssertion).toBe(intent.sealMerkleRoot.slice(2));
  }, 120_000);

  it('synchronous VM publish updates a sub-graph KA in the sub-graph VM graph', async () => {
    const agent = await createAgent('SyncVmSubgraphUpdateBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Sync VM Subgraph Update E2E' });
    await agent.registerContextGraph(CG_ID);
    const subGraphName = 'sync-update';
    await agent.createSubGraph(CG_ID, subGraphName);

    const name = 'sync-subgraph-update';
    const root = `${ENTITY_BASE}:sync-subgraph-update`;
    await agent.assertion.create(CG_ID, name, { subGraphName });
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Sync Subgraph v1"' },
    ], { subGraphName });
    const firstShare = await agent.assertion.promote(CG_ID, name, { subGraphName });
    expect(firstShare.publishReady).toBe(true);
    const firstPublish = await agent.publishFromFinalizedAssertion(CG_ID, name, { subGraphName });
    expect(firstPublish.status).toBe('confirmed');

    const reopened = await agent.assertion.pullFrom(CG_ID, name, 'vm', {
      subGraphName,
      onConflict: 'replace',
    });
    expect(reopened.seeded).toBe(1);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Sync Subgraph v2"' },
    ], { subGraphName });
    await agent.assertion.finalize(CG_ID, name, { subGraphName });
    const updateShare = await agent.assertion.promote(CG_ID, name, { subGraphName });
    expect(updateShare.publishReady).toBe(true);
    expect(updateShare.shareOperationId).not.toBe(firstShare.shareOperationId);
    const updateIntent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name, { subGraphName });
    expect(updateIntent.vmCurrentAssertion).toBeDefined();

    const secondPublish = await agent.publishFromFinalizedAssertion(CG_ID, name, { subGraphName });
    expect(secondPublish.status).toBe('confirmed');

    const subgraphVm = await agent.query(
      `SELECT ?name WHERE { <${root}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, subGraphName },
    );
    expect(subgraphVm.bindings.map((row) => row['name'])).toContain('"Sync Subgraph v2"');

    const rootVm = await agent.query(
      `SELECT ?name WHERE { <${root}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID },
    );
    expect(rootVm.bindings.map((row) => row['name'])).not.toContain('"Sync Subgraph v2"');

    const history = await agent.assertion.history(CG_ID, name, { subGraphName });
    expect(history?.state).toBe('published');
    expect(history?.memoryLayer).toBe(MemoryLayer.VerifiableMemory);
    expect(history?.vmCurrentAssertion).toBe(updateIntent.sealMerkleRoot.slice(2));
  }, 120_000);

  it('rejects unsealed SWM recovery and preserves the complete WM draft', async () => {
    const agent = await createAgent('SealInSwmBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Seal-in-SWM E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'seal-in-swm';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:sis`, predicate: 'http://schema.org/name', object: '"Seal In SWM"' },
    ]);

    await expect(
      agent.assertion.promote(CG_ID, name, { skipSeal: true }),
    ).rejects.toMatchObject({ code: 'UNSEALED_SHARE_BLOCKED' });
    await expect(
      agent.assertion.finalize(CG_ID, name, { layer: 'swm' }),
    ).rejects.toMatchObject({ code: 'SWM_SUBSET_NOT_SEALABLE' });

    const wm = await agent.assertion.query(CG_ID, name);
    expect(wm).toHaveLength(1);
    expect(wm[0]?.subject).toBe(`${ENTITY_BASE}:sis`);
  }, 30_000);

  it('strips the generated private-CG catalog floor on pre-registration product-path promote', async () => {
    const agent = await createAgent('PrivateCgCatalogPromoteBot');
    const cg = `${CG_ID}-private-local`;
    const callerAgentAddress = agent.defaultAgentAddress ?? agent.peerId;
    await agent.createContextGraph({
      id: cg,
      name: 'Private Local CG Catalog Promote E2E',
      accessPolicy: 1,
      callerAgentAddress,
    });
    expect(await agent.getContextGraphOnChainId(cg)).toBeNull();

    const name = 'private-local-catalog-promote';
    await agent.assertion.create(cg, name);
    await agent.assertion.write(cg, name, [
      { subject: `${ENTITY_BASE}:plcp`, predicate: 'http://schema.org/name', object: '"Private Local Catalog Promote"' },
    ]);
    await agent.assertion.finalize(cg, name);

    const promoted = await agent.assertion.promote(cg, name);
    expect(promoted.sealed).toBe(true);
    expect(promoted.publishReady).toBe(true);

    const cgDid = `did:dkg:context-graph:${cg}`;
    const swmGraph = `${cgDid}/_shared_memory`;
    const swmMetaGraph = `${cgDid}/_shared_memory_meta`;
    const swmCatalog = await (agent as any).store.query(
      `SELECT ?p ?o WHERE { GRAPH <${swmGraph}> { <${cgDid}> ?p ?o } }`,
    );
    expect(swmCatalog.type).toBe('bindings');
    expect(swmCatalog.bindings).toHaveLength(0);

    const swmCatalogOwner = await (agent as any).store.query(
      `SELECT ?owner WHERE { GRAPH <${swmMetaGraph}> { <${cgDid}> <http://dkg.io/ontology/workspaceOwner> ?owner } }`,
    );
    expect(swmCatalogOwner.type).toBe('bindings');
    expect(swmCatalogOwner.bindings).toHaveLength(0);
  }, 30_000);

  // B3 (#1116 CORE REGRESSION GUARD): the seal is context-graph-INDEPENDENT, so
  // a default FULL share SEALS even when the CG was NEVER registered on-chain —
  // registration is deferred to publish time. This is the claim the existing
  // seal-decoupled tests do NOT cover (they register the CG first). A regression
  // that reintroduces seal-time CG registration FAILS the `getContextGraphOnChainId`
  // assertion below (the CG would already be on-chain after the share).
  it('seals a FULL share on an UNregistered CG (no seal-time registration); registers + publishes at publish time', async () => {
    const agent = await createAgent('UnregisteredCgSealBot');
    // LOCAL-ONLY CG: created but DELIBERATELY never registered on-chain.
    await agent.createContextGraph({ id: CG_ID, name: 'Unregistered CG Seal E2E' });

    const name = 'unregistered-cg-seal';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:ucs`, predicate: 'http://schema.org/name', object: '"Unregistered CG Seal"' },
    ]);

    // Default FULL share — must SEAL despite the CG being unregistered (the seal
    // no longer depends on CG registration).
    const fullShare = await agent.assertion.promote(CG_ID, name);
    expect(fullShare.sealed).toBe(true);
    expect(fullShare.publishReady).toBe(true);

    // CORE ASSERTION: the CG is STILL unregistered after sealing — sealing did
    // NOT register it on-chain. Reintroducing seal-time registration breaks here.
    const onChainIdAfterSeal = await agent.getContextGraphOnChainId(CG_ID);
    expect(onChainIdAfterSeal == null).toBe(true);

    // And publishing the unregistered CG fails CLOSED for that exact reason —
    // proving the registration gap is real (not silently papered over at seal).
    // #1116 (round 5, FIX 3b): assert BOTH the message AND the stable `.code`
    // (the route's auto-register branch keys on code-first; mirrors this file's
    // .code convention for SWM_SUBSET_NOT_SEALABLE / UNSEALED_SHARE_BLOCKED).
    let notRegisteredErr: any;
    try {
      await agent.publishFromFinalizedAssertion(CG_ID, name);
    } catch (e) {
      notRegisteredErr = e;
    }
    expect(notRegisteredErr).toBeTruthy();
    expect(notRegisteredErr.message).toMatch(/not registered on-chain/i);
    expect(notRegisteredErr.code).toBe('CG_NOT_REGISTERED');

    // Registration happens at PUBLISH time (the /vm/publish route's
    // ensureRegisteredForPublish step). After it, the same sealed asset publishes
    // to VM and confirms — no re-seal, no recreate.
    await agent.ensureRegisteredForPublish(CG_ID);
    const onChainIdAfterRegister = await agent.getContextGraphOnChainId(CG_ID);
    expect(onChainIdAfterRegister).toBeTruthy();

    const pub = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(pub.status).toBe('confirmed');
    expect(pub.ual).toBeDefined();
    expect(pub.seal).toBeDefined();
  }, 30_000);

  // #1116 (round 5 FIX 2 → round 9): a no-data precondition must fire BEFORE
  // registration so a doomed publish never burns mint gas. A finalized-but-
  // UNSHARED asset (valid seal, SWM empty) has NO swmShareComplete marker (no
  // promote ever ran), so round 9's marker gate (PUBLISH_NOT_FULL_SHARE) is now
  // the FIRST precondition — it fires before the publisher's CG-not-registered
  // guard, so the CG stays unregistered (no gas). (Round 5's SWM-empty preflight
  // is still present as a deeper backstop, but the marker gate wins here.)
  it('FIX 2: unregistered CG + finalized-but-UNSHARED asset rejects BEFORE registration (no gas burned)', async () => {
    const agent = await createAgent('NoQuadsBeforeRegisterBot');
    // DELIBERATELY unregistered, local-only CG.
    await agent.createContextGraph({ id: CG_ID, name: 'No Quads Before Register E2E' });

    const name = 'empty-swm-seal';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:nq`, predicate: 'http://schema.org/name', object: '"No Quads"' },
    ]);
    // Finalize the WM draft (seals it) WITHOUT promoting — SWM stays empty and
    // NO full-share marker is set.
    await agent.assertion.finalize(CG_ID, name);

    let thrown: any;
    try {
      await agent.publishFromFinalizedAssertion(CG_ID, name);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    // The not-a-full-share precondition fired first — NOT the registration guard.
    expect(thrown.code).toBe('PUBLISH_NOT_FULL_SHARE');
    expect(thrown.message).not.toMatch(/not registered on-chain/i);
    expect(thrown.code).not.toBe('CG_NOT_REGISTERED');

    // And the CG was NEVER registered as a side effect (no gas burned).
    const onChainId = await agent.getContextGraphOnChainId(CG_ID);
    expect(onChainId == null).toBe(true);
  }, 30_000);

  it('rejects a subject-subset share before any partial KA reaches SWM', async () => {
    const agent = await createAgent('SubsetNotSealableBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Subset Not Sealable E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'subset-share';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:a`, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: `${ENTITY_BASE}:b`, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    await expect(
      agent.assertion.promote(CG_ID, name, { entities: [`${ENTITY_BASE}:a`] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
    expect(await agent.assertion.query(CG_ID, name)).toHaveLength(2);
    expect(
      await agent.publisher.hasSwmShareComplete(
        CG_ID,
        name,
        agent.defaultAgentAddress ?? agent.peerId,
      ),
    ).toBe(false);
  }, 30_000);

  it('discard and recreate cannot resurrect a stale complete-share marker for a subset request', async () => {
    const agent = await createAgent('StaleMarkerBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Stale Marker E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'stale-marker';
    const writeAB = () => agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:a`, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: `${ENTITY_BASE}:b`, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    // 1. FULL share {A,B} — sets the full-share marker (seal-by-default).
    await agent.assertion.create(CG_ID, name);
    await writeAB();
    const full = await agent.assertion.promote(CG_ID, name);
    expect(full.sealed).toBe(true);

    // 2. Discard the (now-sealed-in-SWM) asset, then recreate the same name.
    await agent.assertion.discard(CG_ID, name);
    await agent.assertion.create(CG_ID, name);
    await writeAB();

    await expect(
      agent.assertion.promote(CG_ID, name, { entities: [`${ENTITY_BASE}:a`] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });

    // 4. Seal-in-SWM is refused: the marker was cleared at discard AND on the
    // subset share, so a partial asset can't be published under the KA name.
    let thrown: any;
    try {
      await agent.assertion.finalize(CG_ID, name, { layer: 'swm' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('SWM_SUBSET_NOT_SEALABLE');
  }, 30_000);

  it('a rejected subset re-share preserves the prior sealed exact SWM version', async () => {
    const agent = await createAgent('SubsetReshareNoDiscardBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Subset Reshare No Discard E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'subset-reshare';
    const writeAB = () => agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:a`, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: `${ENTITY_BASE}:b`, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    // 1. FULL share {A,B} — sets the full-share marker (seal-by-default).
    await agent.assertion.create(CG_ID, name);
    await writeAB();
    const full = await agent.assertion.promote(CG_ID, name);
    expect(full.sealed).toBe(true);

    // 2. Re-open the SAME name WITHOUT a discard — the full-share marker survives
    // this clean-slate via A2_PRESERVE (the exact carry-over that strands a stale
    // marker if the subset-clear branch is absent).
    await agent.assertion.create(CG_ID, name);
    await writeAB();

    await expect(
      agent.assertion.promote(CG_ID, name, { entities: [`${ENTITY_BASE}:a`] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });

    const recovered = await agent.assertion.pullFrom(CG_ID, name, 'swm', { onConflict: 'replace' });
    expect(recovered.seeded).toBe(2);
    const wm = await agent.assertion.query(CG_ID, name);
    expect(wm.map((quad) => quad.object).sort()).toEqual(['"Entity A"', '"Entity B"']);
  }, 30_000);

  it('rejects a full skipSeal share because v2 SWM content must be seal-bound', async () => {
    const agent = await createAgent('FullSkipSealBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Full SkipSeal E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'full-skipseal';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:fs`, predicate: 'http://schema.org/name', object: '"Full SkipSeal"' },
    ]);

    await expect(
      agent.assertion.promote(CG_ID, name, { skipSeal: true }),
    ).rejects.toMatchObject({ code: 'UNSEALED_SHARE_BLOCKED' });
    expect(await agent.assertion.query(CG_ID, name)).toHaveLength(1);
  }, 30_000);

  it('discard and recreate publishes only the new exact graph, without stale subjects', async () => {
    const agent = await createAgent('StaleSupersetBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Stale Superset E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'stale-superset';
    const A = `${ENTITY_BASE}:a`;
    const B = `${ENTITY_BASE}:b`;
    const C = `${ENTITY_BASE}:c`;
    // First exact version contains {A,C} but is discarded before publication.
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: C, predicate: 'http://schema.org/name', object: '"Entity C"' },
    ]);
    const first = await agent.assertion.promote(CG_ID, name);
    expect(first.sealed).toBe(true);

    // Recreate the same lifecycle name with the replacement atomic graph {A,B}.
    await agent.assertion.discard(CG_ID, name);
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"Entity A v2"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    const reshare = await agent.assertion.promote(CG_ID, name);
    expect(reshare.sealed).toBe(true);
    expect(reshare.publishReady).toBe(true);
    const pub = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(pub.status).toBe('confirmed');

    // 5. The published data graph holds A and B but NOT the stale C.
    const pubA = await agent.query(`SELECT ?n WHERE { <${A}> <http://schema.org/name> ?n }`, CG_ID);
    const pubB = await agent.query(`SELECT ?n WHERE { <${B}> <http://schema.org/name> ?n }`, CG_ID);
    const pubC = await agent.query(`SELECT ?n WHERE { <${C}> <http://schema.org/name> ?n }`, CG_ID);
    expect(pubA.bindings.length).toBeGreaterThan(0);
    expect(pubB.bindings.length).toBeGreaterThan(0);
    expect(pubC.bindings.length).toBe(0);
  }, 40_000);

  it('rejects an overwrite under a stale seal until the prior exact graph is explicitly recovered', async () => {
    const agent = await createAgent('StaleSupersetNoDiscardBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Stale Superset No Discard E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'stale-superset-nodiscard';
    const A = `${ENTITY_BASE}:a`;
    const B = `${ENTITY_BASE}:b`;
    const C = `${ENTITY_BASE}:c`;

    // First exact version is sealed and resident in SWM.
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: C, predicate: 'http://schema.org/name', object: '"Entity C"' },
    ]);
    await agent.assertion.promote(CG_ID, name);

    // 2. Re-open the SAME name WITHOUT discard, write {A, B}.
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"Entity A v2"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    await expect(agent.assertion.promote(CG_ID, name)).rejects.toThrow(
      /differs from its existing seal|different merkleRoot/i,
    );

    const recovered = await agent.assertion.pullFrom(CG_ID, name, 'swm', { onConflict: 'replace' });
    expect(recovered.seeded).toBe(2);
    const recoveredWm = await agent.assertion.query(CG_ID, name);
    expect(recoveredWm.map((quad) => quad.subject).sort()).toEqual([A, C].sort());
  }, 40_000);

  it('a rejected subset request cannot alter exact-graph pullFrom recovery', async () => {
    const agent = await createAgent('DirectPullSubsetBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Direct Pull Subset E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'direct-pull-subset';
    const A = `${ENTITY_BASE}:a`;
    const B = `${ENTITY_BASE}:b`;

    // 1. FULL share {A, B} — seals (stale seal {A,B}) + sets the full-share marker.
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);
    const full = await agent.assertion.promote(CG_ID, name);
    expect(full.sealed).toBe(true);

    // 2. Re-open the SAME name WITHOUT discard, write {A, B} again.
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"Entity A v2"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    await expect(
      agent.assertion.promote(CG_ID, name, { entities: [A] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });

    const pulled = await agent.assertion.pullFrom(CG_ID, name, 'swm', { onConflict: 'replace' });
    expect(pulled.seeded).toBe(2);
    const wm = await agent.assertion.query(CG_ID, name);
    expect(wm.map((quad) => quad.object).sort()).toEqual(['"Entity A"', '"Entity B"']);
  }, 40_000);

  // ── round 9: ONE seal-lifecycle invariant (the seal exists IFF a sealed,
  // COMPLETE full share resident in SWM). Every staleness path → blocked. ──

  // Probe: does the assertion SEAL exist on the name-keyed assertion URI in _meta?
  async function sealExists(agent: DKGAgent, cg: string, name: string): Promise<boolean> {
    const subj = contextGraphAssertionUri(cg, agent.defaultAgentAddress ?? agent.peerId, name);
    const metaGraph = contextGraphMetaUri(cg);
    for (const pred of Object.values(ASSERTION_SEAL_PREDICATES)) {
      const r = await agent.store.query(`ASK { GRAPH <${metaGraph}> { <${subj}> <${pred}> ?o } }`);
      if (r.type === 'boolean' && r.value) return true;
    }
    return false;
  }

  it('a rejected subset re-share preserves the prior seal and complete-share marker', async () => {
    const agent = await createAgent('Round9SubsetBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Round9 Subset E2E' });
    await agent.registerContextGraph(CG_ID);
    const name = 'r9-subset';
    const A = `${ENTITY_BASE}:a`, B = `${ENTITY_BASE}:b`;

    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"A"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"B"' },
    ]);
    const full = await agent.assertion.promote(CG_ID, name);
    expect(full.sealed).toBe(true);
    expect(await sealExists(agent, CG_ID, name)).toBe(true);

    // Re-open (no discard) + subset {A} re-share — non-sealing → clears the seal.
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"A2"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"B2"' },
    ]);
    await expect(
      agent.assertion.promote(CG_ID, name, { entities: [A] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
    expect(await sealExists(agent, CG_ID, name)).toBe(true);
    expect(
      await agent.publisher.hasSwmShareComplete(
        CG_ID,
        name,
        agent.defaultAgentAddress ?? agent.peerId,
      ),
    ).toBe(true);
  }, 40_000);

  it('a rejected skipSeal re-share preserves the prior sealed exact graph', async () => {
    const agent = await createAgent('Round9SkipSealBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Round9 SkipSeal E2E' });
    await agent.registerContextGraph(CG_ID);
    const name = 'r9-skipseal';
    const A = `${ENTITY_BASE}:a`, B = `${ENTITY_BASE}:b`;

    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"A"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"B"' },
    ]);
    await agent.assertion.promote(CG_ID, name);
    expect(await sealExists(agent, CG_ID, name)).toBe(true);

    // Re-open (no discard) and attempt the removed unsealed mutation path.
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"A2"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"B2"' },
    ]);
    await expect(
      agent.assertion.promote(CG_ID, name, { skipSeal: true }),
    ).rejects.toMatchObject({ code: 'UNSEALED_SHARE_BLOCKED' });
    expect(await sealExists(agent, CG_ID, name)).toBe(true);
    const recovered = await agent.assertion.pullFrom(CG_ID, name, 'swm', { onConflict: 'replace' });
    expect(recovered.seeded).toBe(2);
    expect((await agent.assertion.query(CG_ID, name)).map((quad) => quad.object).sort()).toEqual(['"A"', '"B"']);
  }, 40_000);

  // (d) a CONFIRMED publish CLEARS the marker (step 3); a subsequent
  // finalize(layer:swm) REJECTS (SWM_SUBSET_NOT_SEALABLE — the marker is gone)
  // WITHOUT stranding the seal (the wrapper pre-clear is gone, step 4).
  it('round 9 (d): confirmed publish clears the marker; a later finalize(layer:swm) rejects without stranding the seal', async () => {
    const agent = await createAgent('Round9PostPublishBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Round9 PostPublish E2E' });
    await agent.registerContextGraph(CG_ID);
    const name = 'r9-postpub';
    const A = `${ENTITY_BASE}:a`;

    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [{ subject: A, predicate: 'http://schema.org/name', object: '"A"' }]);
    await agent.assertion.promote(CG_ID, name);
    expect(await agent.publisher.hasSwmShareComplete(CG_ID, name, agent.defaultAgentAddress ?? agent.peerId)).toBe(true);

    const pub = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(pub.status).toBe('confirmed');
    // step 3: the confirmed publish consumed the SWM share → marker cleared.
    expect(await agent.publisher.hasSwmShareComplete(CG_ID, name, agent.defaultAgentAddress ?? agent.peerId)).toBe(false);

    // A post-publish seal-in-SWM must REJECT (no live full share) and must NOT
    // strand the seal (the published seal survives for VM ops).
    const sealBefore = await sealExists(agent, CG_ID, name);
    let thrown: any;
    try { await agent.assertion.finalize(CG_ID, name, { layer: 'swm' }); } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('SWM_SUBSET_NOT_SEALABLE');
    expect(await sealExists(agent, CG_ID, name)).toBe(sealBefore); // seal not stranded
  }, 40_000);

  // (e) finalize(layer:swm) whose SWM is EMPTY but the marker survived (simulate by
  // clearing SWM after a full share) no longer strands the seal — the wrapper
  // pre-clear is gone (step 4), so a PULL_FROM_EMPTY_SOURCE leaves the seal intact.
  it('round 9 (e): finalize(layer:swm) on an empty-SWM (marker survived) does NOT strand the seal', async () => {
    const agent = await createAgent('Round9NoStrandBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Round9 NoStrand E2E' });
    await agent.registerContextGraph(CG_ID);
    const name = 'r9-nostrand';
    const A = `${ENTITY_BASE}:a`;
    const addr = agent.defaultAgentAddress ?? agent.peerId;

    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [{ subject: A, predicate: 'http://schema.org/name', object: '"A"' }]);
    await agent.assertion.promote(CG_ID, name); // full share: seal + marker + SWM content
    expect(await sealExists(agent, CG_ID, name)).toBe(true);

    // Simulate an empty SWM while the marker survives: drain the SWM roots directly
    // (without clearing the marker), mimicking a consumed/missing SWM slice.
    await agent.publisher.clearPublishedSwmRoots(CG_ID, [A], undefined, createOperationContext('publishFromSWM'));

    // finalize(layer:swm) passes the marker gate, runs pull-from which finds an
    // EMPTY source → PULL_FROM_EMPTY_SOURCE. The seal must SURVIVE (atomic-on-failure).
    let thrown: any;
    try { await agent.assertion.finalize(CG_ID, name, { layer: 'swm' }); } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('PULL_FROM_EMPTY_SOURCE');
    expect(await sealExists(agent, CG_ID, name)).toBe(true); // NOT stranded (step 4)
  }, 40_000);

  // C (review): a DEFAULT full share whose internal seal FAILS with a residual
  // capability gap (NOT skipSeal, NOT stale/corrupt) must fail CLOSED:
  // UNSEALED_SHARE_BLOCKED is thrown BEFORE assertionPromote, so WM is preserved
  // (non-empty, not promoted) and SWM gains no new promotion.
  it('a full share whose seal fails (capability gap) fails closed with UNSEALED_SHARE_BLOCKED, preserving WM', async () => {
    const agent = await createAgent('UnsealedBlockedBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Unsealed Blocked E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'capability-gap';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:cg`, predicate: 'http://schema.org/name', object: '"Capability Gap"' },
    ]);

    // Inject a CAPABILITY-GAP finalize failure (round 11: tagged with the stable
    // SEAL_CAPABILITY_GAP_CODE, exactly as assertionFinalize tags a no-signing-key /
    // non-V10-adapter / KA-number gap). promote() classifies it as recoverable and
    // wraps it as UNSEALED_SHARE_BLOCKED, failing BEFORE promoting.
    const spy = vi
      .spyOn(agent, 'assertionFinalize')
      .mockRejectedValue(Object.assign(
        new Error('assertionFinalize: custodial agent 0x.. has no private key on file'),
        { code: SEAL_CAPABILITY_GAP_CODE },
      ));
    try {
      let thrown: any;
      try {
        await agent.assertion.promote(CG_ID, name); // DEFAULT full share — seals by default.
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeTruthy();
      expect(thrown.code).toBe('UNSEALED_SHARE_BLOCKED');
      expect(typeof thrown.recovery).toBe('string');
    } finally {
      spy.mockRestore();
    }

    // WM draft is PRESERVED (not emptied by a doomed promote).
    const wmAfter = await agent.assertion.query(CG_ID, name);
    expect(wmAfter.length).toBeGreaterThan(0);

    // SWM gained NO new promotion — the entity never reached shared memory.
    const swmAfter = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:cg> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swmAfter.bindings.length).toBe(0);
  }, 30_000);

  // round 11 (reviewer 🟡 #2): a VALIDATION/integrity finalize error (NOT a
  // capability gap) must PROPAGATE with its ORIGINAL code — NOT be re-wrapped as
  // UNSEALED_SHARE_BLOCKED (whose recovery hint says "skipSeal:true", which would
  // push the invalid content into SWM). And it must NOT be promoted.
  it('round 11: a VALIDATION finalize error propagates (original error, NOT UNSEALED_SHARE_BLOCKED, NOT promoted)', async () => {
    const agent = await createAgent('ValidationNotUnsealedBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Validation E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'validation-err';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:val`, predicate: 'http://schema.org/name', object: '"Valid"' },
    ]);

    // A validation error has NO SEAL_CAPABILITY_GAP code and does NOT match the
    // capability message regex — promote() must rethrow it untouched.
    const spy = vi
      .spyOn(agent, 'assertionFinalize')
      .mockRejectedValue(Object.assign(
        new Error('Cannot finalize assertion <...>: it has no quads. Write at least one quad before finalizing.'),
        { code: 'SOME_VALIDATION_CODE' },
      ));
    try {
      let thrown: any;
      try {
        await agent.assertion.promote(CG_ID, name);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeTruthy();
      // The ORIGINAL error surfaces — not the UNSEALED_SHARE_BLOCKED wrapper.
      expect(thrown.code).toBe('SOME_VALIDATION_CODE');
      expect(thrown.code).not.toBe('UNSEALED_SHARE_BLOCKED');
      expect(String(thrown.message)).toMatch(/it has no quads/);
    } finally {
      spy.mockRestore();
    }

    // WM preserved; nothing promoted to SWM.
    expect((await agent.assertion.query(CG_ID, name)).length).toBeGreaterThan(0);
    const swmAfter = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:val> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swmAfter.bindings.length).toBe(0);
  }, 30_000);

  // round 11 (reviewer 🔴 #1): the non-sealing seal-clear is TRANSACTIONAL — it
  // runs only AFTER assertionPromote COMMITS. A non-sealing share whose promote
  // THROWS must NOT clear a prior full-share seal (the old SWM content + seal stay
  // valid, so the asset stays publishable until a share actually succeeds).
  it('round 11: a non-sealing share whose PROMOTE FAILS does NOT clear the prior seal', async () => {
    const agent = await createAgent('TxnSealClearFailBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Txn Seal Clear Fail E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'txn-fail';
    const A = `${ENTITY_BASE}:a`, B = `${ENTITY_BASE}:b`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"A"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"B"' },
    ]);
    // FULL share → seal present.
    await agent.assertion.promote(CG_ID, name);
    expect(await sealExists(agent, CG_ID, name)).toBe(true);

    // Re-open (no discard) + write, then a SUBSET (non-sealing) share whose
    // assertionPromote THROWS (simulate a curator-unconfirmed / payload failure).
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"A2"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"B2"' },
    ]);
    const spy = vi
      .spyOn(agent.publisher, 'assertionPromote')
      .mockRejectedValue(new Error('simulated promote failure (curator unconfirmed)'));
    try {
      await expect(agent.assertion.promote(CG_ID, name, { entities: [A] })).rejects.toThrow(/simulated promote failure/);
    } finally {
      spy.mockRestore();
    }

    // The prior seal MUST survive the failed non-sealing share (round 11 fix).
    expect(await sealExists(agent, CG_ID, name)).toBe(true);
  }, 30_000);

  it('a selective share is rejected before commit and cannot clear the prior seal', async () => {
    const agent = await createAgent('TxnSealClearOkBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Txn Seal Clear Ok E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'txn-ok';
    const A = `${ENTITY_BASE}:a`, B = `${ENTITY_BASE}:b`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"A"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"B"' },
    ]);
    await agent.assertion.promote(CG_ID, name);
    expect(await sealExists(agent, CG_ID, name)).toBe(true);

    // Re-open + a selective request. Atomic v2 rejects it before commit.
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"A2"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"B2"' },
    ]);
    await expect(
      agent.assertion.promote(CG_ID, name, { entities: [A] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
    expect(await sealExists(agent, CG_ID, name)).toBe(true);
  }, 30_000);
});

describe('WM → SWM gossip → VM (2 nodes)', () => {
  async function pollUntil(
    queryFn: () => Promise<{ bindings: any[] }>,
    predicate: (bindings: any[]) => boolean,
    timeoutMs: number,
  ): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    let lastResult: any[] = [];
    while (Date.now() < deadline) {
      const result = await queryFn();
      lastResult = result.bindings;
      if (predicate(lastResult)) return lastResult;
      await sleep(500);
    }
    return lastResult;
  }

  it('A drafts in WM → promotes to SWM → gossips to B → publishes → B finalizes', async () => {
    const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'LayersA',
      listenPort: 0,
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    agents.push(nodeA);

    const nodeB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'LayersB',
      listenPort: 0,
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    agents.push(nodeB);

    await nodeA.start();
    await nodeB.start();
    await sleep(500);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(2000);

    await nodeA.createContextGraph({ id: CG_ID, name: 'Two-Node Memory Layers' });
    await nodeA.registerContextGraph(CG_ID);
    nodeA.subscribeToContextGraph(CG_ID);
    nodeB.subscribeToContextGraph(CG_ID);
    await sleep(1500);

    // Step 1: A creates assertion in WM
    await nodeA.assertion.create(CG_ID, 'two-node-draft');
    await nodeA.assertion.write(CG_ID, 'two-node-draft', [
      { subject: `${ENTITY_BASE}:two-node`, predicate: 'http://schema.org/name', object: '"Two Node Entity"' },
    ]);

    // Step 2: A promotes to SWM (gossips to B)
    await nodeA.assertion.promote(CG_ID, 'two-node-draft');

    // Step 3: B receives via gossip
    const bSwm = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_BASE}:two-node> <http://schema.org/name> ?name }`,
        { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
      ),
      (b) => b.length > 0,
      15_000,
    );
    expect(bSwm.length).toBe(1);
    expect(bSwm[0]?.['name']).toBe('"Two Node Entity"');

    // Step 4: A publishes from SWM → chain
    const pubResult = await nodeA.publishFromSharedMemory(CG_ID, 'all');
    expect(pubResult.status).toBe('confirmed');

    // Step 5: B receives finalization → promotes to data graph
    const bData = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_BASE}:two-node> <http://schema.org/name> ?name }`,
        CG_ID,
      ),
      (b) => b.length > 0,
      20_000,
    );
    expect(bData.length).toBe(1);
    expect(bData[0]?.['name']).toBe('"Two Node Entity"');
  }, 60_000);
});

describe('Query views', () => {
  it('includeSharedMemory merges SWM data into query results', async () => {
    const agent = await createAgent('ViewBot');
    await agent.createContextGraph({ id: CG_ID, name: 'View E2E' });

    // Put data in canonical graph via publish
    await agent.publish(CG_ID, [
      { subject: `${ENTITY_BASE}:canonical`, predicate: 'http://schema.org/name', object: '"Canonical"', graph: '' },
    ]);

    // Put data in SWM
    await agent.share(CG_ID, [
      { subject: `${ENTITY_BASE}:shared`, predicate: 'http://schema.org/name', object: '"Shared"', graph: '' },
    ], { localOnly: true });

    // Default query (data graph only) — should see canonical
    const defaultResult = await agent.query(
      `SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }`,
      CG_ID,
    );
    const defaultSubjects = defaultResult.bindings.map((b: any) => b['s']);
    expect(defaultSubjects.some((s: string) => s.includes('canonical'))).toBe(true);

    // includeSharedMemory — should see both
    const mergedResult = await agent.query(
      `SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, includeSharedMemory: true },
    );
    const mergedSubjects = mergedResult.bindings.map((b: any) => b['s']);
    expect(mergedSubjects.some((s: string) => s.includes('canonical'))).toBe(true);
    expect(mergedSubjects.some((s: string) => s.includes('shared'))).toBe(true);
  }, 15_000);
});
