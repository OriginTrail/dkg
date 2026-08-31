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
import { buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import {
  SWM_CURRENT_ASSERTION_PRED,
  TripleStoreAsyncLiftPublisher,
} from '@origintrail-official/dkg-publisher';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';
import { extractFromMarkdown } from '../../cli/src/extraction/markdown-extractor.js';
import {
  assertionLifecycleUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryMetaUri,
  contextGraphAssertionUri,
  contextGraphLayerUri,
  ASSERTION_SEAL_PREDICATES,
  ASSERTION_PUBLISH_RECEIPT_PREDICATES,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
} from '@origintrail-official/dkg-core';
import { makeSwmSyncHarness } from './_helpers/swm-sync-harness.js';

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

  it('returns a named WM to SWM promote before the RFC-64 inventory shadow settles', async () => {
    const contextGraphId = 'shadow-promote-nonblocking';
    const name = 'shadow-nonblocking';
    const agent = await createAgent('ShadowPromoteNonblockingBot');
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Shadow Promote Nonblocking',
    });
    await agent.registerContextGraph(contextGraphId);
    await agent.assertion.create(contextGraphId, name);
    await agent.assertion.write(contextGraphId, name, [{
      subject: `${ENTITY_BASE}:shadow`,
      predicate: 'http://schema.org/name',
      object: '"Shadow remains observational"',
    }]);
    let releaseShadow!: () => void;
    const deferredShadow = new Promise<void>((resolve) => { releaseShadow = resolve; });
    const shadow = vi
      .spyOn(agent, 'recordRfc64SwmAuthorInventoryShadowV1')
      .mockImplementation(async () => {
        await deferredShadow;
        return {
          status: 'dormant',
          action: 'upsert',
          attempts: 0,
          headObjectDigest: null,
          error: null,
        };
      });

    const result = await Promise.race([
      agent.assertion.promote(contextGraphId, name),
      sleep(2_000).then(() => { throw new Error('promote waited for shadow observer'); }),
    ]);

    expect(result.sealed).toBe(true);
    expect(result.publishReady).toBe(true);
    expect(result.shareOperationId).toEqual(expect.any(String));
    expect(shadow).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      assertionCoordinate: name,
      shareOperationId: result.shareOperationId,
    }));
    expect(agent.inFlightRfc64SwmInventoryObserverCountV1()).toBe(1);
    releaseShadow();
    await agent.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(agent.inFlightRfc64SwmInventoryObserverCountV1()).toBe(0);
    const swm = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:shadow> <http://schema.org/name> ?name }`,
      { contextGraphId, graphSuffix: '_shared_memory' },
    );
    expect(swm.bindings).toHaveLength(1);
    shadow.mockRestore();
  }, 30_000);

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

    const publicDraftProbe = vi.spyOn(agent.publisher, 'assertionQuery');
    const privateDraftProbe = vi.spyOn(agent.publisher, 'assertionQueryPrivate');
    const finalize = vi.spyOn(agent as any, 'assertionFinalize');
    const publisherPromote = vi.spyOn(agent.publisher, 'assertionPromote');
    await expect(
      agent.assertion.promote(CG_ID, 'selective', { entities: [`${ENTITY_BASE}:a`] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
    expect(publicDraftProbe).not.toHaveBeenCalled();
    expect(privateDraftProbe).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(publisherPromote).not.toHaveBeenCalled();
    publicDraftProbe.mockRestore();
    privateDraftProbe.mockRestore();
    finalize.mockRestore();
    publisherPromote.mockRestore();

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

  it('forwards onPublishConfirmed through the real queued rails on create and update [GH#2359 r2 3877540365]', async () => {
    // The production glue this pins: the async publisher injects its receipt hook into the
    // execution input, the REAL handler hands publishOptions to
    // publishQueuedKnowledgeAssetVmPublish, the agent's one-object executionHooks spread
    // forwards it, and DKGPublisher fires it at receipt time. The spies wrap (never stub) the
    // underlying publisher entry points to prove the SAME callback arrived and fires — for the
    // create branch and the update branch. Dropping the field at any reconstruction turns the
    // captured hook undefined and this row red.
    const agent = await createAgent('QueuedConfirmForwardBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Confirm Forward E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-confirm-forward';
    const root = `${ENTITY_BASE}:queued-confirm-forward`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Confirm Forward v1"' },
    ]);
    await agent.assertion.promote(CG_ID, name);
    const createIntent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);

    const underlying = (agent as any).publisher;
    // r5 (3877726512) - IDENTITY, not just presence: the hook captured at the real handler
    // boundary must be the SAME reference that reaches each underlying publisher entry point,
    // so a substitution anywhere in the agent's option reconstructions cannot pass.
    const handlerHooks: unknown[] = [];
    let createHookForwarded: unknown = 'unset';
    const createFired: string[] = [];
    const realPublish = underlying.publish.bind(underlying);
    underlying.publish = async (options: any) => {
      const original = options.onPublishConfirmed;
      createHookForwarded = original;
      return realPublish({
        ...options,
        onPublishConfirmed: (confirmation: { txHash: string }) => {
          createFired.push(confirmation.txHash);
          return original?.(confirmation);
        },
      });
    };

    const asyncPublisher = new TripleStoreAsyncLiftPublisher((agent as any).store, {
      knowledgeAssetVmPublishHandler: {
        preflight: ({ request }) => agent.preflightQueuedKnowledgeAssetVmPublishExecution(request),
        execute: async ({ request, publishOptions }) => {
          handlerHooks.push(publishOptions.onPublishConfirmed);
          return agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions);
        },
      },
    });
    const createJob = await asyncPublisher.enqueueKnowledgeAssetVmPublish(createIntent);
    const createProcessed = await asyncPublisher.processNext('wallet-1');
    expect(createProcessed?.jobId).toBe(createJob);
    expect(createProcessed?.status).toBe('finalized');
    // The async publisher's injected hook survived every option reconstruction to the
    // underlying publisher AS THE SAME REFERENCE, and fired with the receipt hash.
    expect(typeof handlerHooks[0]).toBe('function');
    expect(createHookForwarded).toBe(handlerHooks[0]);
    expect(createFired).toHaveLength(1);
    expect(createFired[0]).toMatch(/^0x[0-9a-f]+$/i);

    // UPDATE branch: reopen the published assertion, revise, promote - the second intent
    // resolves to the update rails.
    const reopened = await agent.assertion.pullFrom(CG_ID, name, 'vm', { onConflict: 'replace' });
    expect(reopened.seeded).toBe(1);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Confirm Forward v2"' },
    ]);
    await agent.assertion.finalize(CG_ID, name);
    await agent.assertion.promote(CG_ID, name);
    const updateIntent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);

    let updateHookForwarded: unknown = 'unset';
    const updateFired: string[] = [];
    const realUpdate = underlying.updateKnowledgeAssetFromStagedSharedWorkingMemoryV1.bind(underlying);
    underlying.updateKnowledgeAssetFromStagedSharedWorkingMemoryV1 = async (kaId: bigint, options: any) => {
      const original = options.onPublishConfirmed;
      updateHookForwarded = original;
      return realUpdate(kaId, {
        ...options,
        onPublishConfirmed: (confirmation: { txHash: string }) => {
          updateFired.push(confirmation.txHash);
          return original?.(confirmation);
        },
      });
    };

    const updateJob = await asyncPublisher.enqueueKnowledgeAssetVmPublish(updateIntent);
    const updateProcessed = await asyncPublisher.processNext('wallet-1');
    expect(updateProcessed?.jobId).toBe(updateJob);
    expect(updateProcessed?.status).toBe('finalized');
    expect(typeof handlerHooks[1]).toBe('function');
    expect(updateHookForwarded).toBe(handlerHooks[1]);
    expect(updateFired).toHaveLength(1);
    expect(updateFired[0]).toMatch(/^0x[0-9a-f]+$/i);
  }, 90_000);

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

    // Rootless metadata trimming consumes the lifecycle-level operation row
    // once the immutable SWM snapshot and head are durable. The promoted
    // event remains the canonical lifecycle reference. Revalidation must read
    // that same shape instead of rejecting an otherwise unchanged queued job.
    const author = agent.defaultAgentAddress ?? agent.peerId;
    await (agent as any).store.deleteByPattern({
      graph: contextGraphMetaUri(CG_ID),
      subject: assertionLifecycleUri(CG_ID, author, name),
      predicate: 'http://dkg.io/ontology/shareOperationId',
    });
    const trimmedHistory = await agent.assertion.history(CG_ID, name);
    expect(trimmedHistory?.currentShareOperationId).toBeUndefined();
    expect(trimmedHistory?.events.find((event) => event.type === 'promoted')?.shareOperationId)
      .toBe(share.shareOperationId);

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
    const recoveryChain = (agent as unknown as { chain: {
      chainId: string;
      getDKGKnowledgeAssetsAddress(): Promise<string>;
    } }).chain;
    const knowledgeAssetsContract = onChain.knowledgeAssetsContract
      ?? await recoveryChain.getDKGKnowledgeAssetsAddress();
    const receiptUal = buildKnowledgeAssetUal(
      recoveryChain.chainId,
      knowledgeAssetsContract,
      kaId,
    );
    expect(receiptUal).not.toBe(intent.kaUal);
    const recoveryPublisher = (agent as any).publisher;
    const recoveryCleanup = vi.spyOn(recoveryPublisher, 'clearPublishedKnowledgeAssetSwm');
    const recoveryRequest = { ...intent, clearSharedMemoryAfter: true } as const;
    const recoveryInput = {
      walletId: 'wallet-1',
      request: recoveryRequest,
      // GH#2270 PR-3 r3 — the typed transaction facts the finalizer reads; `job.broadcast`
      // stays only as the optional merkle-root cross-check carrier.
      lookup: { txHash, walletId: 'wallet-1' },
      job: {
        jobId: 'recovery-job',
        jobSlug: 'recovery-job',
        request: { jobType: 'knowledge-asset-vm-publish', knowledgeAssetVmPublish: recoveryRequest },
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
          blockHash: `0x${'ab'.repeat(32)}`,
          blockTimestamp: onChain.blockTimestamp,
        },
        finalization: {
          mode: 'published',
          txHash,
          // GH#1966: for graph-scoped named KAs the production CLI recovery
          // resolver overrides finalization.ual with the graph-local queued UAL
          // (author + low-96 KA number) — the same identity a normal publish
          // records — NOT the contract/packed-id receipt form. Recovery must
          // accept it; the finalizer keeps using intent.kaUal for the local graph.
          ual: intent.kaUal,
          batchId: kaId.toString(),
          startKAId: kaId.toString(),
          endKAId: kaId.toString(),
          publisherAddress: onChain.publisherAddress as `0x${string}`,
        },
        publishProof: {
          merkleRoot: intent.sealMerkleRoot,
          authorAddress: intent.seal.authorAddress,
          txIndex: 4,
        },
      },
      publisher: recoveryPublisher,
    } as const;

    for (const invalidReceiptUal of [
      buildKnowledgeAssetUal(
        recoveryChain.chainId,
        '0x0000000000000000000000000000000000000001',
        kaId,
      ),
      buildKnowledgeAssetUal('evm:1', knowledgeAssetsContract, kaId),
      buildKnowledgeAssetUal(recoveryChain.chainId, knowledgeAssetsContract, kaId + 1n),
    ]) {
      await expect(agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
        ...recoveryInput,
        recovery: {
          ...recoveryInput.recovery,
          finalization: {
            ...recoveryInput.recovery.finalization,
            ual: invalidReceiptUal,
          },
        },
      } as any)).rejects.toMatchObject({ code: 'KA_VM_RECOVERY_INCONSISTENT' });
    }
    const queuedScope = createGraphKnowledgeAssetScope(
      intent.kaUal!,
      intent.assertionVersion!,
    );
    const wrongLocalChain = queuedScope.chainId === 'evm:1' ? 'evm:2' : 'evm:1';
    for (const invalidGraphUal of [
      `did:dkg:${wrongLocalChain}/${queuedScope.agentAddress}/${queuedScope.kaNumber}`,
      `did:dkg:${queuedScope.chainId}/0x0000000000000000000000000000000000000001/${queuedScope.kaNumber}`,
      `did:dkg:${queuedScope.chainId}/${queuedScope.agentAddress}/${BigInt(queuedScope.kaNumber) + 1n}`,
    ]) {
      await expect(agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
        ...recoveryInput,
        request: { ...recoveryInput.request, kaUal: invalidGraphUal },
      } as any)).rejects.toMatchObject({ code: 'KA_VM_RECOVERY_INCONSISTENT' });
    }

    await expect(agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
      ...recoveryInput,
      request: {
        ...recoveryInput.request,
        publicTripleCount: recoveryInput.request.publicTripleCount! + 1,
      },
    } as any)).rejects.toMatchObject({ code: 'KA_VM_RECOVERY_INCONSISTENT' });

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

    const snapshotOutage = new Error('operation snapshot store unavailable');
    const originalQuery = store.query.bind(store);
    const snapshotQuery = vi.spyOn(store, 'query').mockImplementation(
      async (sparql: string, ...args: unknown[]) => {
        if (sparql.includes('publicSnapshotRef')) throw snapshotOutage;
        return originalQuery(sparql, ...args);
      },
    );
    await expect(
      agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(recoveryInput as any),
    ).rejects.toBe(snapshotOutage);
    snapshotQuery.mockRestore();

    const operationSubject = `urn:dkg:share:${CG_ID}:${intent.shareOperationId}`;
    await store.deleteByPattern({
      graph: contextGraphSharedMemoryMetaUri(CG_ID),
      subject: operationSubject,
    });

    // r29 (🔴 3822354184 / 🔴 3822354192) — the deadline at the REAL mutation boundary, on the
    // CURRENT-version path. The previous row stopped inside the read-only normalizer, which cannot
    // mutate anything, so it could not see that the r28 guard sat inside the superseded branch
    // while `handleChainReconciledKC` on this path ran unguarded. An expired pass must not begin
    // lifecycle materialization while it still holds the claim lock.
    //
    // The abort is armed BEFORE the call, so the deadline is already reached by the time the reads
    // finish and the mutation would start. The spy is the observable: the finalization handler is
    // the mutating collaborator, and it must never be entered.
    // r29 (🔴 3822354184 / 🔴 3822354192) — the deadline at the REAL mutation boundary. The
    // previous row stopped inside the read-only normalizer, which cannot mutate anything, so it
    // could not see that the r28 guard sat inside the superseded branch while the current-version
    // materialization ran unguarded.
    //
    // The observable is the ERROR IDENTITY, not a spy on the finalization handler: that handler is
    // shared with the SWM host reconcile lane, which touches this same asset, so a call count
    // there answers a question about someone else's work (it counted 1 even when the guard was
    // correct). Error identity is specific by construction.
    //
    // The argument the row rests on: the abort is fired from inside a LATE read — the context
    // graph id lookup, which runs after the normalizer has finished all of its own deadline
    // checks. So the deadline cannot be reached by any guard before that point. If the call then
    // rejects with the recovery deadline error, the only guard that can have raised it is one
    // AFTER the reads, i.e. a mutation boundary. That is exactly what must exist.
    {
      const expired = new AbortController();
      const realCgId = agent.getContextGraphOnChainId.bind(agent);
      agent.getContextGraphOnChainId = (async (...args: unknown[]) => {
        const value = await realCgId(...(args as Parameters<typeof realCgId>));
        expired.abort();
        return value;
      }) as typeof agent.getContextGraphOnChainId;

      try {
        await expect(agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
          ...recoveryInput,
          signal: expired.signal,
        } as any)).rejects.toMatchObject({ name: 'RecoveryDeadlineReachedError' });
      } finally {
        agent.getContextGraphOnChainId = realCgId;
      }
    }

    // Confirmed publishes always remove their exact SWM operation metadata;
    // `clearSharedMemoryAfter=false` only preserves OTHER unpublished content.
    // Recovery must therefore accept the immutable seal envelope after strict
    // chain proof even when the operator did not request a family-wide clear.
    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
      ...recoveryInput,
      request: { ...recoveryInput.request, clearSharedMemoryAfter: false },
    } as any);
    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(recoveryInput as any);
    expect(recoveryCleanup).not.toHaveBeenCalled();

    // PR #2300 r1 (🟡 3809054841) — the record shape item 5 exists for: a persisted FAILED job
    // held on the recovery carrier alone (`recovery.txHashChecked`, NO `broadcast`). The REAL
    // finalizer must complete lifecycle materialization from `lookup.txHash`; a regression that
    // reads `job.broadcast.txHash` anywhere on this path throws on this input and fails the row.
    // PR #2300 r5 (3812275752) — reset the lifecycle to its PRE-recovery state first. Without
    // this the assertions below describe what the earlier invocation already produced, so a
    // carrier-only call that silently did nothing would still leave the row green.
    for (const predicate of [
      `${DKG}publishedUal`,
      `${DKG}vmCurrentAssertion`,
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
    // The premise: the lifecycle really is un-published again, so anything asserted after the
    // carrier-only call is that call's own work.
    expect((await agent.assertion.history(CG_ID, name))?.status).not.toBe('vm-confirmed');

    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
      ...recoveryInput,
      job: {
        jobId: 'carrier-only-recovery-job',
        jobSlug: 'carrier-only-recovery-job',
        request: { jobType: 'knowledge-asset-vm-publish', knowledgeAssetVmPublish: recoveryRequest },
        status: 'failed',
        failure: {
          failedFromState: 'claimed',
          code: 'workspace_unavailable',
          retryable: true,
          resolution: 'reset_to_accepted',
          message: 'held on the recovery carrier alone',
          errorPayloadRef: 'urn:dkg:test:error:carrier-only',
          occurredAt: 3,
        },
        recovery: { action: 'reset_to_accepted', recoveredFromStatus: 'broadcast', txHashChecked: txHash },
        timestamps: { acceptedAt: 1, failedAt: 3, updatedAt: 3 },
        retries: { retryCount: 0, maxRetries: 10 },
        controlPlane: {},
      },
    } as any);
    expect((await agent.assertion.history(CG_ID, name))?.status).toBe('vm-confirmed');

    const history = await agent.assertion.history(CG_ID, name);
    expect(history?.state).toBe('published');
    expect(history?.memoryLayer).toBe(MemoryLayer.VerifiableMemory);
    expect(history?.status).toBe('vm-confirmed');
    expect(history?.vmCurrentAssertion).toBe(intent.sealMerkleRoot.slice(2));
    // GH#1966: recovery stamps the graph-local UAL the resolver returned, matching
    // what a normal named-KA publish records (not the contract/packed receipt form).
    expect(history?.publishedUal).toBe(intent.kaUal);
    expect(history?.assertionGraph).toBe(contextGraphLayerUri(
      CG_ID,
      MemoryLayer.VerifiableMemory,
      queuedScope.agentAddress,
      BigInt(queuedScope.kaNumber),
    ));
    expect(intent.accessPolicy).toBe('public');
    const recoveredAccessPolicy = await store.query(`ASK { GRAPH <${metaGraph}> {
      <${intent.kaUal}> <${DKG}accessPolicy> "public" .
    } }`);
    expect(recoveredAccessPolicy).toMatchObject({ type: 'boolean', value: true });

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
    expect(updateIntent.sealMerkleRoot).not.toBe(intent.sealMerkleRoot);

    // The v1 chain transaction remains recoverable after an unpublished v2
    // advances the mutable workspace head. Recovery stamps its lost receipt
    // without regressing the current v2 SWM lifecycle back to published v1.
    for (const predicate of Object.values(ASSERTION_PUBLISH_RECEIPT_PREDICATES)) {
      await store.deleteByPattern({ subject: assertionUri, predicate, graph: metaGraph });
    }
    const beforeStagedRecovery = await agent.assertion.history(CG_ID, name);
    expect(beforeStagedRecovery?.state).toBe('promoted');
    expect(beforeStagedRecovery?.swmCurrentAssertion).toBe(updateIntent.sealMerkleRoot.slice(2));
    expect(beforeStagedRecovery?.vmCurrentAssertion).toBe(intent.sealMerkleRoot.slice(2));

    // Simulate a crash between the workspace-head delete and insert. The named
    // lifecycle has already advanced to v2, so v1 recovery must use that
    // independent signal and refuse to stamp the lifecycle backward.
    const sharedMetaGraph = contextGraphSharedMemoryMetaUri(CG_ID);
    const workspaceHeadSubject = `${intent.kaUal}#dkg-swm-head`;
    const workspaceHeadRows = await store.query(
      `CONSTRUCT { <${workspaceHeadSubject}> ?p ?o } WHERE { GRAPH <${sharedMetaGraph}> {
        <${workspaceHeadSubject}> ?p ?o
      } }`,
    );
    if (workspaceHeadRows.type !== 'quads' || workspaceHeadRows.quads.length === 0) {
      throw new Error('expected staged v2 workspace head');
    }
    await store.deleteByPattern({ graph: sharedMetaGraph, subject: workspaceHeadSubject });

    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(recoveryInput as any);

    const afterStagedRecovery = await agent.assertion.history(CG_ID, name);
    expect(afterStagedRecovery?.state).toBe('promoted');
    expect(afterStagedRecovery?.swmCurrentAssertion).toBe(updateIntent.sealMerkleRoot.slice(2));
    expect(afterStagedRecovery?.vmCurrentAssertion).toBe(intent.sealMerkleRoot.slice(2));
    const recoveredStagedReceipt = await store.query(`ASK { GRAPH <${metaGraph}> {
      <${assertionUri}> <${ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_TX}> "${txHash}" .
      <${assertionUri}> <${ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_BLOCK}> ?block .
    } }`);
    expect(recoveredStagedReceipt).toMatchObject({ type: 'boolean', value: true });

    await store.insert(workspaceHeadRows.quads);

    const updated = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(updated.status).toBe('confirmed');

    const actualContextGraphId = BigInt((await agent.getContextGraphOnChainId(CG_ID))!);
    const contextGraphBinding = vi.spyOn((agent as any).chain, 'getKAContextGraphId')
      .mockResolvedValueOnce(actualContextGraphId + 1n);
    await expect(
      agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(recoveryInput as any),
    ).rejects.toMatchObject({ code: 'KA_VM_RECOVERY_INCONSISTENT' });
    contextGraphBinding.mockRestore();

    const currentFinalizer = agent.getOrCreateFinalizationHandler();
    const supersededReconcile = vi.spyOn(currentFinalizer, 'handleChainReconciledKC');
    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(recoveryInput as any);
    expect(supersededReconcile).not.toHaveBeenCalled();
    supersededReconcile.mockRestore();
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

  it('queued async VM preflight accepts an exact durable SWM head when its best-effort lifecycle pointer is absent', async () => {
    const agent = await createAgent('QueuedAsyncVmMissingSwmPointerBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Missing SWM Pointer E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-async-missing-swm-pointer';
    const root = `${ENTITY_BASE}:queued-async-missing-swm-pointer`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Missing SWM Pointer"' },
    ]);
    const share = await agent.assertion.promote(CG_ID, name);
    expect(share.publishReady).toBe(true);
    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);

    // Reproduce the exact managed-store interruption seen by the local matrix:
    // promotion, its complete-share marker and immutable graph head committed,
    // but the explicitly best-effort lifecycle projection did not.
    const agentAddress = agent.defaultAgentAddress ?? agent.peerId;
    await (agent as any).store.deleteByPattern({
      subject: assertionLifecycleUri(CG_ID, agentAddress, name),
      predicate: SWM_CURRENT_ASSERTION_PRED,
      graph: contextGraphMetaUri(CG_ID),
    });
    const incompleteProjection = await agent.assertion.history(CG_ID, name);
    expect(incompleteProjection?.swmCurrentAssertion).toBeUndefined();
    expect(incompleteProjection?.currentShareOperationId).toBe(intent.shareOperationId);

    await expect(agent.preflightQueuedKnowledgeAssetVmPublishExecution(intent))
      .resolves.toEqual({ action: 'execute' });
  }, 60_000);

  it('queued async VM preflight rejects a present SWM lifecycle pointer that mismatches the queued seal', async () => {
    const agent = await createAgent('QueuedAsyncVmMismatchedSwmPointerBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Mismatched SWM Pointer E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-async-mismatched-swm-pointer';
    const root = `${ENTITY_BASE}:queued-async-mismatched-swm-pointer`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Mismatched SWM Pointer"' },
    ]);
    const share = await agent.assertion.promote(CG_ID, name);
    expect(share.publishReady).toBe(true);
    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);

    const queuedSealBare = intent.sealMerkleRoot.replace(/^0x/, '');
    const mismatchedSwmRoot = `${queuedSealBare[0] === '0' ? '1' : '0'}${queuedSealBare.slice(1)}`;
    const agentAddress = agent.defaultAgentAddress ?? agent.peerId;
    const lifecycleUri = assertionLifecycleUri(CG_ID, agentAddress, name);
    const metaGraph = contextGraphMetaUri(CG_ID);
    await (agent as any).store.deleteByPattern({
      subject: lifecycleUri,
      predicate: SWM_CURRENT_ASSERTION_PRED,
      graph: metaGraph,
    });
    await (agent as any).store.insert([{
      subject: lifecycleUri,
      predicate: SWM_CURRENT_ASSERTION_PRED,
      object: `"${mismatchedSwmRoot}"`,
      graph: metaGraph,
    }]);

    const contradictoryProjection = await agent.assertion.history(CG_ID, name);
    expect(contradictoryProjection?.swmCurrentAssertion).toBe(mismatchedSwmRoot);
    expect(contradictoryProjection?.currentShareOperationId).toBe(intent.shareOperationId);
    await expect(agent.preflightQueuedKnowledgeAssetVmPublishExecution(intent))
      .rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
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

  it('queued async VM publish preflight survives catch-up offering an equivalent operation id (GH#2273)', async () => {
    // GH#2273 end-to-end: a queued VM-publish intent freezes the SWM head's
    // shareOperationId at admission; a restart-time catch-up round then offers
    // the SAME share under a peer's deterministic storage-ACK-style id. Pre-fix
    // the round's bulk meta union made the head two-valued and the next round's
    // repair rotated it to the remote identity, after which THIS preflight
    // failed the queued job terminally as publish_intent_stale for content that
    // never changed. Post-fix the equivalent remote identity must neither
    // rewrite nor stack onto the head, and the REAL preflight — the same call
    // the async publisher's claim path makes — must still authorize execution.
    const agent = await createAgent('QueuedAsyncVmCatchupIdentityBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Queued Async VM Catch-up Identity E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-async-catchup-identity';
    const root = `${ENTITY_BASE}:queued-async-catchup-identity`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Catch-up Identity"' },
    ]);
    const shared = await agent.assertion.promote(CG_ID, name);
    expect(shared.publishReady).toBe(true);
    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);
    const localOpId = intent.shareOperationId;

    // Build the peer's batch by READING this node's own durable rows back and
    // re-labeling them under a foreign operation id — byte-equivalence with the
    // local operation is then guaranteed by construction, not by a parallel
    // fixture that could drift from the real share flow.
    const store = (agent as any).store;
    const metaGraph = contextGraphSharedMemoryMetaUri(CG_ID);
    const scope = createGraphKnowledgeAssetScope(intent.kaUal, intent.assertionVersion);
    const headSubject = `${scope.ual}#dkg-swm-head`;
    const localOpSubject = `urn:dkg:share:${CG_ID}:${localOpId}`;
    const remoteOpId = `storage-ack-${'2273'.repeat(2)}`;
    const remoteOpSubject = `urn:dkg:share:${CG_ID}:${remoteOpId}`;
    const DKG_NS = 'http://dkg.io/ontology/';
    const readRows = async (subject: string) => {
      const result = await store.query(
        `SELECT ?p ?o WHERE { GRAPH <${metaGraph}> { <${subject}> ?p ?o } }`,
      );
      if (result.type !== 'bindings') throw new Error('expected bindings');
      return result.bindings.map((row: Record<string, string>) => ({
        subject,
        predicate: String(row['p'] ?? ''),
        object: String(row['o'] ?? ''),
        graph: metaGraph,
      }));
    };
    const localOpRows = await readRows(localOpSubject);
    const localHeadRows = await readRows(headSubject);
    expect(localOpRows.length).toBeGreaterThan(0);
    const digestRow = localOpRows.find((q: { predicate: string }) => q.predicate === `${DKG_NS}publicQuadsDigest`);
    expect(digestRow).toBeDefined();
    const digest = String(digestRow!.object).replace(/^"|"$/g, '');
    // The real share flow persisted a node-local snapshot GRAPH whose IRI
    // embeds the LOCAL operation id; carrying that row over verbatim would
    // make the relabeled descriptor fail parsing (snapshot graph mismatch)
    // and the whole round silently no-op — a vacuous pass. The peer shape for
    // a snapshot-backed share is a publicSnapshotRef instead.
    const remoteOpRows = localOpRows
      .filter((q: { predicate: string }) => q.predicate !== `${DKG_NS}publicSnapshotGraph`
        && q.predicate !== `${DKG_NS}publicSnapshotRef`)
      .map((q: { predicate: string; object: string }) => ({
        ...q,
        subject: remoteOpSubject,
        object: q.predicate === `${DKG_NS}shareOperationId` ? JSON.stringify(remoteOpId)
          : q.predicate === `${DKG_NS}publishedAt` ? `"2026-08-16T23:59:59.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>`
          : q.object,
      }));
    remoteOpRows.push({ subject: remoteOpSubject, predicate: `${DKG_NS}publicSnapshotRef`, object: `"${digest}"`, graph: metaGraph });
    const remoteHeadRows = localHeadRows.map((q: { predicate: string; object: string }) => ({
      ...q,
      object: q.predicate === `${DKG_NS}shareOperationId` ? JSON.stringify(remoteOpId) : q.object,
    }));
    const peerMeta = [...remoteHeadRows, ...remoteOpRows];

    const contentResult = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${knowledgeAssetLayerGraphUri(CG_ID, MemoryLayer.SharedWorkingMemory, scope)}> { ?s ?p ?o } }`,
    );
    if (contentResult.type !== 'bindings') throw new Error('expected content bindings');
    const contentQuads = contentResult.bindings.map((row: Record<string, string>) => ({
      subject: String(row['s'] ?? ''), predicate: String(row['p'] ?? ''), object: String(row['o'] ?? ''), graph: '',
    }));

    const summary = await makeSwmSyncHarness({
      ctx: createOperationContext('sync'),
      contextGraphId: CG_ID,
      store,
      served: { digest, payload: contentQuads, meta: peerMeta },
    }).run();
    // Anti-vacuity: the round must actually have processed the descriptor —
    // the remote operation subject lands as immutable history. A parse-time
    // rejection would leave zero meta writes and prove nothing.
    expect(summary.insertedMetaTriples).toBeGreaterThan(0);

    // The head still certifies the ADMISSION-TIME identity, single-valued.
    const headIds = await store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${metaGraph}> { <${headSubject}> <${DKG_NS}shareOperationId> ?op } }`,
    );
    if (headIds.type !== 'bindings') throw new Error('expected bindings');
    expect(headIds.bindings.map((row: Record<string, string>) => String(row['op']))).toEqual([`"${localOpId}"`]);

    // And the REAL queued-execution preflight authorizes the same intent.
    await expect(agent.preflightQueuedKnowledgeAssetVmPublishExecution(intent))
      .resolves.toMatchObject({ action: 'execute' });
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
    // VM retries are non-mutating and retain the original durable operation
    // identity for audit/replay; they do not create a new SWM operation.
    expect(history?.currentShareOperationId).toBe(share.shareOperationId);
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
    if (
      !processed.broadcast
      || !processed.inclusion
      || processed.finalization.mode === 'local'
      || !processed.finalization.txHash
      || !processed.finalization.publisherAddress
    ) {
      throw new Error('Expected a chain-finalized queued sub-graph update');
    }

    const finalizationHandler = agent.getOrCreateFinalizationHandler();
    const reconcile = vi.spyOn(finalizationHandler, 'handleChainReconciledKC');
    const recoveryChain = (agent as any).chain;
    const recoveryReceiptUal = buildKnowledgeAssetUal(
      recoveryChain.chainId,
      await recoveryChain.getDKGKnowledgeAssetsAddress(),
      BigInt(intent.seal.reservedKaId!),
    );
    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
      walletId: 'wallet-1',
      request: intent,
      lookup: { txHash: processed.broadcast.txHash, walletId: 'wallet-1' },
      job: {
        jobId: 'subgraph-recovery-job',
        jobSlug: 'subgraph-recovery-job',
        request: { jobType: 'knowledge-asset-vm-publish', knowledgeAssetVmPublish: intent },
        status: 'broadcast',
        broadcast: processed.broadcast,
        timestamps: { acceptedAt: 1, broadcastAt: 2, updatedAt: 2 },
        retries: { retryCount: 0, maxRetries: 10 },
        controlPlane: {},
      },
      recovery: {
        inclusion: {
          ...processed.inclusion,
          blockHash: `0x${'ab'.repeat(32)}`,
        },
        finalization: {
          ...processed.finalization,
          ual: recoveryReceiptUal,
          batchId: intent.seal.reservedKaId,
          startKAId: intent.seal.reservedKaId,
          endKAId: intent.seal.reservedKaId,
        },
        publishProof: {
          merkleRoot: intent.sealMerkleRoot,
          authorAddress: intent.seal.authorAddress,
          txIndex: 4,
        },
      },
      publisher: (agent as any).publisher,
    } as any);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      subGraphName,
      publisherAddress: processed.finalization.publisherAddress,
      authorAddress: intent.seal.authorAddress,
      versionBlock: processed.inclusion.blockNumber,
      trustedAssertionEvidence: expect.objectContaining({
        subGraphName,
        publisherAddress: processed.finalization.publisherAddress,
        authorAddress: intent.seal.authorAddress,
        blockNumber: processed.inclusion.blockNumber,
        txIndex: 4,
      }),
    }), expect.anything());
    const recoveredInput = reconcile.mock.calls.at(-1)?.[0];
    if (!recoveredInput?.trustedAssertionEvidence || !intent.kaUal) {
      throw new Error('Expected trusted named-recovery evidence');
    }
    reconcile.mockRestore();

    await expect(finalizationHandler.handleChainReconciledKC({
      ...recoveredInput,
      trustedAssertionEvidence: {
        ...recoveredInput.trustedAssertionEvidence,
        transactionHash: `0x${'cd'.repeat(32)}`,
        txIndex: 1,
      },
    }, createOperationContext('system'))).resolves.toBe('stale-target');
    const recoveredVersionSurvives = await (agent as any).store.query(
      `ASK { GRAPH <${contextGraphMetaUri(CG_ID)}> { <${intent.kaUal}> `
        + `<http://dkg.io/ontology/materializedVersion> "${processed.inclusion.blockNumber}:4" ; `
        + `<http://dkg.io/ontology/transactionHash> "${recoveredInput.trustedAssertionEvidence.transactionHash}" . } }`,
    );
    expect(recoveredVersionSurvives).toMatchObject({ type: 'boolean', value: true });

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
    ).rejects.toMatchObject({ code: 'LEGACY_KA_READ_ONLY' });

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
    const unregisteredCgId = `${CG_ID}-full-share-deferred-registration`;
    // LOCAL-ONLY CG: created but DELIBERATELY never registered on-chain.
    await agent.createContextGraph({ id: unregisteredCgId, name: 'Unregistered CG Seal E2E' });

    const name = 'unregistered-cg-seal';
    await agent.assertion.create(unregisteredCgId, name);
    await agent.assertion.write(unregisteredCgId, name, [
      { subject: `${ENTITY_BASE}:ucs`, predicate: 'http://schema.org/name', object: '"Unregistered CG Seal"' },
    ]);

    // Default FULL share — must SEAL despite the CG being unregistered (the seal
    // no longer depends on CG registration).
    const fullShare = await agent.assertion.promote(unregisteredCgId, name);
    expect(fullShare.sealed).toBe(true);
    expect(fullShare.publishReady).toBe(true);

    // CORE ASSERTION: the CG is STILL unregistered after sealing — sealing did
    // NOT register it on-chain. Reintroducing seal-time registration breaks here.
    const onChainIdAfterSeal = await agent.getContextGraphOnChainId(unregisteredCgId);
    expect(onChainIdAfterSeal == null).toBe(true);

    // And publishing the unregistered CG fails CLOSED for that exact reason —
    // proving the registration gap is real (not silently papered over at seal).
    // #1116 (round 5, FIX 3b): assert BOTH the message AND the stable `.code`
    // (the route's auto-register branch keys on code-first; mirrors this file's
    // .code convention for SWM_SUBSET_NOT_SEALABLE / UNSEALED_SHARE_BLOCKED).
    let notRegisteredErr: any;
    try {
      await agent.publishFromFinalizedAssertion(unregisteredCgId, name);
    } catch (e) {
      notRegisteredErr = e;
    }
    expect(notRegisteredErr).toBeTruthy();
    expect(notRegisteredErr.message).toMatch(/not registered on-chain/i);
    expect(notRegisteredErr.code).toBe('CG_NOT_REGISTERED');

    // Registration happens at PUBLISH time (the /vm/publish route's
    // ensureRegisteredForPublish step). After it, the same sealed asset publishes
    // to VM and confirms — no re-seal, no recreate.
    await agent.ensureRegisteredForPublish(unregisteredCgId);
    const onChainIdAfterRegister = await agent.getContextGraphOnChainId(unregisteredCgId);
    expect(onChainIdAfterRegister).toBeTruthy();

    const pub = await agent.publishFromFinalizedAssertion(unregisteredCgId, name);
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
    // Keep this chain assertion independent from the preceding test, which
    // deliberately registers CG_ID before it completes. Reusing CG_ID made
    // the poller race decide whether this test observed that earlier mint.
    const unregisteredCgId = `${CG_ID}-unshared-precondition`;
    // DELIBERATELY unregistered, local-only CG.
    await agent.createContextGraph({ id: unregisteredCgId, name: 'No Quads Before Register E2E' });

    const name = 'empty-swm-seal';
    await agent.assertion.create(unregisteredCgId, name);
    await agent.assertion.write(unregisteredCgId, name, [
      { subject: `${ENTITY_BASE}:nq`, predicate: 'http://schema.org/name', object: '"No Quads"' },
    ]);
    // Finalize the WM draft (seals it) WITHOUT promoting — SWM stays empty and
    // NO full-share marker is set.
    await agent.assertion.finalize(unregisteredCgId, name);

    let thrown: any;
    try {
      await agent.publishFromFinalizedAssertion(unregisteredCgId, name);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    // The not-a-full-share precondition fired first — NOT the registration guard.
    expect(thrown.code).toBe('PUBLISH_NOT_FULL_SHARE');
    expect(thrown.message).not.toMatch(/not registered on-chain/i);
    expect(thrown.code).not.toBe('CG_NOT_REGISTERED');

    // And the CG was NEVER registered as a side effect (no gas burned).
    const onChainId = await agent.getContextGraphOnChainId(unregisteredCgId);
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

    // 2. Re-open the exact immutable SWM version, discard that mutable draft,
    // then create a replacement. Direct mutation/discard of sealed SWM is blocked.
    await agent.assertion.pullFrom(CG_ID, name, 'swm', { onConflict: 'replace' });
    await agent.assertion.discard(CG_ID, name);
    await agent.assertion.create(CG_ID, name);
    await writeAB();

    await expect(
      agent.assertion.promote(CG_ID, name, { entities: [`${ENTITY_BASE}:a`] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });

    // 4. SWM reconstruction/resealing is refused unconditionally. Legacy
    // root-scoped data remains readable but is never migrated by a write path.
    let thrown: any;
    try {
      await agent.assertion.finalize(CG_ID, name, { layer: 'swm' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('LEGACY_KA_READ_ONLY');
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

    // Re-open and discard the immutable SWM version, then write {A,B} as the
    // next atomic graph. This is the sanctioned replacement lifecycle.
    await agent.assertion.pullFrom(CG_ID, name, 'swm', { onConflict: 'replace' });
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

  // A confirmed publish clears the marker; a later legacy SWM-finalize request
  // is read-only and cannot strand the surviving seal.
  it('confirmed publish clears the marker; legacy SWM finalize rejects without stranding the seal', async () => {
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

    // The deprecated write bridge must reject before touching the published seal.
    const sealBefore = await sealExists(agent, CG_ID, name);
    let thrown: any;
    try { await agent.assertion.finalize(CG_ID, name, { layer: 'swm' }); } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('LEGACY_KA_READ_ONLY');
    expect(await sealExists(agent, CG_ID, name)).toBe(sealBefore); // seal not stranded
  }, 40_000);

  // Even inconsistent legacy metadata (empty SWM with a surviving marker) is
  // never repaired through a write-side root migration; the seal stays intact.
  it('legacy SWM finalize on empty SWM rejects read-only without stranding the seal', async () => {
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

    // Rejection happens before source inspection or mutation.
    let thrown: any;
    try { await agent.assertion.finalize(CG_ID, name, { layer: 'swm' }); } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('LEGACY_KA_READ_ONLY');
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

  // A failed atomic promote must leave both the new WM draft and the last exact
  // SWM recovery version intact. This is the rootless replacement for the old
  // selective/non-sealing lifecycle test: partial shares no longer exist.
  it('a failed atomic promote preserves the draft and the prior exact SWM recovery version', async () => {
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

    // Enter the sanctioned edit loop. pullFrom archives the exact SWM seal,
    // clears the active seal, and re-opens a verified WM draft.
    const reopened = await agent.assertion.pullFrom(CG_ID, name, 'swm', { onConflict: 'replace' });
    expect(reopened.seeded).toBe(2);
    await agent.assertion.write(CG_ID, name, [
      { subject: A, predicate: 'http://schema.org/name', object: '"A2"' },
      { subject: B, predicate: 'http://schema.org/name', object: '"B2"' },
    ]);
    const spy = vi
      .spyOn(agent.publisher, 'assertionPromote')
      .mockRejectedValue(new Error('simulated promote failure (curator unconfirmed)'));
    try {
      await expect(agent.assertion.promote(CG_ID, name)).rejects.toThrow(/simulated promote failure/);
    } finally {
      spy.mockRestore();
    }

    // The failed commit leaves WM untouched. Recovery can still select the
    // archived exact seal and restore the prior two-triple SWM version.
    expect(await agent.assertion.query(CG_ID, name)).toHaveLength(4);
    const recovered = await agent.assertion.pullFrom(CG_ID, name, 'swm', { onConflict: 'replace' });
    expect(recovered.seeded).toBe(2);
    expect((await agent.assertion.query(CG_ID, name)).map((quad) => quad.object).sort())
      .toEqual(['"A"', '"B"']);
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

  it('an imported Markdown KA survives WM → SWM gossip → VM on a second node', async () => {
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

    // Step 1: use the production Markdown extractor, including the blank-node
    // section hierarchy that originally made imported KAs appear empty on the
    // receiving node. The two daemon-owned linkage rows below are written by
    // the real import-file route alongside this extractor output.
    const assertionName = 'two-node-markdown';
    const assertionUri = contextGraphAssertionUri(
      CG_ID,
      nodeA.defaultAgentAddress ?? nodeA.peerId,
      assertionName,
    );
    const fileUri = `urn:dkg:file:keccak256:${'a'.repeat(64)}`;
    const extracted = extractFromMarkdown({
      markdown: [
        '---',
        'type: Report',
        'title: Construction safety notes',
        'status: approved',
        '---',
        '',
        '# Construction safety notes',
        '',
        'Shared with [[Site Alpha]] and tagged #safety.',
        '',
        '## Equipment',
        '',
        'Inspect lifting equipment.',
        '',
        '### Cranes',
        '',
        'Check every crane before use.',
      ].join('\n'),
      agentDid: `did:dkg:agent:${nodeA.defaultAgentAddress ?? nodeA.peerId}`,
      documentIri: assertionUri,
      sourceFileIri: fileUri,
    });
    expect(extracted.triples.some((quad) => quad.subject.startsWith('_:dkg-md-section-'))).toBe(true);

    await nodeA.assertion.create(CG_ID, assertionName);
    await nodeA.assertion.write(CG_ID, assertionName, [
      ...extracted.triples,
      ...extracted.sourceFileLinkage,
      {
        subject: extracted.subjectIri,
        predicate: 'http://dkg.io/ontology/sourceContentType',
        object: '"text/markdown"',
      },
      {
        subject: extracted.subjectIri,
        predicate: 'http://dkg.io/ontology/markdownForm',
        object: fileUri,
      },
    ]);

    // Step 2: A promotes to SWM (gossips to B)
    await nodeA.assertion.promote(CG_ID, assertionName);

    const receiverMarkdownQuery = `SELECT ?title ?contentType ?section ?sectionName WHERE {
      <${assertionUri}> <http://schema.org/name> ?title ;
        <http://dkg.io/ontology/sourceContentType> ?contentType ;
        <http://dkg.io/ontology/hasSection> ?section .
      ?section <http://schema.org/name> ?sectionName .
    }`;

    // Step 3: B receives the document and its canonicalized section entity via gossip.
    const bSwm = await pollUntil(
      () => nodeB.query(
        receiverMarkdownQuery,
        { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
      ),
      (b) => b.length > 0,
      15_000,
    );
    expect(bSwm.length).toBe(1);
    expect(bSwm[0]).toMatchObject({
      title: '"Construction safety notes"',
      contentType: '"text/markdown"',
      sectionName: '"Equipment"',
    });
    expect(bSwm[0]?.['section']).toMatch(/^urn:dkg:ka-skolem:c14n\d+$/);

    // Step 4: A publishes from SWM → chain
    const pubResult = await nodeA.publishFromSharedMemory(CG_ID, 'all');
    expect(pubResult.status).toBe('confirmed');

    // Step 5: B receives finalization and exposes the same document/entity
    // relationship from VM, proving publication does not lose Markdown content.
    const bData = await pollUntil(
      () => nodeB.query(receiverMarkdownQuery, CG_ID),
      (b) => b.length > 0,
      20_000,
    );
    expect(bData.length).toBe(1);
    expect(bData[0]).toEqual(bSwm[0]);
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

  /**
   * GH#2270 PR-3 r3 — the pre-send write-ahead must survive the REAL queued-agent handler, on
   * BOTH of its branches.
   *
   * Everything else in this chain proves the signal once it reaches `publisher.publish` /
   * `publisher.update`. Between the queue and those calls sits
   * `publishQueuedKnowledgeAssetVmPublish`, which rebuilds its option bag field by field — and a
   * field-by-field rebuild silently drops anything nobody thought to name. It HAD dropped it on
   * the update branch, so every named-KA update sent its transaction with nothing on disk
   * recording it. A stubbed handler cannot see that; this drives the real one, over a real chain,
   * and reads the persisted job.
   */
  it('records the signed nonce through the real queued handler, on create AND update [GH#2270]', async () => {
    const agent = await createAgent('WriteAheadBoundaryBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Write-Ahead Boundary' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-writeahead-both-branches';
    const root = `${ENTITY_BASE}:queued-writeahead`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"v1"' },
    ]);
    await agent.assertion.promote(CG_ID, name);

    const runQueued = async () => {
      const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);
      const asyncPublisher = new TripleStoreAsyncLiftPublisher((agent as any).store, {
        knowledgeAssetVmPublishHandler: {
          preflight: async ({ request }) =>
            agent.preflightQueuedKnowledgeAssetVmPublishExecution(request),
          execute: async ({ request, publishOptions }) =>
            agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions),
        },
      });
      await asyncPublisher.enqueueKnowledgeAssetVmPublish(intent);
      return asyncPublisher.processNext('wallet-1');
    };

    // CREATE branch — no prior vmCurrentAssertion.
    const intentForUpdate = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);
    const created = await runQueued();
    expect(created?.status).toBe('finalized');
    expect(created?.broadcast?.txHash).toMatch(/^0x[0-9a-f]+$/i);
    // The write-ahead fired with a REAL signed nonce, carried from the adapter through the agent.
    expect(typeof created?.broadcast?.nonce).toBe('number');
    expect(created!.broadcast!.nonce!).toBeGreaterThanOrEqual(0);
    expect((await agent.assertion.history(CG_ID, name))?.vmCurrentAssertion).toBeDefined();

    // UPDATE branch — the hop that actually dropped it. GH#2270 r4: `agent.update` stays REAL and
    // the double sits on the underlying PUBLISHER's update entry, so this row pins the whole
    // agent-side chain of custody — queued handler → the real `agent.update` preconditions → the
    // publisher — receiving the IDENTICAL callback. Driving the real send would need a fresh full
    // share/reopen lifecycle, so with the publisher doubled there is no send here to prevent;
    // rejection-stops-the-send for the update path is proven at the publisher's own boundary in
    // `pre-broadcast-signal-await.test.ts`, and this row pins callback identity only.
    const realPublisher = (agent as any).publisher;
    const publisherUpdateSpy = vi.spyOn(realPublisher, 'updateKnowledgeAssetFromStagedSharedWorkingMemoryV1')
      .mockResolvedValue({ status: 'failed', kaManifest: [] } as never);
    const recorder = () => {};
    try {
      await agent.publishQueuedKnowledgeAssetVmPublish(
        {
          ...intentForUpdate,
          vmCurrentAssertion: intentForUpdate.sealMerkleRoot.slice(2),
          // The real update path enforces that the queued version ADVANCES past the published
          // lifecycle pointer; the create half above published version 1.
          assertionVersion: '2',
        },
        {
          quads: [{ subject: root, predicate: 'http://schema.org/name', object: '"v1"', graph: '' }],
          publisherPeerId: 'queued-update-branch',
          onBeforeBroadcast: recorder,
        } as never,
      ).catch(() => undefined);
      expect(publisherUpdateSpy).toHaveBeenCalled();
      const forwarded = (publisherUpdateSpy.mock.calls[0] as unknown[])[1] as { onBeforeBroadcast?: unknown };
      expect(forwarded.onBeforeBroadcast).toBe(recorder);
    } finally {
      publisherUpdateSpy.mockRestore();
    }
  }, 180_000);

  it('a rejecting write-ahead stops the queued publish from sending [GH#2270]', async () => {
    // Fail-closed across the same real boundary: if the durable record cannot be written, no
    // transaction may go out.
    const agent = await createAgent('WriteAheadBoundaryBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Write-Ahead Boundary' });
    await agent.registerContextGraph(CG_ID);

    const name = 'queued-writeahead-fail-closed';
    const root = `${ENTITY_BASE}:queued-writeahead-fail`;
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: root, predicate: 'http://schema.org/name', object: '"v1"' },
    ]);
    await agent.assertion.promote(CG_ID, name);
    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG_ID, name);

    let signalled = 0;
    const result = await agent.publishQueuedKnowledgeAssetVmPublish(intent, {
      quads: [{ subject: root, predicate: 'http://schema.org/name', object: '"v1"', graph: '' }],
      publisherPeerId: 'queued-writeahead-fail',
      onBeforeBroadcast: () => {
        signalled += 1;
        throw new Error('could not persist the write-ahead');
      },
    } as never).catch((err: unknown) => err);

    // The handler reached the durable boundary and then refused to publish.
    expect(signalled).toBe(1);
    expect(result).toBeInstanceOf(Error);
    expect((await agent.assertion.history(CG_ID, name))?.vmCurrentAssertion).toBeUndefined();
  }, 180_000);
});
