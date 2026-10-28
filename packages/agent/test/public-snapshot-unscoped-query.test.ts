import { OxigraphStore, StoreResponseTooLargeError } from '@origintrail-official/dkg-storage';
import { contextGraphDataGraphUri, DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import { markCoreTrustedGraph } from '../src/public-snapshot-evidence.js';

const agents: DKGAgent[] = [];
afterEach(async () => {
  while (agents.length) await agents.pop()!.stop();
});

async function startAgent(store?: OxigraphStore) {
  const agent = await DKGAgent.create({ name: 'UnscopedQueryTrust', nodeRole: 'edge',
    listenHost: '127.0.0.1', listenPort: 0, store, chainAdapter: new MockChainAdapter(),
    syncReconcilerEnabled: false, vmReconcilerEnabled: false, randomSamplingUseWorkerThread: false });
  agents.push(agent);
  await agent.start();
  return agent;
}

const values = (result: { bindings?: Array<Record<string, string>> }) => (result.bindings ?? []).map(row => row.value).sort();

describe('agent.query after a core-cache snapshot job marked a graph', () => {
  it('answers unscoped queries over every other graph and keeps reads of the marked graph guarded', async () => {
    const agent = await startAgent();
    const imported = 'did:dkg:context-graph:imported';
    await agent.store.insert([
      { subject: 'urn:entity:imported', predicate: 'urn:value', object: '"imported"', graph: imported },
      { subject: 'urn:entity:imported-child', predicate: 'urn:value', object: '"imported-child"', graph: `${imported}/child/_meta` },
      { subject: 'urn:entity:local', predicate: 'urn:value', object: '"local"', graph: 'did:dkg:context-graph:local-notes' },
    ]);
    const sparql = 'SELECT ?value WHERE { GRAPH ?g { ?s <urn:value> ?value } }';
    const count = 'SELECT (COUNT(*) AS ?c) WHERE { { ?s <urn:value> ?o } UNION { GRAPH ?g { ?s <urn:value> ?o } } }';
    expect(values(await agent.query(sparql))).toEqual(['"imported"', '"imported-child"', '"local"']);
    expect((await agent.query(count)).bindings?.[0]?.c).toContain('"3"');

    await markCoreTrustedGraph(agent.store, 'imported');
    // Unscoped reads keep working, with the marked graph and its descendants left out.
    expect(values(await agent.query(sparql))).toEqual(['"local"']);
    expect((await agent.query(count)).bindings?.[0]?.c).toContain('"1"');
    // Whatever the query's shape, the store answers over its dataset without the marked graphs.
    expect(values(await agent.query(`SELECT ?value WHERE { GRAPH <${imported}> { ?s <urn:value> ?value } }`))).toEqual([]);
    expect(values(await agent.query('SELECT ?value WHERE { GRAPH ?g { OPTIONAL { { SELECT ?value WHERE { ?s <urn:value> ?value } } } } }')))
      .not.toContain('"imported"');
    await expect(agent.query(`SELECT ?value FROM <${imported}> WHERE { ?s <urn:value> ?value }`))
      .rejects.toMatchObject({ code: 'CORE_CACHE_QUERY_TRUST_REQUIRED' });
    await expect(agent.query(sparql, { chainEvidenceMode: 'core-cache' })).rejects.toThrow('explicit context graph');

    // Scoped reads of the marked graph still need explicit acceptance; other graphs do not.
    const scoped = 'SELECT ?value WHERE { ?s <urn:value> ?value }';
    await expect(agent.query(scoped, { contextGraphId: 'imported' }))
      .rejects.toMatchObject({ code: 'CORE_CACHE_QUERY_TRUST_REQUIRED' });
    expect(values(await agent.query(scoped, { contextGraphId: 'imported', chainEvidenceMode: 'core-cache' }))).toEqual(['"imported"']);
    expect(values(await agent.query(scoped, { contextGraphId: 'local-notes' }))).toEqual(['"local"']);
  });
});

it.each(['cold', 'warm'] as const)('charges the complete inventory through real agent composition (%s catalog)', async cache => {
  const rawStore = new OxigraphStore();
  const agent = await startAgent(rawStore);
  const graph = 'did:dkg:context-graph:local-budget';
  // Unrelated graphs must be charged even though the owner projection removes them.
  await agent.store.insert(Array.from({ length: 1_000 }, (_, index) => ({
    subject: `urn:unrelated:${index}`, predicate: 'urn:unrelated', object: '"x"',
    graph: `urn:unrelated:${index}:${'g'.repeat(500)}`,
  })));
  await agent.store.insert(Array.from({ length: 16 }, (_, index) => ({
    subject: `urn:budget:${index}`, predicate: 'urn:budget-value',
    object: JSON.stringify(`${index}:${'x'.repeat(50_000)}`), graph,
  })));
  const query = `SELECT ?value WHERE { GRAPH <${graph}> { ?s <urn:budget-value> ?value } }`;
  // Compute costs independently from source responses, never from the budget meter.
  const inventory = await rawStore.listGraphs();
  const policy = await rawStore.query(`SELECT ?cg WHERE {
    GRAPH <${contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)}> {
      ?cg <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> "private"
    }
  }`);
  const content = await rawStore.query(query);
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const inventoryBytes = bytes(inventory), policyBytes = bytes(policy), contentBytes = bytes(content);
  const total = inventoryBytes + policyBytes + contentBytes;
  const ceiling = 1024 * 1024;
  expect(inventoryBytes).toBeGreaterThan(500_000);
  expect(contentBytes).toBeGreaterThan(800_000);
  expect(inventoryBytes + policyBytes).toBeLessThan(ceiling);
  expect(contentBytes).toBeLessThan(ceiling);
  expect(total).toBeGreaterThan(ceiling);
  if (cache === 'warm') await agent.query(query, { maxResponseBytes: total });
  for (const limit of [ceiling, total - 1]) {
    const outcome = await agent.query(query, { maxResponseBytes: limit }).then(
      () => ({ code: 'unexpected-success' }),
      error => ({ code: error.code, maxBytes: error.maxBytes, actualBytes: error.actualBytes }),
    );
    expect(outcome).toEqual({ code: 'QUERY_RESULT_TOO_LARGE', maxBytes: limit, actualBytes: total });
  }
  await expect(agent.query(query, { maxResponseBytes: total })).resolves.toMatchObject({ bindings: content.type === 'bindings' ? content.bindings : [] });
});

it.each(['policy', 'inventory'] as const)('normalizes caller-capped %s admission errors at the agent boundary', async kind => {
  const agent = await startAgent();
  const error = new StoreResponseTooLargeError(64, 65);
  const query = agent.store.query.bind(agent.store);
  const querySpy = vi.spyOn(agent.store, 'query').mockImplementation((sparql, options) => {
    if (kind === 'policy' && options?.source === 'agent.query.privateGraphAccessPolicy') {
      expect(options.maxResponseBytes).toBe(64); throw error;
    }
    return query(sparql, options);
  });
  const inventory = agent.store.readGraphInventory!.bind(agent.store);
  const inventorySpy = vi.spyOn(agent.store, 'readGraphInventory').mockImplementation((prefix, options) => {
    if (kind === 'inventory' && options?.maxResponseBytes === 64) throw error;
    return inventory(prefix, options);
  });
  try {
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', { maxResponseBytes: 64 }))
      .rejects.toMatchObject({ code: 'QUERY_RESULT_TOO_LARGE', maxBytes: 64, actualBytes: 65, cause: error });
    if (kind === 'inventory') expect(inventorySpy).toHaveBeenCalledWith('did:dkg:context-graph:', expect.objectContaining({ maxResponseBytes: 64 }));
  } finally { querySpy.mockRestore(); inventorySpy.mockRestore(); }
});
