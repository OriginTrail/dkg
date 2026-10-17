import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Exercise registration, sharing and scoped attribution through a real local daemon. */
export async function runSharedMemoryMetadataRegression({ base, token }) {
  const url = new URL(base);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'This fixture requires a local devnet');
  const contextGraphId = `attribution-${randomUUID()}`;
  async function post(path, body, auth = token, retryShare = false) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(new URL(path, url), { method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      const result = await response.json();
      if (retryShare && attempt < 5 && response.status === 503 && result.code === 'PROMOTE_RETRYABLE_FAILURE') {
        assert.equal(result.retryAction, 'resume_existing_knowledge_asset');
        assert.equal(result.contextGraphId, body.contextGraphId);
        assert.equal(result.retryPhase, 'swm-share');
        assert.equal(response.headers.get('retry-after'), '1');
        await delay(1000);
        continue;
      }
      assert(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(result)}`);
      return result;
    }
  }
  const contributors = [];
  for (let index = 0; index < 5; index++) {
    contributors.push(await post('/api/agent/register', { name: `${contextGraphId}-agent-${index}`, framework: 'devnet-regression' }));
  }
  const owner = contributors[0].authToken;
  for (const id of [contextGraphId, `${contextGraphId}/child`]) {
    await post('/api/context-graph/create', { id, name: id, accessPolicy: 0 }, owner);
    await post('/api/context-graph/register', { id, accessPolicy: 0 }, owner);
  }
  for (let index = 0; index < contributors.length; index++) {
    const subGraphName = index ? `sub${index}` : undefined;
    if (subGraphName) await post('/api/sub-graph/create', { contextGraphId, subGraphName }, owner);
    const name = `attribution-${index}`;
    await post('/api/knowledge-assets', { contextGraphId, subGraphName, name,
      quads: [{ subject: `urn:${contextGraphId}:${index}`, predicate: 'http://schema.org/name', object: `"Contributor ${index}"` }] }, contributors[index].authToken);
    const share = await post(`/api/knowledge-assets/${name}/swm/share`, { contextGraphId, subGraphName }, contributors[index].authToken, true);
    assert.equal(share.swmShared, true);
  }
  const child = `${contextGraphId}/child`;
  await post('/api/knowledge-assets', { contextGraphId: child, name: 'child-asset',
    quads: [{ subject: `urn:${contextGraphId}:child`, predicate: 'http://schema.org/name', object: '"Child"' }] }, owner);
  await post('/api/knowledge-assets/child-asset/swm/share', { contextGraphId: child }, owner, true);
  const sparql = `SELECT DISTINCT ?g ?agent WHERE { GRAPH ?g {
    ?op a <http://dkg.io/ontology/WorkspaceOperation> ; <http://www.w3.org/ns/prov#wasAttributedTo> ?agent
  } FILTER(STRENDS(STR(?g), "/_shared_memory_meta")) } LIMIT 20`;
  const query = includeSharedMemoryMeta => post('/api/query', { sparql, contextGraphId,
    includeContextGraphPartitions: true, includeSharedMemoryMeta }, owner);
  const before = await query(false), result = await query(true), after = await query(false);
  assert.deepEqual(after.result.bindings, before.result.bindings);
  assert.equal(result.result.bindings.length, 5);
  assert.equal(new Set(result.result.bindings.map(row => row.agent)).size, 5);
  assert(result.result.bindings.every(row => !row.g.startsWith(`did:dkg:context-graph:${child}/`)));
  assert.equal(before.result.bindings.length, 1);
  // Attribution rows alone cannot prove ordinary content partitions survived.
  const contentSparql = `SELECT DISTINCT ?subject ?name WHERE { GRAPH ?g {
    ?subject <http://schema.org/name> ?name
  } FILTER(STRSTARTS(STR(?subject), "urn:${contextGraphId}:")) } ORDER BY ?subject LIMIT 20`;
  const content = async includeSharedMemoryMeta => (await post('/api/query', {
    sparql: contentSparql, contextGraphId, view: 'shared-working-memory',
    includeContextGraphPartitions: true, includeSharedMemoryMeta,
  }, owner)).result.bindings;
  const expectedContent = contributors.map((_, index) => ({
    subject: `urn:${contextGraphId}:${index}`, name: JSON.stringify(`Contributor ${index}`),
  }));
  const contentBefore = await content(false), contentExpanded = await content(true), contentAfter = await content(false);
  for (const rows of [contentBefore, contentExpanded, contentAfter]) {
    assert.deepEqual(rows, expectedContent, 'All five root/subgraph content rows, with no child-CG row, must remain visible');
    assert(rows.every(row => row.subject !== `urn:${contextGraphId}:child`));
  }
  return { contextGraphId, contributors: 5, childExcluded: true, contentRows: expectedContent.length, contentScopeUnchanged: true };
}
