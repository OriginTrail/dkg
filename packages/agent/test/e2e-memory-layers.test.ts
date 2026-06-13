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
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';
import {
  assertionLifecycleUri,
  contextGraphMetaUri,
  contextGraphLayerUri,
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

async function createAgent(name: string) {
  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  const agent = await DKGAgent.create({
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

  it('selective promote does NOT auto-finalize (avoids the seal-all vs promote-subset merkleRoot mismatch)', async () => {
    // Regression for the #1004 review: auto-finalize seals the WHOLE assertion
    // (all root entities), but a SELECTIVE promote (opts.entities subset) ships
    // only the chosen roots to SWM. If promote auto-sealed ALL roots here,
    // publishFromFinalizedAssertion would reload SWM scoped to the sealed (full)
    // root set, recompute a different merkleRoot, and fail the seal guard. So a
    // selective promote must NOT auto-finalize — the assertion stays unsealed
    // until an explicit, matching-scope finalize.
    const agent = await createAgent('SelectivePromoteBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Selective Promote E2E' });
    await agent.registerContextGraph(CG_ID);

    await agent.assertion.create(CG_ID, 'selective');
    await agent.assertion.write(CG_ID, 'selective', [
      { subject: `${ENTITY_BASE}:a`, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: `${ENTITY_BASE}:b`, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    // Promote ONLY entity A — a subset of the assertion's roots.
    const promoteResult = await agent.assertion.promote(CG_ID, 'selective', {
      entities: [`${ENTITY_BASE}:a`],
    });
    expect(promoteResult.promotedCount).toBeGreaterThan(0);

    // The selective promote must have left the assertion UNSEALED, so publish
    // surfaces the explicit-finalize requirement — NOT a (pre-fix) seal-all-vs-
    // promote-subset merkleRoot mismatch.
    await expect(
      agent.publishFromFinalizedAssertion(CG_ID, 'selective'),
    ).rejects.toThrow(/not finalized/i);
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
    await expect(agent.assertion.promote(CG_ID, 'stale')).rejects.toThrow(/different merkleRoot/i);

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
