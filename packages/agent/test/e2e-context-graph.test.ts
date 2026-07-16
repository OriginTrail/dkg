/**
 * E2E tests for the context graph publishing flow (2 nodes, shared chain):
 *
 * 1. Create a context graph on-chain
 * 2. Write data to workspace → replicate via GossipSub
 * 3. Enshrine from workspace with contextGraphId
 * 4. Finalization message propagates → peer verifies on-chain → promotes to context graph URIs
 * 5. Verify data lives in context graph data/meta graphs (not contextGraph data graph)
 *
 * Uses a shared EVMChainAdapter so both nodes see the same on-chain events,
 * allowing B to verify A's publish transaction during finalization.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

const CONTEXT_GRAPH = 'context-graph-e2e';
const ENTITY_CTX_1 = 'urn:ctxgraph:entity:1';
const ENTITY_CTX_2 = 'urn:ctxgraph:entity:2';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function stageRootlessAssertion(
  node: DKGAgent,
  contextGraphId: string,
  name: string,
  quads: Array<{ subject: string; predicate: string; object: string }>,
) {
  await node.assertion.create(contextGraphId, name);
  await node.assertion.write(contextGraphId, name, quads);
  return node.assertion.promote(contextGraphId, name);
}

async function bindAndSubscribePublicContextGraph(
  node: DKGAgent,
  contextGraphId: string,
  onChainId: string,
) {
  // The public subscription gate intentionally requires a live on-chain
  // binding. Pin it in this publish/finalization test instead of racing the
  // background ontology-discovery loop.
  await (node as any).store.insert([{
    subject: `did:dkg:context-graph:${contextGraphId}`,
    predicate: 'https://dkg.network/ontology#ContextGraphOnChainId',
    object: `"${onChainId}"`,
    graph: 'did:dkg:context-graph:ontology',
  }]);
  node.subscribeToContextGraph(contextGraphId);
}

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

describe('E2E: context graph publish + finalization (shared chain)', () => {
  const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let contextGraphId: string;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch {}
    try { await nodeB?.stop(); } catch {}
  });

  it('bootstraps two agents with shared chain, connects, subscribes', async () => {
    nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'CtxA',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'CtxB',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });

    await nodeA.start();
    await nodeB.start();
    await sleep(800);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(2000);

    expect(nodeA.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(1);
    expect(nodeB.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(1);

    await nodeA.createContextGraph({ id: CONTEXT_GRAPH, name: 'Context Graph E2E', description: '' });
    await sleep(1500);
  }, 15_000);

  it('creates a context graph on the shared chain', async () => {
    const result = await nodeA.registerContextGraph(CONTEXT_GRAPH, {
      accessPolicy: 0,
      publishPolicy: 1,
    });

    contextGraphId = result.onChainId;
    expect(contextGraphId).toBeDefined();
    expect(Number(contextGraphId)).toBeGreaterThan(0);
    await bindAndSubscribePublicContextGraph(nodeA, CONTEXT_GRAPH, contextGraphId);
    await bindAndSubscribePublicContextGraph(nodeB, CONTEXT_GRAPH, contextGraphId);
    await sleep(1500);
  }, 10_000);

  it('A writes to workspace; B receives via GossipSub', async () => {
    const wsResult = await stageRootlessAssertion(nodeA, CONTEXT_GRAPH, 'context-entity-1', [
      { subject: ENTITY_CTX_1, predicate: 'http://schema.org/name', object: '"Context Graph Entity"' },
      { subject: ENTITY_CTX_1, predicate: 'http://schema.org/version', object: '"1"' },
    ]);
    expect(wsResult.promotedCount).toBeGreaterThan(0);

    const deadline = Date.now() + 15_000;
    let bWorkspace: any;
    while (Date.now() < deadline) {
      bWorkspace = await nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_CTX_1}> <http://schema.org/name> ?name }`,
        { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
      );
      if (bWorkspace.bindings.length > 0) break;
      await sleep(500);
    }
    expect(bWorkspace.bindings.length).toBe(1);
    expect(bWorkspace.bindings[0]['name']).toBe('"Context Graph Entity"');
  }, 25_000);

  it('A enshrines to context graph; A has data in context graph URI', async () => {
    const result = await nodeA.publishFromSharedMemory(
      CONTEXT_GRAPH,
      'all',
      { subContextGraphId: contextGraphId, clearSharedMemoryAfter: true },
    );

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBeDefined();

    const ctxDataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${contextGraphId}`;

    const aData = await nodeA.query(
      `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_CTX_1}> <http://schema.org/name> ?name } }`,
    );
    expect(aData.bindings.length).toBe(1);
    expect(aData.bindings[0]['name']).toBe('"Context Graph Entity"');

    // NOT in contextGraph data graph
    const aContextGraphData = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_CTX_1}> <http://schema.org/name> ?name }`,
      CONTEXT_GRAPH,
    );
    expect(aContextGraphData.bindings.length).toBe(0);
  }, 30_000);

  it('B receives finalization and promotes to context graph', async () => {
    const ctxDataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${contextGraphId}`;

    const deadline = Date.now() + 20_000;
    let bData: any;
    while (Date.now() < deadline) {
      bData = await nodeB.query(
        `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_CTX_1}> <http://schema.org/name> ?name } }`,
      );
      if (bData.bindings.length > 0) break;
      await sleep(500);
    }

    expect(bData.bindings.length).toBe(1);
    expect(bData.bindings[0]['name']).toBe('"Context Graph Entity"');
  }, 30_000);

  it('B has confirmed metadata in context graph meta', async () => {
    const ctxMetaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${contextGraphId}/_meta`;

    const metaResult = await nodeB.query(
      `SELECT ?status WHERE { GRAPH <${ctxMetaGraph}> { ?kc <http://dkg.io/ontology/status> ?status } }`,
    );

    const statuses = metaResult.bindings.map((b: any) => String(b['status']));
    expect(statuses.some(s => s === '"confirmed"')).toBe(true);
  }, 10_000);

  it('B contextGraph data graph does NOT contain context graph data (remap/explicit-subCG flow)', async () => {
    // This test exercises the explicit-`subContextGraphId` publish flow
    // (line ~115 above), which is the REMAP-style path on the publisher:
    // `dkg-publisher.ts` ~line 1393 deletes the root copy of the
    // canonical quads on purpose, leaving them only in the per-cgId
    // partition `<cg>/context/<ctxGraphId>`. PR #779's recipient
    // dual-write (which fixes the v10-rc-validation §5 same-graph
    // gossip-replication regression) is correctly gated on the
    // wire-level `keepRootCopyOnLabel` flag and MUST NOT fire here, so
    // B's root stays empty, mirroring A's deliberate remap behaviour.
    // The pure same-graph dual-write parity is covered separately by
    // `scripts/v10-rc-validation.sh` §5 against a 6-node devnet.
    const contextGraphData = await nodeB.query(
      `SELECT ?name WHERE { <${ENTITY_CTX_1}> <http://schema.org/name> ?name }`,
      CONTEXT_GRAPH,
    );
    expect(contextGraphData.bindings.length).toBe(0);
  }, 5_000);

  it('B workspace is cleaned up after promotion', async () => {
    const wsResult = await nodeB.query(
      `SELECT ?name WHERE { <${ENTITY_CTX_1}> <http://schema.org/name> ?name }`,
      { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
    );
    expect(wsResult.bindings.length).toBe(0);
  }, 5_000);

  it('second enshrine to same context graph accumulates data', async () => {
    await stageRootlessAssertion(nodeA, CONTEXT_GRAPH, 'context-entity-2', [
      { subject: ENTITY_CTX_2, predicate: 'http://schema.org/name', object: '"Second Context Entity"' },
    ]);

    // Wait for workspace replication
    const wsDeadline = Date.now() + 10_000;
    while (Date.now() < wsDeadline) {
      const ws = await nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_CTX_2}> <http://schema.org/name> ?name }`,
        { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
      );
      if (ws.bindings.length > 0) break;
      await sleep(500);
    }

    const result = await nodeA.publishFromSharedMemory(
      CONTEXT_GRAPH,
      'all',
      { subContextGraphId: contextGraphId, clearSharedMemoryAfter: true },
    );
    expect(result.status).toBe('confirmed');

    const ctxDataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${contextGraphId}`;

    // Both entities in context graph on A
    const data = await nodeA.query(
      `SELECT ?s ?name WHERE { GRAPH <${ctxDataGraph}> { ?s <http://schema.org/name> ?name } }`,
    );
    const names = data.bindings.map((b: any) => String(b['name']));
    expect(names.some((n: string) => n.includes('Context Graph Entity'))).toBe(true);
    expect(names.some((n: string) => n.includes('Second Context Entity'))).toBe(true);

    // A's workspace cleaned
    const ws = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_CTX_2}> <http://schema.org/name> ?name }`,
      { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
    );
    expect(ws.bindings.length).toBe(0);

    // Poll until B promotes
    const deadline = Date.now() + 20_000;
    let bData: any;
    while (Date.now() < deadline) {
      bData = await nodeB.query(
        `SELECT ?s ?name WHERE { GRAPH <${ctxDataGraph}> { ?s <http://schema.org/name> ?name } }`,
      );
      if (bData.bindings.length >= 2) break;
      await sleep(500);
    }
    const bNames = bData.bindings.map((b: any) => String(b['name']));
    expect(bNames.some((n: string) => n.includes('Context Graph Entity'))).toBe(true);
    expect(bNames.some((n: string) => n.includes('Second Context Entity'))).toBe(true);
  }, 60_000);

  // PR #779 — codex r3 follow-up. The describe block above only
  // exercises the explicit-`subContextGraphId` (remap) path, which is
  // the keepRootCopyOnLabel=false branch. Codex flagged that automated
  // CI was missing coverage of the OPPOSITE path: a same-graph publish
  // (no subContextGraphId) where the publisher dual-writes the
  // canonical quads + confirmed `_meta` to BOTH the root `<cg>` graph
  // and the per-cgId `<cg>/context/<id>` partition, and recipients
  // mirror that dual-write so label-scoped queries on replicas
  // converge. Pin that path here.
  //
  // Use a fresh label so this block exercises the same-graph branch,
  // while the tests above continue to exercise the explicit
  // `subContextGraphId` remap branch. Both registrations use the
  // production `registerContextGraph(id)` API so their public label is
  // cryptographically bound to the on-chain name hash.
  describe('same-graph publish (keepRootCopyOnLabel=true) — recipient mirrors publisher root dual-write', () => {
    const SAMEG_LABEL = 'context-graph-e2e-sameg';
    const ENTITY_SAMEG = 'urn:ctxgraph:entity:sameg';
    let samegOnChainId: string;

    it('registers a fresh same-graph-friendly CG and primes both nodes', async () => {
      await nodeA.createContextGraph({ id: SAMEG_LABEL, name: 'Same-Graph E2E', description: '' });
      await nodeB.createContextGraph({ id: SAMEG_LABEL, name: 'Same-Graph E2E', description: '' });
      const reg = await nodeA.registerContextGraph(SAMEG_LABEL, {
        accessPolicy: 0,
        publishPolicy: 1,
      });
      samegOnChainId = String(reg.onChainId);
      expect(Number(samegOnChainId)).toBeGreaterThan(0);

      // Both nodes need to know the on-chain id so B's
      // `resolveContextGraphOnChainId` resolves locally. The same-graph
      // dual-write fallback path (used when older publishers don't
      // emit `keepRootCopyOnLabel`) reads this resolution; on B the
      // newer publisher A emits the wire bit explicitly, but priming
      // B's ontology mirrors how production replicas come up. Use the
      // explicit `seedContextGraphOnChainId` override on B's store.
      await (nodeB as any).store.insert([
        {
          subject: `did:dkg:context-graph:${SAMEG_LABEL}`,
          predicate: 'https://dkg.network/ontology#ContextGraphOnChainId',
          object: `"${samegOnChainId}"`,
          graph: 'did:dkg:context-graph:ontology',
        },
      ]);

      await bindAndSubscribePublicContextGraph(nodeA, SAMEG_LABEL, samegOnChainId);
      await bindAndSubscribePublicContextGraph(nodeB, SAMEG_LABEL, samegOnChainId);
      await sleep(1500);
    }, 30_000);

    it('A same-graph publish; B sees data in BOTH root <cg> and per-cgId partition', async () => {
      await stageRootlessAssertion(nodeA, SAMEG_LABEL, 'same-graph-entity', [
        { subject: ENTITY_SAMEG, predicate: 'http://schema.org/name', object: '"Same-Graph Entity"' },
      ]);
      const wsDeadline = Date.now() + 10_000;
      while (Date.now() < wsDeadline) {
        const ws = await nodeB.query(
          `SELECT ?name WHERE { <${ENTITY_SAMEG}> <http://schema.org/name> ?name }`,
          { contextGraphId: SAMEG_LABEL, graphSuffix: '_shared_memory' },
        );
        if (ws.bindings.length > 0) break;
        await sleep(500);
      }

      // No `subContextGraphId` → same-graph publish: publisher
      // dual-writes canonical quads to BOTH `<cg>` and
      // `<cg>/context/<id>` and emits `keepRootCopyOnLabel=true` on
      // the wire so the recipient mirrors the dual-write.
      const result = await nodeA.publishFromSharedMemory(
        SAMEG_LABEL,
        'all',
        { clearSharedMemoryAfter: true },
      );
      expect(result.status).toBe('confirmed');

      const ctxDataGraph = `did:dkg:context-graph:${SAMEG_LABEL}/context/${samegOnChainId}`;

      // Wait for B's gossip recipient finalization to land.
      const deadline = Date.now() + 25_000;
      let bPerCgIdData: any;
      while (Date.now() < deadline) {
        bPerCgIdData = await nodeB.query(
          `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_SAMEG}> <http://schema.org/name> ?name } }`,
        );
        if (bPerCgIdData.bindings.length > 0) break;
        await sleep(500);
      }
      // Per-cgId partition copy MUST be present (the legacy
      // single-write path was always landing here even before PR #779).
      expect(bPerCgIdData.bindings.length).toBe(1);
      expect(bPerCgIdData.bindings[0]['name']).toBe('"Same-Graph Entity"');

      // Root <cg> copy is the PR #779 fix: label-scoped query on B (no
      // graphSuffix, no per-cgId hint) MUST resolve too. This catches
      // regressions in any of: wire-flag emission, decoder presence
      // semantics, or the recipient same-graph dual-write branch.
      const bRootData = await nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_SAMEG}> <http://schema.org/name> ?name }`,
        SAMEG_LABEL,
      );
      expect(
        bRootData.bindings.length,
        'PR #779: same-graph publish recipient MUST mirror publisher root dual-write so label-scoped queries find the data on replicas',
      ).toBe(1);
      expect(bRootData.bindings[0]['name']).toBe('"Same-Graph Entity"');

      // Confirmed `_meta` MUST also exist on BOTH root and per-cgId
      // meta graphs so label-only status / UAL / authoredBy lookups
      // converge between publisher and replicas. This is the meta
      // dual-write addition that landed alongside the data dual-write.
      // Use SELECT-shaped queries (the agent's `query()` API returns
      // `{ bindings: [{ result: 'true'|'false' }] }` for ASK queries
      // to keep the response shape uniform across the deny path —
      // see `emptyQueryResultForKind` rationale at dkg-agent.ts
      // ~9338).
      const rootMeta = `did:dkg:context-graph:${SAMEG_LABEL}/_meta`;
      const perCgIdMeta = `did:dkg:context-graph:${SAMEG_LABEL}/context/${samegOnChainId}/_meta`;
      const rootMetaSelect = await nodeB.query(
        `SELECT ?status WHERE { GRAPH <${rootMeta}> { <${result.ual}> <http://dkg.io/ontology/status> ?status } }`,
      );
      const rootStatuses = rootMetaSelect.bindings.map((b: any) => String(b['status']));
      expect(
        rootStatuses.some((s: string) => s === '"confirmed"'),
        'PR #779: same-graph publish recipient MUST dual-write confirmed _meta to ROOT meta graph too',
      ).toBe(true);
      const perCgIdMetaSelect = await nodeB.query(
        `SELECT ?status WHERE { GRAPH <${perCgIdMeta}> { <${result.ual}> <http://dkg.io/ontology/status> ?status } }`,
      );
      const perCgStatuses = perCgIdMetaSelect.bindings.map((b: any) => String(b['status']));
      expect(perCgStatuses.some((s: string) => s === '"confirmed"')).toBe(true);
    }, 90_000);
  });
});
