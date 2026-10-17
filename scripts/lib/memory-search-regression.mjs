import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Real HTTP writes/reads only. Called by the local devnet runner and daemon integration test. */
export async function runMemorySearchRegression({ base, token }) {
  const url = new URL(base);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'This fixture requires a local devnet');
  const contextGraphId = `memory-search-${randomUUID()}`;
  async function post(path, body, auth = token) {
    const response = await fetch(new URL(path, url), { method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    assert(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  const alice = await post('/api/agent/register', { name: 'memory-search-alice', framework: 'devnet-regression' });
  const bob = await post('/api/agent/register', { name: 'memory-search-bob', framework: 'devnet-regression' });
  assert(alice.authToken && bob.authToken);
  await post('/api/context-graph/create', { id: contextGraphId, name: 'Memory search regression', accessPolicy: 0 }, alice.authToken);
  await post('/api/context-graph/register', { id: contextGraphId, accessPolicy: 0 }, alice.authToken);
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
