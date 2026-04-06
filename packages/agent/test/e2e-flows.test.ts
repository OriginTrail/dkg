/**
 * E2E tests for the core DKG agent flows:
 *
 * 1. Publish → query (single agent)
 * 2. Publish → replicate via GossipSub → query on receiver
 * 3. Update → verify new data replaces old
 * 4. Query safety (SPARQL guard rejects mutations)
 * 5. Publish with private triples + synthetic anchor
 * 6. Multi-paranet queries
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

const agents: DKGAgent[] = [];

afterEach(async () => {
  for (const a of agents) {
    try {
      await a.stop();
    } catch (err) {
      console.warn('Teardown: agent.stop() failed', err);
    }
  }
  agents.length = 0;
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Publish + Query (single agent)
// ---------------------------------------------------------------------------
describe('Publish → Query (single agent)', () => {
  it('publishes triples and queries them back', async () => {
    const agent = await DKGAgent.create({
      name: 'PublishQueryBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'pq-test', name: 'PQ', description: '' });

    const result = await agent.publish('pq-test', [
      { subject: 'did:dkg:test:Alice', predicate: 'http://schema.org/name', object: '"Alice"', graph: '' },
      { subject: 'did:dkg:test:Alice', predicate: 'http://schema.org/knows', object: 'did:dkg:test:Bob', graph: '' },
      { subject: 'did:dkg:test:Bob', predicate: 'http://schema.org/name', object: '"Bob"', graph: '' },
    ]);

    expect(result.status).toBe('confirmed');
    expect(result.kaManifest.length).toBeGreaterThan(0);

    const qr = await agent.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name } ORDER BY ?name',
      'pq-test',
    );
    expect(qr.bindings.length).toBe(2);
    const names = qr.bindings.map(b => b['name']).sort();
    expect(names[0]).toBe('"Alice"');
    expect(names[1]).toBe('"Bob"');
  }, 15000);

  it('publishes with private triples and stores private root in manifest', async () => {
    const agent = await DKGAgent.create({
      name: 'PrivateBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'priv-test', name: 'Priv', description: '' });

    const result = await agent.publish(
      'priv-test',
      [{ subject: 'did:dkg:test:Secret', predicate: 'http://schema.org/name', object: '"SecretBot"', graph: '' }],
      [{ subject: 'did:dkg:test:Secret', predicate: 'http://ex.org/apiKey', object: '"sk-12345"', graph: '' }],
    );

    expect(result.status).toBe('confirmed');
    expect(result.kaManifest).toHaveLength(1);
    expect(result.kaManifest[0].privateMerkleRoot).toBeDefined();
    expect(result.kaManifest[0].privateMerkleRoot).toHaveLength(32);

    // Public triple should be queryable
    const qr = await agent.query(
      'SELECT ?name WHERE { <did:dkg:test:Secret> <http://schema.org/name> ?name }',
      'priv-test',
    );
    expect(qr.bindings.length).toBe(1);
    expect(qr.bindings[0]['name']).toBe('"SecretBot"');
  }, 15000);
});

// ---------------------------------------------------------------------------
// Publish → Replicate → Query (two agents)
// ---------------------------------------------------------------------------
describe('Publish → Replicate → Query (two agents)', () => {
  it('publishes on A, replicates to B via GossipSub, queries on B', async () => {
    const agentA = await DKGAgent.create({
      name: 'ReplicateA', listenPort: 0, skills: [], chainAdapter: new MockChainAdapter(),
    });
    const agentB = await DKGAgent.create({
      name: 'ReplicateB', listenPort: 0, skills: [], chainAdapter: new MockChainAdapter(),
    });
    agents.push(agentA, agentB);

    await agentA.start();
    await agentB.start();
    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    await agentA.createContextGraph({ id: 'rep-test', name: 'Rep', description: '' });
    agentA.subscribeToContextGraph('rep-test');
    agentB.subscribeToContextGraph('rep-test');
    await sleep(500);

    await agentA.publish('rep-test', [
      { subject: 'did:dkg:test:Carol', predicate: 'http://schema.org/name', object: '"Carol"', graph: '' },
    ]);

    // Wait for GossipSub propagation
    await sleep(3000);

    const qr = await agentB.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      'rep-test',
    );
    expect(qr.bindings.length).toBeGreaterThanOrEqual(1);
    expect(qr.bindings[0]['name']).toBe('"Carol"');
  }, 20000);
});

// ---------------------------------------------------------------------------
// Update flow
// ---------------------------------------------------------------------------
describe('Update flow (agent level)', () => {
  it('updates published triples and verifies new data replaces old', async () => {
    const agent = await DKGAgent.create({
      name: 'UpdateBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'upd-test', name: 'Upd', description: '' });

    const initial = await agent.publish('upd-test', [
      { subject: 'did:dkg:test:Doc', predicate: 'http://schema.org/name', object: '"Doc v1"', graph: '' },
      { subject: 'did:dkg:test:Doc', predicate: 'http://schema.org/version', object: '"1"', graph: '' },
    ]);

    expect(initial.status).toBe('confirmed');
    const kcId = initial.kcId;

    // Verify initial data
    const before = await agent.query(
      'SELECT ?name WHERE { <did:dkg:test:Doc> <http://schema.org/name> ?name }',
      'upd-test',
    );
    expect(before.bindings[0]['name']).toBe('"Doc v1"');

    // Update
    const updated = await agent.update(kcId, 'upd-test', [
      { subject: 'did:dkg:test:Doc', predicate: 'http://schema.org/name', object: '"Doc v2"', graph: '' },
      { subject: 'did:dkg:test:Doc', predicate: 'http://schema.org/version', object: '"2"', graph: '' },
    ]);

    expect(updated.status).toBe('confirmed');
    expect(updated.kcId).toBe(kcId);

    // Merkle root should change
    expect(Buffer.from(updated.merkleRoot).toString('hex'))
      .not.toBe(Buffer.from(initial.merkleRoot).toString('hex'));

    // Verify updated data replaced old data
    const after = await agent.query(
      'SELECT ?name WHERE { <did:dkg:test:Doc> <http://schema.org/name> ?name }',
      'upd-test',
    );
    expect(after.bindings).toHaveLength(1);
    expect(after.bindings[0]['name']).toBe('"Doc v2"');
  }, 15000);

  it('update with private triples replaces old private triples', async () => {
    const agent = await DKGAgent.create({
      name: 'PrivUpdateBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'priv-upd', name: 'PrivUpd', description: '' });

    const initial = await agent.publish(
      'priv-upd',
      [{ subject: 'did:dkg:test:PrivDoc', predicate: 'http://schema.org/name', object: '"PrivDoc v1"', graph: '' }],
      [{ subject: 'did:dkg:test:PrivDoc', predicate: 'http://ex.org/secret', object: '"old-key"', graph: '' }],
    );

    const updated = await agent.update(initial.kcId, 'priv-upd', [
      { subject: 'did:dkg:test:PrivDoc', predicate: 'http://schema.org/name', object: '"PrivDoc v2"', graph: '' },
    ]);

    const qr = await agent.query(
      'SELECT ?name WHERE { <did:dkg:test:PrivDoc> <http://schema.org/name> ?name }',
      'priv-upd',
    );
    expect(qr.bindings).toHaveLength(1);
    expect(qr.bindings[0]['name']).toBe('"PrivDoc v2"');
  }, 15000);
});

// ---------------------------------------------------------------------------
// Query safety (SPARQL guard)
// ---------------------------------------------------------------------------
describe('Query safety (SPARQL guard)', () => {
  it('allows SELECT queries', async () => {
    const agent = await DKGAgent.create({
      name: 'QuerySafeBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);

    const qr = await agent.query('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5');
    expect(qr.bindings).toBeDefined();
  });

  it('allows CONSTRUCT queries', async () => {
    const agent = await DKGAgent.create({
      name: 'ConstructBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);

    const qr = await agent.query('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 5');
    expect(qr).toBeDefined();
  });

  it('allows ASK queries', async () => {
    const agent = await DKGAgent.create({
      name: 'AskBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);

    const qr = await agent.query('ASK WHERE { ?s ?p ?o }');
    expect(qr).toBeDefined();
  });

  it('allows DESCRIBE queries', async () => {
    const agent = await DKGAgent.create({
      name: 'DescribeBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);

    const qr = await agent.query('DESCRIBE <did:dkg:test:something>');
    expect(qr).toBeDefined();
  });

  it('allows queries with PREFIX declarations', async () => {
    const agent = await DKGAgent.create({
      name: 'PrefixBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);

    const qr = await agent.query(
      'PREFIX schema: <http://schema.org/>\nSELECT ?name WHERE { ?s schema:name ?name } LIMIT 5',
    );
    expect(qr.bindings).toBeDefined();
  });

  it('rejects INSERT queries', async () => {
    const agent = await DKGAgent.create({
      name: 'InsertReject',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);

    await expect(
      agent.query('INSERT DATA { <s> <p> <o> }'),
    ).rejects.toThrow(/SPARQL rejected/);
  });

  it('rejects DELETE queries', async () => {
    const agent = await DKGAgent.create({
      name: 'DeleteReject',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);

    await expect(
      agent.query('DELETE DATA { <s> <p> <o> }'),
    ).rejects.toThrow(/SPARQL rejected/);
  });

  it('rejects DROP queries', async () => {
    const agent = await DKGAgent.create({
      name: 'DropReject',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);

    await expect(
      agent.query('DROP GRAPH <http://example.org/>'),
    ).rejects.toThrow(/SPARQL rejected/);
  });

  it('rejects LOAD queries', async () => {
    const agent = await DKGAgent.create({
      name: 'LoadReject',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);

    await expect(
      agent.query('LOAD <http://example.org/data.ttl>'),
    ).rejects.toThrow(/SPARQL rejected/);
  });

  it('rejects SELECT with embedded INSERT via keyword scanning', async () => {
    const agent = await DKGAgent.create({
      name: 'EmbeddedReject',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);

    await expect(
      agent.query('SELECT ?s WHERE { ?s ?p ?o } ; INSERT DATA { <s> <p> <o> }'),
    ).rejects.toThrow(/SPARQL rejected/);
  });
});

// ---------------------------------------------------------------------------
// Multi-paranet queries
// ---------------------------------------------------------------------------
describe('Multi-paranet queries', () => {
  it('queries across multiple paranets', async () => {
    const agent = await DKGAgent.create({
      name: 'MultiParaBot',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'para-a', name: 'A', description: '' });
    await agent.createContextGraph({ id: 'para-b', name: 'B', description: '' });

    await agent.publish('para-a', [
      { subject: 'did:dkg:test:X', predicate: 'http://schema.org/name', object: '"XEntity"', graph: '' },
    ]);
    await agent.publish('para-b', [
      { subject: 'did:dkg:test:Y', predicate: 'http://schema.org/name', object: '"YEntity"', graph: '' },
    ]);

    // Query each paranet individually
    const qrA = await agent.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      'para-a',
    );
    expect(qrA.bindings).toHaveLength(1);
    expect(qrA.bindings[0]['name']).toBe('"XEntity"');

    const qrB = await agent.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      'para-b',
    );
    expect(qrB.bindings).toHaveLength(1);
    expect(qrB.bindings[0]['name']).toBe('"YEntity"');

    // Query without paranet scope (should search default graph or all)
    const qrAll = await agent.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
    );
    // Should get results (at minimum from genesis data)
    expect(qrAll.bindings).toBeDefined();
  }, 15000);
});

// ---------------------------------------------------------------------------
// GossipSub KC/KA metadata replication (regression tests)
// ---------------------------------------------------------------------------
describe('GossipSub KC/KA metadata replication', () => {
  it('receiver stores KC metadata for gossip-replicated publishes', async () => {
    const agentA = await DKGAgent.create({
      name: 'MetaPublisher', listenPort: 0, skills: [], chainAdapter: new MockChainAdapter(),
    });
    const agentB = await DKGAgent.create({
      name: 'MetaReceiver', listenPort: 0, skills: [], chainAdapter: new MockChainAdapter(),
    });
    agents.push(agentA, agentB);

    await agentA.start();
    await agentB.start();
    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    await agentA.createContextGraph({ id: 'meta-test', name: 'MetaTest', description: '' });
    agentA.subscribeToContextGraph('meta-test');
    agentB.subscribeToContextGraph('meta-test');
    await sleep(500);

    await agentA.publish('meta-test', [
      { subject: 'did:dkg:test:MetaEntity', predicate: 'http://schema.org/name', object: '"MetaBot"', graph: '' },
    ]);

    await sleep(4000);

    // Receiver should have KC metadata (not just data triples)
    const kcResult = await agentB.query(
      'SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE { GRAPH ?g { ?kc a <http://dkg.io/ontology/KnowledgeCollection> } }',
    );
    const kcCount = parseInt(kcResult.bindings[0]['c'].match(/^"?(\d+)/)?.[1] ?? '0', 10);
    expect(kcCount).toBeGreaterThanOrEqual(1);

    // Receiver should have KA metadata
    const kaResult = await agentB.query(
      'SELECT (COUNT(DISTINCT ?ka) AS ?c) WHERE { GRAPH ?g { ?ka a <http://dkg.io/ontology/KnowledgeAsset> } }',
    );
    const kaCount = parseInt(kaResult.bindings[0]['c'].match(/^"?(\d+)/)?.[1] ?? '0', 10);
    expect(kaCount).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('multiple publishes produce distinct KCs on receiver (no UAL collision)', async () => {
    const agentA = await DKGAgent.create({
      name: 'MultiPubA', listenPort: 0, skills: [], chainAdapter: new MockChainAdapter(),
    });
    const agentB = await DKGAgent.create({
      name: 'MultiPubB', listenPort: 0, skills: [], chainAdapter: new MockChainAdapter(),
    });
    agents.push(agentA, agentB);

    await agentA.start();
    await agentB.start();
    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    await agentA.createContextGraph({ id: 'multi-pub', name: 'MultiPub', description: '' });
    agentA.subscribeToContextGraph('multi-pub');
    agentB.subscribeToContextGraph('multi-pub');
    await sleep(500);

    // Count baseline KCs on receiver (from system paranets)
    const baselineResult = await agentB.query(
      'SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE { GRAPH ?g { ?kc a <http://dkg.io/ontology/KnowledgeCollection> } }',
    );
    const baseline = parseInt(baselineResult.bindings[0]['c'].match(/^"?(\d+)/)?.[1] ?? '0', 10);

    // Publish 3 separate KCs
    for (let i = 0; i < 3; i++) {
      await agentA.publish('multi-pub', [
        { subject: `did:dkg:test:Multi${i}`, predicate: 'http://schema.org/name', object: `"Multi ${i}"`, graph: '' },
      ]);
      await sleep(500);
    }

    await sleep(4000);

    // Receiver should see exactly 3 new KCs (not 1 due to UAL collision)
    const afterResult = await agentB.query(
      'SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE { GRAPH ?g { ?kc a <http://dkg.io/ontology/KnowledgeCollection> } }',
    );
    const afterCount = parseInt(afterResult.bindings[0]['c'].match(/^"?(\d+)/)?.[1] ?? '0', 10);
    expect(afterCount - baseline).toBe(3);
  }, 30000);

  it('receiver KC metadata has correct paranet reference', async () => {
    const agentA = await DKGAgent.create({
      name: 'ParaRefA', listenPort: 0, skills: [], chainAdapter: new MockChainAdapter(),
    });
    const agentB = await DKGAgent.create({
      name: 'ParaRefB', listenPort: 0, skills: [], chainAdapter: new MockChainAdapter(),
    });
    agents.push(agentA, agentB);

    await agentA.start();
    await agentB.start();
    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    await agentA.createContextGraph({ id: 'pararef-test', name: 'ParaRef', description: '' });
    agentA.subscribeToContextGraph('pararef-test');
    agentB.subscribeToContextGraph('pararef-test');
    await sleep(500);

    await agentA.publish('pararef-test', [
      { subject: 'did:dkg:test:RefEntity', predicate: 'http://schema.org/name', object: '"RefBot"', graph: '' },
    ]);

    await sleep(4000);

    // Check that the replicated KC has correct paranet reference
    const result = await agentB.query(
      `SELECT ?kc WHERE {
        GRAPH ?g { ?kc <http://dkg.io/ontology/paranet> <did:dkg:context-graph:pararef-test> }
      }`,
    );
    expect(result.bindings.length).toBeGreaterThanOrEqual(1);
  }, 20000);
});
