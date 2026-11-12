import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTERNAL_LITERAL_REF_DATATYPE, SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';
import type { Quad } from '../src/triple-store.js';
import { AGENT, expectLayerUnions, layerFixture, layeredStore, P, q } from './helpers/read-graph-layer-conformance.js';
import { PlanningOxigraphStore } from './helpers/read-graph-planning-store.js';

// Shared working memory's own write paths, replayed in their order against a store with ready read
// graphs: large literals, the expiry sweep, catch-up and snapshot materialization. After each, every
// read graph holds exactly the union of its members.
const PUBLISHED_AT = 'http://dkg.io/ontology/publishedAt';

let sequence = 0;
async function sharedMemoryFixture() {
  const adapter = new PlanningOxigraphStore();
  const fixture = layerFixture(`swm-paths-${sequence += 1}`);
  const { layer, store } = await layeredStore(adapter, { backend: 'oxigraph' }, fixture);
  const root = fixture.root;
  return {
    adapter, fixture, layer, store,
    swm: `${root}/_shared_memory`,
    assertion: `${root}/_shared_memory/${AGENT}/4`,
    meta: `${root}/_shared_memory_meta`,
  };
}

async function objects(adapter: PlanningOxigraphStore, graph: string, subject: string): Promise<string[]> {
  const result = await adapter.query(`SELECT ?o WHERE { GRAPH <${graph}> { <${subject}> <${P}> ?o } }`);
  return result.type === 'bindings' ? result.bindings.map((row) => row.o!) : [];
}

const blobDirs: string[] = [];
afterEach(async () => {
  await Promise.all(blobDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('shared working memory read graphs', () => {
  it('hold a large literal in the form the store keeps, and reads through the store stack restore it', async () => {
    const { adapter, fixture, layer, store, assertion } = await sharedMemoryFixture();
    const blobDir = await mkdtemp(join(tmpdir(), 'read-graph-blobs-'));
    blobDirs.push(blobDir);
    // The large-literal store sits above the read-graph layer, as createTripleStore composes them.
    const top = new SharedMemoryLiteralBlobStore(store, { blobDir, thresholdBytes: 64 });
    const large = `"${'x'.repeat(200)}"`;
    await top.insert([q('urn:s:large', large, assertion)]);

    const [stored] = await objects(adapter, assertion, 'urn:s:large');
    expect(stored).toContain(EXTERNAL_LITERAL_REF_DATATYPE);
    expect(await objects(adapter, fixture.readGraphs.wholeSwm, 'urn:s:large')).toEqual([stored]);
    await expectLayerUnions(adapter, layer, fixture, 'inserting a large literal');
    for (const graph of [assertion, fixture.readGraphs.wholeSwm]) {
      const read = await top.query(`SELECT ?o WHERE { GRAPH <${graph}> { <urn:s:large> <${P}> ?o } }`);
      expect(read.type === 'bindings' && read.bindings, graph).toEqual([{ o: large }]);
    }
    // A pattern that names the literal matches its stored form in the read graph as well.
    const named = await top.query(`SELECT ?s WHERE { GRAPH <${fixture.readGraphs.wholeSwm}> { ?s <${P}> ${large} } }`);
    expect(named.type === 'bindings' && named.bindings).toEqual([{ s: 'urn:s:large' }]);

    // A delete written with the literal retracts its stored form from both.
    await top.delete([q('urn:s:large', large, assertion)]);
    expect(await objects(adapter, assertion, 'urn:s:large')).toEqual([]);
    expect(await objects(adapter, fixture.readGraphs.wholeSwm, 'urn:s:large')).toEqual([]);
    await expectLayerUnions(adapter, layer, fixture, 'deleting a large literal');
  });

  it('stay equal to their members through the expiry sweep', async () => {
    const { adapter, fixture, layer, store, swm, assertion, meta } = await sharedMemoryFixture();
    const expired = 'urn:s:expired';
    const operation = 'urn:op:expired';
    await store.insert([
      q(expired, '"payload"', swm),
      q(`${expired}/.well-known/genid/1`, '"child"', swm),
      q(`${expired}/.well-known/genid/2`, '"child"', swm),
      // The same triple in another member: the read graph keeps it.
      q(expired, '"payload"', assertion),
      { subject: operation, predicate: PUBLISHED_AT, object: '"2026-11-11T00:00:00Z"', graph: meta },
    ]);
    await expectLayerUnions(adapter, layer, fixture, 'the expiring rows');

    // The sweep's writes for one expired operation, in its order.
    await store.deleteByPattern({ graph: swm, subject: expired });
    await store.deleteBySubjectPrefix(swm, `${expired}/.well-known/genid/`);
    await expectLayerUnions(adapter, layer, fixture, 'deleting an expired root entity and its children');
    expect(await objects(adapter, fixture.readGraphs.wholeSwm, expired)).toEqual(['"payload"']);
    await store.deleteByPattern({ graph: assertion });
    await store.dropGraph(assertion);
    await store.deleteByPattern({ graph: meta, subject: operation });
    await expectLayerUnions(adapter, layer, fixture, 'tearing down the expired assertion graph');
    expect(await objects(adapter, fixture.readGraphs.wholeSwm, expired)).toEqual([]);
  });

  it('stay equal to their members through catch-up and snapshot materialization', async () => {
    const { adapter, fixture, layer, store, swm, assertion, meta } = await sharedMemoryFixture();
    const operation = 'urn:op:caught-up';
    // Catch-up: an operation's data rows and its publishedAt rows, then the later stamp retired.
    await store.insert([
      q('urn:s:caught-up', '"row"', swm),
      { subject: operation, predicate: PUBLISHED_AT, object: '"2026-11-11T00:00:00Z"', graph: meta },
      { subject: operation, predicate: PUBLISHED_AT, object: '"2026-11-11T00:00:05Z"', graph: meta },
    ]);
    await store.update!(`DELETE DATA { GRAPH <${meta}> { <${operation}> <${PUBLISHED_AT}> "2026-11-11T00:00:05Z" } }`,
      { writtenGraphs: [meta] });
    await expectLayerUnions(adapter, layer, fixture, 'catch-up rows');

    // A snapshot replaces an assertion graph whole; one of its triples is also in another member.
    const snapshot: Quad[] = [q('urn:s:shared', '"both"', assertion), q('urn:s:snapshot', '"new"', assertion)];
    await store.replaceGraph!(assertion, snapshot);
    await expectLayerUnions(adapter, layer, fixture, 'a snapshot replacing an assertion graph');
    expect(await objects(adapter, fixture.readGraphs.wholeSwm, 'urn:s:snapshot')).toEqual(['"new"']);
    await store.replaceGraph!(assertion, []);
    await expectLayerUnions(adapter, layer, fixture, 'an empty snapshot');
    expect(await objects(adapter, fixture.readGraphs.wholeSwm, 'urn:s:shared')).toEqual(['"both"']);
  });
});
