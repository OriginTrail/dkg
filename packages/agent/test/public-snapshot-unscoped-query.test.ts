import { StoreResponseTooLargeError } from '@origintrail-official/dkg-storage';
import { QueryMaterializationBudget } from '@origintrail-official/dkg-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import { markCoreTrustedGraph } from '../src/public-snapshot-evidence.js';

const agents: DKGAgent[] = [];
afterEach(async () => {
  while (agents.length) await agents.pop()!.stop();
});

async function startAgent() {
  const agent = await DKGAgent.create({ name: 'UnscopedQueryTrust', nodeRole: 'edge',
    listenHost: '127.0.0.1', listenPort: 0, chainAdapter: new MockChainAdapter(),
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

it.each([false, true])('shares admission and execution bytes in a real unscoped request (withheld=%s)', async withheld => {
  const agent = await startAgent();
  await agent.store.insert([{ subject: 'urn:budget', predicate: 'urn:budget-value',
    object: JSON.stringify('retained-value'.repeat(80)), graph: 'did:dkg:context-graph:local-budget' }]);
  if (withheld) {
    await agent.store.insert([{ subject: 'urn:hidden', predicate: 'urn:budget-value',
      object: '"hidden"', graph: 'did:dkg:context-graph:hidden-budget' }]);
    await markCoreTrustedGraph(agent.store, 'hidden-budget');
  }
  const query = 'SELECT ?value WHERE { GRAPH ?g { ?s <urn:budget-value> ?value } }';
  const observed: number[] = [];
  const consume = QueryMaterializationBudget.prototype.consumeBytes;
  const spy = vi.spyOn(QueryMaterializationBudget.prototype, 'consumeBytes').mockImplementation(function(value) {
    observed.push(value); return consume.call(this, value);
  });
  try {
    const expected = await agent.query(query, { maxResponseBytes: 1_000_000 });
    expect(expected.bindings).toHaveLength(1);
    // Real admission charges its ontology and graph inventory; the engine
    // charges the retained content result against that very same budget.
    expect(observed).toHaveLength(3);
    const sizes = observed;
    const admissionBytes = sizes[0] + sizes[1];
    const executionBytes = sizes[2];
    const total = admissionBytes + executionBytes;
    const ceiling = total - 1;
    expect(admissionBytes).toBeLessThan(ceiling);
    expect(executionBytes).toBeLessThan(ceiling);
    observed.length = 0;
    await expect(agent.query(query, { maxResponseBytes: ceiling })).rejects.toMatchObject({
      code: 'QUERY_RESULT_TOO_LARGE', maxBytes: ceiling, actualBytes: total,
    });
    expect(observed).toHaveLength(3);
    await expect(agent.query(query, { maxResponseBytes: total })).resolves.toEqual(expected);
  } finally { spy.mockRestore(); }
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
  const inventory = agent.store.listGraphsByPrefix!.bind(agent.store);
  const inventorySpy = vi.spyOn(agent.store, 'listGraphsByPrefix').mockImplementation((prefix, options) => {
    if (kind === 'inventory' && options?.maxResponseBytes === 64) throw error;
    return inventory(prefix, options);
  });
  try {
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', { maxResponseBytes: 64 }))
      .rejects.toMatchObject({ code: 'QUERY_RESULT_TOO_LARGE', maxBytes: 64, actualBytes: 65, cause: error });
  } finally { querySpy.mockRestore(); inventorySpy.mockRestore(); }
});
