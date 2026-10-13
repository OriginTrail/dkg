import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { buildAtomicAssetGroupUpdate, type AtomicAssetReplacement } from '../src/atomic-asset-group.js';
import { buildBulkAssetGroupPlan } from '../src/adapters/bulk-asset-group.js';
import { ChangelogStore } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { SparqlHttpStore } from '../src/adapters/sparql-http.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const asset = (id: number, value: string): AtomicAssetReplacement => ({ graphUri: `urn:data:${id}`,
  graphQuads: [{ graph: `urn:data:${id}`, subject: `urn:entity:${id}`, predicate: 'urn:p', object: JSON.stringify(value) }],
  metaGraphUri: 'urn:meta', metadataSubject: `urn:asset:${id}`,
  metadataQuads: [{ graph: 'urn:meta', subject: `urn:asset:${id}`, predicate: 'urn:version', object: '"2"' }] });

const destinations = 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g IN (<urn:data:1>, <urn:data:2>, <urn:meta>)) } ORDER BY ?g ?s ?p ?o';
const unrelated = { graph: 'urn:meta', subject: 'urn:unrelated', predicate: 'urn:p', object: '"retained"' };
const oldMembers = () => [asset(1, 'old-first'), asset(2, 'old-second')].flatMap(a => [
  ...a.graphQuads, ...a.metadataQuads.map(q => ({ ...q, object: '"1"' })),
]);
async function expectedDestinations(members: AtomicAssetReplacement[]) {
  const expected = new OxigraphStore();
  try {
    await expected.insert([...members.flatMap(a => [...a.graphQuads, ...a.metadataQuads]), unrelated]);
    return await expected.query(destinations);
  } finally { await expected.close(); }
}

describe('atomic asset group', () => {
  it('forwards one group through production decorators and records every touched graph', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'group-decorators-'));
    const store = new OxigraphStore(), log = new ChangelogStore(store);
    const index = new GraphSetIndexStore(log);
    const outer = new SharedMemoryLiteralBlobStore(index, { blobDir: dir, thresholdBytes: 65536 });
    try {
      await index.listGraphs();
      await outer.replaceAssetGroup([asset(1, 'first'), asset(2, 'second')]);
      expect(await index.listGraphs()).toEqual(expect.arrayContaining(['urn:data:1', 'urn:data:2', 'urn:meta']));
      const changes = await log.readChanges(0, 20);
      expect(changes.map(c => c.graph)).toEqual(expect.arrayContaining(['urn:data:1', 'urn:data:2', 'urn:meta']));
      expect(log.needsReconcile).toBe(false);
    } finally { await outer.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('refuses a non-atomic SPARQL endpoint before making any HTTP request', async () => {
    const store = new SparqlHttpStore({ queryEndpoint: 'http://127.0.0.1:1/sparql' });
    await expect(store.replaceAssetGroup([asset(1, 'x')])).rejects.toMatchObject({ outcome: 'not_started', capability: 'replaceAssetGroup' });
    await store.close();
  });
  it('publishes distinct assertions and subjects together while retaining unrelated metadata', async () => {
    const store = new OxigraphStore();
    const members = [asset(1, 'new'), asset(2, 'second')];
    await store.insert([...oldMembers(), unrelated]);
    const expected = await expectedDestinations(members);
    await store.replaceAssetGroup(members);
    expect(await store.query(destinations)).toEqual(expected);
    await store.replaceAssetGroup(members);
    expect(await store.query(destinations)).toEqual(expected);
    await store.close();
  });
  it('rejects duplicate, overlapping and invalid members before touching any destination', async () => {
    const store = new OxigraphStore(); await store.insert(asset(1,'old').graphQuads);
    for (const members of [[asset(1,'new'),asset(1,'duplicate')],
      [asset(1,'new'), {...asset(2,'bad'), graphUri:'urn:meta'}],
      [asset(1,'new'), {...asset(2,'bad'), metadataQuads: asset(3,'wrong').metadataQuads}]]) {
      await expect(store.replaceAssetGroup(members)).rejects.toThrow();
      expect(await store.query('ASK { GRAPH <urn:data:1> { ?s ?p "old" } }')).toEqual({type:'boolean', value:true});
    }
    await store.close();
  });
  it('guards native staging inside the publication transaction and exposes no receipt on a missing member', async () => {
    const store = new OxigraphStore(), members = [asset(1,'new'),asset(2,'other')];
    await store.insert([...oldMembers(), unrelated]);
    const before = await store.query(destinations);
    const expected = await expectedDestinations(members);
    const plan = buildBulkAssetGroupPlan(members)!;
    await store.update(plan.update);
    expect(await store.query(plan.receiptQuery)).toEqual({type:'boolean',value:false});
    expect(await store.query(destinations)).toEqual(before);
    // Load the same serialized native payload via INSERT DATA for this embedded fixture.
    const { parseNQuadsTextTolerant: parseNQuads } = await import('../src/nquads-text.js');
    await store.insert(parseNQuads(plan.nquads));
    await store.update(plan.update);
    expect(await store.query(plan.receiptQuery)).toEqual({type:'boolean',value:true});
    expect(await store.query(destinations)).toEqual(expected);
    await store.update(plan.cleanup);
    const replay = buildBulkAssetGroupPlan(members)!;
    await store.insert(parseNQuads(replay.nquads));
    await store.update(replay.update);
    expect(await store.query(replay.receiptQuery)).toEqual({type:'boolean',value:true});
    expect(await store.query(destinations)).toEqual(expected);
    await store.update(replay.cleanup); await store.close();
  });
  it('bounds transaction size and asset count independently from a 100 MB transfer', () => {
    expect(() => buildAtomicAssetGroupUpdate([])).toThrow();
    expect(() => buildAtomicAssetGroupUpdate(Array.from({length:9},(_,i)=>asset(i,'x')))).toThrow();
  });
  it.each([0, 1, 2, 3])('preserves every destination when staging member %s alone is missing', async missing => {
    const store = new OxigraphStore();
    try {
      const members = [asset(1, 'new'), asset(2, 'new')];
      await store.insert([...[asset(1, 'old'), asset(2, 'old')].flatMap(a => [...a.graphQuads, ...a.metadataQuads]),
        { graph: 'urn:meta', subject: 'urn:other', predicate: 'urn:p', object: '"keep"' }]);
      const select = 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g IN (<urn:data:1>, <urn:data:2>, <urn:meta>)) } ORDER BY ?g ?s ?p ?o';
      const before = await store.query(select);
      const plan = buildBulkAssetGroupPlan(members)!;
      const { parseNQuadsTextTolerant: parseNQuads } = await import('../src/nquads-text.js');
      const staged = parseNQuads(plan.nquads);
      const graphs = [...new Set(staged.map(q => q.graph))];
      expect(graphs).toHaveLength(4);
      await store.insert(staged.filter(q => q.graph !== graphs[missing]));
      await store.update(plan.update);
      expect(await store.query(plan.receiptQuery)).toEqual({ type: 'boolean', value: false });
      expect(await store.query(select)).toEqual(before);
    } finally { await store.close(); }
  });
});
