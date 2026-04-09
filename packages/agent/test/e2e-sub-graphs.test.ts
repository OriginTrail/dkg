/**
 * E2E tests for sub-graph lifecycle:
 *
 * 1. Create sub-graphs within a context graph
 * 2. List sub-graphs via agent API
 * 3. Publish data targeting a specific sub-graph
 * 4. Query data scoped to a sub-graph (isolation)
 * 5. Publish to different sub-graphs — verify data isolation
 * 6. Publish from shared memory to a sub-graph
 * 7. Remove a sub-graph
 * 8. Two-node replication: sub-graph publish replicates to peer
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

// ---------------------------------------------------------------------------
// Single-agent sub-graph lifecycle
// ---------------------------------------------------------------------------
describe('Sub-graph lifecycle (single agent)', () => {
  it('creates sub-graphs and lists them', async () => {
    const agent = await DKGAgent.create({
      name: 'SubGraphBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-lifecycle', name: 'SG Lifecycle', description: '' });

    const r1 = await agent.createSubGraph('sg-lifecycle', 'code', {
      description: 'Parsed code structure',
    });
    expect(r1.uri).toBe('did:dkg:context-graph:sg-lifecycle/code');

    const r2 = await agent.createSubGraph('sg-lifecycle', 'decisions');
    expect(r2.uri).toBe('did:dkg:context-graph:sg-lifecycle/decisions');

    const list = await agent.listSubGraphs('sg-lifecycle');
    const names = list.map(sg => sg.name).sort();
    expect(names).toEqual(['code', 'decisions']);

    const codeSg = list.find(sg => sg.name === 'code');
    expect(codeSg?.description).toBe('Parsed code structure');
  }, 15_000);

  it('rejects invalid sub-graph names', async () => {
    const agent = await DKGAgent.create({
      name: 'ValidationBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-validation', name: 'Validation', description: '' });

    await expect(agent.createSubGraph('sg-validation', '_meta'))
      .rejects.toThrow('reserved');
    await expect(agent.createSubGraph('sg-validation', 'code/sub'))
      .rejects.toThrow('/');
    await expect(agent.createSubGraph('sg-validation', ''))
      .rejects.toThrow('empty');
    await expect(agent.createSubGraph('sg-validation', 'context'))
      .rejects.toThrow('reserved');
  }, 15_000);

  it('rejects sub-graph on non-existent context graph', async () => {
    const agent = await DKGAgent.create({
      name: 'MissingCgBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await expect(agent.createSubGraph('nonexistent-cg', 'code'))
      .rejects.toThrow('does not exist');
  }, 15_000);

  it('removes a sub-graph', async () => {
    const agent = await DKGAgent.create({
      name: 'RemoveBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-remove', name: 'Remove', description: '' });
    await agent.createSubGraph('sg-remove', 'temp');

    let list = await agent.listSubGraphs('sg-remove');
    expect(list).toHaveLength(1);

    await agent.removeSubGraph('sg-remove', 'temp');

    list = await agent.listSubGraphs('sg-remove');
    expect(list).toHaveLength(0);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Publishing and querying sub-graphs
// ---------------------------------------------------------------------------
describe('Sub-graph publish + query (single agent)', () => {
  it('publishes to a sub-graph and queries it back', async () => {
    const agent = await DKGAgent.create({
      name: 'PubSubGraphBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-pubq', name: 'PubQ', description: '' });
    await agent.createSubGraph('sg-pubq', 'code');

    const result = await agent.publish('sg-pubq', [
      { subject: 'urn:fn:main', predicate: 'http://ex.org/type', object: '"Function"', graph: '' },
      { subject: 'urn:fn:main', predicate: 'http://ex.org/signature', object: '"main()"', graph: '' },
    ], undefined, { subGraphName: 'code' });

    expect(result.status).toBe('confirmed');

    // Query via subGraphName
    const qr = await agent.query(
      'SELECT ?sig WHERE { ?fn <http://ex.org/signature> ?sig }',
      { contextGraphId: 'sg-pubq', subGraphName: 'code' },
    );
    expect(qr.bindings).toHaveLength(1);
    expect(qr.bindings[0]['sig']).toBe('"main()"');
  }, 15_000);

  it('sub-graph data is isolated from root data graph', async () => {
    const agent = await DKGAgent.create({
      name: 'IsolationBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-isolation', name: 'Isolation', description: '' });
    await agent.createSubGraph('sg-isolation', 'code');

    // Publish to root graph
    await agent.publish('sg-isolation', [
      { subject: 'urn:root:entity', predicate: 'http://ex.org/type', object: '"RootData"', graph: '' },
    ]);

    // Publish to sub-graph
    await agent.publish('sg-isolation', [
      { subject: 'urn:code:entity', predicate: 'http://ex.org/type', object: '"CodeData"', graph: '' },
    ], undefined, { subGraphName: 'code' });

    // Root graph query should not see code data
    const rootResult = await agent.query(
      'SELECT ?s ?type WHERE { ?s <http://ex.org/type> ?type }',
      { contextGraphId: 'sg-isolation' },
    );
    const rootSubjects = rootResult.bindings.map(b => b['s']);
    expect(rootSubjects).toContain('urn:root:entity');
    expect(rootSubjects).not.toContain('urn:code:entity');

    // Sub-graph query should not see root data
    const codeResult = await agent.query(
      'SELECT ?s ?type WHERE { ?s <http://ex.org/type> ?type }',
      { contextGraphId: 'sg-isolation', subGraphName: 'code' },
    );
    const codeSubjects = codeResult.bindings.map(b => b['s']);
    expect(codeSubjects).toContain('urn:code:entity');
    expect(codeSubjects).not.toContain('urn:root:entity');
  }, 20_000);

  it('different sub-graphs are isolated from each other', async () => {
    const agent = await DKGAgent.create({
      name: 'MultiSubBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-multi', name: 'Multi', description: '' });
    await agent.createSubGraph('sg-multi', 'code');
    await agent.createSubGraph('sg-multi', 'decisions');

    await agent.publish('sg-multi', [
      { subject: 'urn:fn:parse', predicate: 'http://ex.org/type', object: '"Function"', graph: '' },
    ], undefined, { subGraphName: 'code' });

    await agent.publish('sg-multi', [
      { subject: 'urn:dec:1', predicate: 'http://ex.org/type', object: '"Decision"', graph: '' },
    ], undefined, { subGraphName: 'decisions' });

    // Code sub-graph only has functions
    const codeResult = await agent.query(
      'SELECT ?s ?type WHERE { ?s <http://ex.org/type> ?type }',
      { contextGraphId: 'sg-multi', subGraphName: 'code' },
    );
    expect(codeResult.bindings).toHaveLength(1);
    expect(codeResult.bindings[0]['type']).toBe('"Function"');

    // Decisions sub-graph only has decisions
    const decResult = await agent.query(
      'SELECT ?s ?type WHERE { ?s <http://ex.org/type> ?type }',
      { contextGraphId: 'sg-multi', subGraphName: 'decisions' },
    );
    expect(decResult.bindings).toHaveLength(1);
    expect(decResult.bindings[0]['type']).toBe('"Decision"');
  }, 20_000);

  it('publishFromSharedMemory targets sub-graph', async () => {
    const agent = await DKGAgent.create({
      name: 'SWMSubBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-swm', name: 'SWM', description: '' });
    await agent.createSubGraph('sg-swm', 'tasks');

    // Share to sub-graph SWM
    await agent.share('sg-swm', [
      { subject: 'urn:task:1', predicate: 'http://ex.org/title', object: '"Implement sub-graphs"', graph: '' },
      { subject: 'urn:task:1', predicate: 'http://ex.org/status', object: '"done"', graph: '' },
    ], { localOnly: true, subGraphName: 'tasks' });

    // Verify in sub-graph SWM
    const swmResult = await agent.query(
      'SELECT ?title WHERE { ?s <http://ex.org/title> ?title }',
      { contextGraphId: 'sg-swm', graphSuffix: '_shared_memory', subGraphName: 'tasks' },
    );
    expect(swmResult.bindings).toHaveLength(1);

    // Publish from SWM to sub-graph
    const result = await agent.publishFromSharedMemory('sg-swm', 'all', {
      subGraphName: 'tasks',
    });
    expect(result.status).toBe('confirmed');

    // Verify data is in the sub-graph
    const sgResult = await agent.query(
      'SELECT ?title WHERE { ?s <http://ex.org/title> ?title }',
      { contextGraphId: 'sg-swm', subGraphName: 'tasks' },
    );
    expect(sgResult.bindings).toHaveLength(1);
    expect(sgResult.bindings[0]['title']).toBe('"Implement sub-graphs"');

    // Not in root data graph
    const rootResult = await agent.query(
      'SELECT ?title WHERE { ?s <http://ex.org/title> ?title }',
      { contextGraphId: 'sg-swm' },
    );
    expect(rootResult.bindings).toHaveLength(0);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Two-node replication with sub-graphs
// ---------------------------------------------------------------------------
describe('Sub-graph replication (two agents)', () => {
  it('sub-graph publish on A replicates to B', async () => {
    const agentA = await DKGAgent.create({
      name: 'SubReplicaA', listenPort: 0, skills: [], chainAdapter: new MockChainAdapter(),
    });
    const agentB = await DKGAgent.create({
      name: 'SubReplicaB', listenPort: 0, skills: [], chainAdapter: new MockChainAdapter(),
    });
    agents.push(agentA, agentB);

    await agentA.start();
    await agentB.start();
    await sleep(800);

    const addrA = agentA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await agentB.connectTo(addrA);
    await sleep(2000);

    await agentA.createContextGraph({ id: 'sg-replica', name: 'Replica', description: '' });
    await agentA.createSubGraph('sg-replica', 'data');

    agentA.subscribeToContextGraph('sg-replica');
    agentB.subscribeToContextGraph('sg-replica');
    await sleep(1500);

    // A publishes to sub-graph
    const result = await agentA.publish('sg-replica', [
      { subject: 'urn:replicated:1', predicate: 'http://ex.org/label', object: '"Replicated Entity"', graph: '' },
    ], undefined, { subGraphName: 'data' });
    expect(result.status).toBe('confirmed');

    // Poll B for the replicated data (B receives via GossipSub broadcast)
    const deadline = Date.now() + 15_000;
    let bResult: any = { bindings: [] };
    while (Date.now() < deadline) {
      bResult = await agentB.query(
        'SELECT ?label WHERE { ?s <http://ex.org/label> ?label }',
        { contextGraphId: 'sg-replica', subGraphName: 'data' },
      );
      if (bResult.bindings.length > 0) break;
      await sleep(500);
    }

    expect(bResult.bindings.length).toBeGreaterThanOrEqual(1);
    expect(bResult.bindings[0]['label']).toBe('"Replicated Entity"');

    // Sub-graph isolation on replica: data must NOT be in root graph
    const rootCheck = await agentB.query(
      'SELECT ?label WHERE { ?s <http://ex.org/label> ?label }',
      { contextGraphId: 'sg-replica' },
    );
    expect(rootCheck.bindings).toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Cross-layer sub-graphs: WM → SWM → VM pipeline
// ---------------------------------------------------------------------------
describe('Sub-graph across memory layers (single agent)', () => {
  it('shares to sub-graph SWM and queries it back', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmSubBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-swm-layer', name: 'SWM Layer', description: '' });
    await agent.createSubGraph('sg-swm-layer', 'code');

    // Share directly to sub-graph SWM
    await agent.share('sg-swm-layer', [
      { subject: 'urn:fn:parse', predicate: 'http://ex.org/type', object: '"Function"', graph: '' },
    ], { subGraphName: 'code', localOnly: true });

    // Query sub-graph SWM
    const sgResult = await agent.query(
      'SELECT ?type WHERE { ?s <http://ex.org/type> ?type }',
      { contextGraphId: 'sg-swm-layer', graphSuffix: '_shared_memory', subGraphName: 'code' },
    );
    expect(sgResult.bindings).toHaveLength(1);
    expect(sgResult.bindings[0]['type']).toBe('"Function"');

    // Root SWM should NOT have sub-graph data
    const rootResult = await agent.query(
      'SELECT ?type WHERE { ?s <http://ex.org/type> ?type }',
      { contextGraphId: 'sg-swm-layer', graphSuffix: '_shared_memory' },
    );
    expect(rootResult.bindings).toHaveLength(0);
  }, 15_000);

  it('assertion.write accepts Quad[] input', async () => {
    const agent = await DKGAgent.create({
      name: 'QuadDraftBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-quad-draft', name: 'Quad Draft', description: '' });
    await agent.createSubGraph('sg-quad-draft', 'code');

    await agent.assertion.create('sg-quad-draft', 'quad-test', { subGraphName: 'code' });

    // Write using Quad[] (standard format, same as publish/share)
    await agent.assertion.write('sg-quad-draft', 'quad-test', [
      { subject: 'urn:fn:main', predicate: 'http://ex.org/sig', object: '"main()"', graph: '' },
      { subject: 'urn:fn:main', predicate: 'http://ex.org/lang', object: '"TypeScript"', graph: '' },
    ], { subGraphName: 'code' });

    const quads = await agent.assertion.query('sg-quad-draft', 'quad-test', { subGraphName: 'code' });
    expect(quads).toHaveLength(2);
  }, 15_000);

  it('assertion.write accepts JSON-LD input', async () => {
    const agent = await DKGAgent.create({
      name: 'JsonLdDraftBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-jsonld-draft', name: 'JSONLD Draft', description: '' });
    await agent.createSubGraph('sg-jsonld-draft', 'entities');

    await agent.assertion.create('sg-jsonld-draft', 'ld-test', { subGraphName: 'entities' });

    // Write using JSON-LD (auto-converted to quads)
    await agent.assertion.write('sg-jsonld-draft', 'ld-test', {
      '@id': 'urn:entity:alice',
      'http://schema.org/name': 'Alice',
      'http://schema.org/jobTitle': 'Engineer',
    }, { subGraphName: 'entities' });

    const quads = await agent.assertion.query('sg-jsonld-draft', 'ld-test', { subGraphName: 'entities' });
    expect(quads.length).toBeGreaterThanOrEqual(2);
    const names = quads.filter(q => q.predicate === 'http://schema.org/name');
    expect(names).toHaveLength(1);
  }, 15_000);

  it('WM assertion with subGraphName → promote to sub-graph SWM', async () => {
    const agent = await DKGAgent.create({
      name: 'DraftSubBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-wm-layer', name: 'WM Layer', description: '' });
    await agent.createSubGraph('sg-wm-layer', 'decisions');

    // Create assertion in sub-graph WM
    const assertionUri = await agent.assertion.create('sg-wm-layer', 'arch-review', { subGraphName: 'decisions' });
    expect(assertionUri).toContain('/decisions/assertion/');

    // Write to assertion
    await agent.assertion.write('sg-wm-layer', 'arch-review', [
      { subject: 'urn:dec:1', predicate: 'http://ex.org/title', object: '"Use TypeScript"' },
    ], { subGraphName: 'decisions' });

    // Query assertion
    const assertionQuads = await agent.assertion.query('sg-wm-layer', 'arch-review', { subGraphName: 'decisions' });
    expect(assertionQuads).toHaveLength(1);

    // Promote to sub-graph SWM
    const result = await agent.assertion.promote('sg-wm-layer', 'arch-review', {
      entities: 'all',
      subGraphName: 'decisions',
    });
    expect(result.promotedCount).toBe(1);

    // Query sub-graph SWM for promoted data
    const swmResult = await agent.query(
      'SELECT ?title WHERE { ?s <http://ex.org/title> ?title }',
      { contextGraphId: 'sg-wm-layer', graphSuffix: '_shared_memory', subGraphName: 'decisions' },
    );
    expect(swmResult.bindings).toHaveLength(1);
    expect(swmResult.bindings[0]['title']).toBe('"Use TypeScript"');

    // Root SWM should be empty
    const rootSwm = await agent.query(
      'SELECT ?title WHERE { ?s <http://ex.org/title> ?title }',
      { contextGraphId: 'sg-wm-layer', graphSuffix: '_shared_memory' },
    );
    expect(rootSwm.bindings).toHaveLength(0);

    // Assertion should be empty after promotion
    const emptyAssertion = await agent.assertion.query('sg-wm-layer', 'arch-review', { subGraphName: 'decisions' });
    expect(emptyAssertion).toHaveLength(0);
  }, 15_000);

  it('full pipeline: WM draft → SWM → VM (sub-graph scoped)', async () => {
    const agent = await DKGAgent.create({
      name: 'PipelineBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-pipeline', name: 'Pipeline', description: '' });
    await agent.createSubGraph('sg-pipeline', 'code');

    // Step 1: Assertion in WM/code
    await agent.assertion.create('sg-pipeline', 'scan', { subGraphName: 'code' });
    await agent.assertion.write('sg-pipeline', 'scan', [
      { subject: 'urn:fn:main', predicate: 'http://ex.org/sig', object: '"main()"' },
    ], { subGraphName: 'code' });

    // Step 2: Promote WM/code → SWM/code
    await agent.assertion.promote('sg-pipeline', 'scan', {
      entities: 'all',
      subGraphName: 'code',
    });

    // Verify in SWM/code
    const swmCheck = await agent.query(
      'SELECT ?sig WHERE { ?s <http://ex.org/sig> ?sig }',
      { contextGraphId: 'sg-pipeline', graphSuffix: '_shared_memory', subGraphName: 'code' },
    );
    expect(swmCheck.bindings).toHaveLength(1);

    // Step 3: Publish from SWM to VM/code
    const publishResult = await agent.publishFromSharedMemory('sg-pipeline', 'all', {
      subGraphName: 'code',
    });
    expect(publishResult.status).toBe('confirmed');

    // Verify in VM/code
    const vmResult = await agent.query(
      'SELECT ?sig WHERE { ?s <http://ex.org/sig> ?sig }',
      { contextGraphId: 'sg-pipeline', subGraphName: 'code' },
    );
    expect(vmResult.bindings).toHaveLength(1);
    expect(vmResult.bindings[0]['sig']).toBe('"main()"');

    // Root VM should be empty
    const rootVm = await agent.query(
      'SELECT ?sig WHERE { ?s <http://ex.org/sig> ?sig }',
      { contextGraphId: 'sg-pipeline' },
    );
    expect(rootVm.bindings).toHaveLength(0);
  }, 20_000);

  it('sub-graph SWM data is isolated between sub-graphs', async () => {
    const agent = await DKGAgent.create({
      name: 'IsoSwmBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'sg-iso-swm', name: 'Iso SWM', description: '' });
    await agent.createSubGraph('sg-iso-swm', 'code');
    await agent.createSubGraph('sg-iso-swm', 'decisions');

    await agent.share('sg-iso-swm', [
      { subject: 'urn:fn:1', predicate: 'http://ex.org/type', object: '"Function"', graph: '' },
    ], { subGraphName: 'code', localOnly: true });

    await agent.share('sg-iso-swm', [
      { subject: 'urn:dec:1', predicate: 'http://ex.org/type', object: '"Decision"', graph: '' },
    ], { subGraphName: 'decisions', localOnly: true });

    const codeSwm = await agent.query(
      'SELECT ?type WHERE { ?s <http://ex.org/type> ?type }',
      { contextGraphId: 'sg-iso-swm', graphSuffix: '_shared_memory', subGraphName: 'code' },
    );
    expect(codeSwm.bindings).toHaveLength(1);
    expect(codeSwm.bindings[0]['type']).toBe('"Function"');

    const decSwm = await agent.query(
      'SELECT ?type WHERE { ?s <http://ex.org/type> ?type }',
      { contextGraphId: 'sg-iso-swm', graphSuffix: '_shared_memory', subGraphName: 'decisions' },
    );
    expect(decSwm.bindings).toHaveLength(1);
    expect(decSwm.bindings[0]['type']).toBe('"Decision"');
  }, 15_000);
});
