/**
 * E2E tests for the DKG V10 memory layer progression:
 *
 * 1. Working Memory → SWM: assertion promote moves data to shared memory
 * 2. SWM → Verified Memory: publishFromSharedMemory anchors on-chain
 * 3. Full pipeline: WM → promote → SWM gossip → publishFromSharedMemory → VM
 * 4. Memory layer isolation: data in one layer doesn't leak to another
 * 5. Two-node flow: A promotes to SWM → gossip to B → A publishes → B finalizes
 * 6. SWM query view vs default view
 * 7. Working memory view
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

const agents: DKGAgent[] = [];

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
  const chain = new MockChainAdapter();
  const agent = await DKGAgent.create({
    name,
    listenPort: 0,
    chainAdapter: chain,
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

describe('Memory layer isolation (single agent)', () => {
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
  it('promotes assertion to SWM, then publishes SWM to verified memory', async () => {
    const agent = await createAgent('PipelineBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Pipeline E2E' });

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

    // Step 3: Publish from SWM to verified memory (mock chain)
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

  it('WM is empty after promote; SWM clear after publishFromSWM with flag', async () => {
    const agent = await createAgent('CleanupBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Cleanup E2E' });

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
    const sharedChain = new MockChainAdapter('mock:31337');
    const nodeA = await DKGAgent.create({
      name: 'LayersA',
      listenPort: 0,
      chainAdapter: sharedChain,
    });
    agents.push(nodeA);

    const nodeB = await DKGAgent.create({
      name: 'LayersB',
      listenPort: 0,
      chainAdapter: sharedChain,
    });
    agents.push(nodeB);

    await nodeA.start();
    await nodeB.start();
    await sleep(500);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(2000);

    await nodeA.createContextGraph({ id: CG_ID, name: 'Two-Node Memory Layers' });
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
