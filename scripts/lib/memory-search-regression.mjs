import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

async function createSearchScenario({ base, token, graphPrefix, agentPrefix, graphName }) {
  const url = new URL(base);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'This fixture requires a local devnet');
  const scenarioId = randomUUID();
  const contextGraphId = `${graphPrefix}-${scenarioId}`;
  async function post(path, body, auth = token) {
    const response = await fetch(new URL(path, url), { method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    assert(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  const alice = await post('/api/agent/register', { name: `${agentPrefix}-alice-${scenarioId}`, framework: 'devnet-regression' });
  const bob = await post('/api/agent/register', { name: `${agentPrefix}-bob-${scenarioId}`, framework: 'devnet-regression' });
  assert(alice.authToken && bob.authToken);
  await post('/api/context-graph/create', { id: contextGraphId, name: graphName, accessPolicy: 0 }, alice.authToken);
  await post('/api/context-graph/register', { id: contextGraphId, accessPolicy: 0 }, alice.authToken);
  return { post, scenarioId, contextGraphId, alice, bob };
}

/** Real HTTP writes/reads only. Called by the local devnet runner and daemon integration test. */
export async function runMemorySearchRegression({ base, token }) {
  const { post, contextGraphId, alice, bob } = await createSearchScenario({ base, token,
    graphPrefix: 'memory-search', agentPrefix: 'memory-search', graphName: 'Memory search regression' });
  const create = (name, count, auth) => post('/api/knowledge-assets', {
    contextGraphId, name, finalize: false,
    quads: Array.from({ length: count }, (_, index) => ({ subject: `urn:${contextGraphId}:${name}:${index}`,
      predicate: 'http://schema.org/name', object: `"needle ${name} ${index}"` })),
  }, auth);
  await create('draft', 4, alice.authToken);
  await create('shared', 1, alice.authToken);
  await create('foreign', 1, bob.authToken);
  const shared = await post('/api/knowledge-assets/shared/swm/share', { contextGraphId }, alice.authToken);
  assert.equal(shared.swmShared, true);
  const result = await post('/api/memory/search', {
    query: 'needle', contextGraphId, memoryLayers: ['wm', 'swm'], limit: 2,
  }, alice.authToken);
  assert.equal(result.resultCount, 2);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map(row => row.memoryLayer), ['wm', 'swm']);
  assert(result.results.some(row => row.entityUri.includes(':draft:')));
  assert(result.results.some(row => row.entityUri.includes(':shared:')));
  assert(!JSON.stringify(result.results).includes(':foreign:'));
  const isolated = await post('/api/memory/search', {
    query: 'foreign', contextGraphId, memoryLayers: ['wm'], limit: 10,
  }, alice.authToken);
  assert.equal(isolated.resultCount, 0);
  const owned = await post('/api/memory/search', {
    query: 'foreign', contextGraphId, memoryLayers: ['wm'], limit: 10,
  }, bob.authToken);
  assert.equal(owned.resultCount, 1);
  const operator = await post('/api/memory/search', {
    query: 'foreign', contextGraphId, memoryLayers: ['wm'], limit: 10,
  });
  assert.equal(operator.resultCount, 1);
  return { contextGraphId, cases: ['fair-wm-swm-limit', 'returned-result-count', 'agent-isolation', 'operator-agent-fanout'] };
}

/** Requires the equal-vector HTTP fixture; all indexing still goes through the daemon. */
export async function runMemoryVectorSearchRegression({ base, token }) {
  const { post, scenarioId, contextGraphId, alice, bob } = await createSearchScenario({ base, token,
    graphPrefix: 'memory-vectors', agentPrefix: 'vector', graphName: 'Vector tenant regression' });
  // Neither document contains this text. A disabled/failing embedding provider
  // cannot make the test pass via the SPARQL fallback.
  const query = `nonlexical-vector-query-${scenarioId}`;
  const documents = [
    { auth: alice.authToken, markdown: `Alice confidential planning ${scenarioId}` },
    { auth: bob.authToken, markdown: `Bob confidential research ${scenarioId}` },
  ];
  const turns = [];
  for (const { auth, markdown } of documents) {
    const turn = await post('/api/memory/turn', { markdown, contextGraphId, layer: 'wm' }, auth);
    assert.equal(typeof turn.embeddingId, 'string', 'The actual memory route must persist an embedding');
    assert(turn.embeddingId.length > 0);
    assert.equal(turn.layer, 'wm');
    turns.push(turn);
  }
  assert.notEqual(turns[0].turnUri, turns[1].turnUri);
  async function search(auth, expectedIndexes) {
    const result = await post('/api/memory/search', {
      query, contextGraphId, memoryLayers: ['wm'], limit: 10,
    }, auth);
    assert.equal(result.resultCount, expectedIndexes.length);
    assert.equal(result.results.length, expectedIndexes.length);
    assert.deepEqual(result.results.map(row => row.entityUri).sort(),
      expectedIndexes.map(index => turns[index].turnUri).sort());
    for (const row of result.results) {
      const index = turns.findIndex(turn => turn.turnUri === row.entityUri);
      assert.deepEqual(row.sources, ['vector'], 'This must exercise SQLite vector retrieval, not text fallback');
      assert.equal(row.similarity, 1);
      assert.equal(row.memoryLayer, 'wm');
      assert.equal(row.snippet, documents[index].markdown);
      assert.equal(row.sourceFile, `urn:dkg:file:${turns[index].fileHash}`);
    }
  }
  await search(alice.authToken, [0]);
  await search(bob.authToken, [1]);
  await search(token, [0, 1]);
  return { contextGraphId, query, documents: documents.map(({ markdown }) => markdown),
    cases: ['alice-vector-isolation', 'bob-vector-isolation', 'operator-vector-fanout', 'vector-only-no-text-fallback'] };
}
