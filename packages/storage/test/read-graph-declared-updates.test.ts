import { describe, expect, it } from 'vitest';
import { ReadGraphWriteRefusedError } from '../src/read-graph/read-graph-store.js';
import { tryUpdateWithTouchedGraphs } from '../src/triple-store.js';
import { expectLayerUnions, layerFixture, layeredStore, P } from './helpers/read-graph-layer-conformance.js';
import { PlanningOxigraphStore } from './helpers/read-graph-planning-store.js';

let sequence = 0;
async function layered() {
  const adapter = new PlanningOxigraphStore();
  const fixture = layerFixture(`declared-update-${sequence += 1}`);
  return { adapter, fixture, ...(await layeredStore(adapter, { backend: 'oxigraph' }, fixture)) };
}

describe('updates that declare the graphs they write, while read graphs exist', () => {
  it('go through the helper when they declare their graphs, and are refused when they do not', async () => {
    const { adapter, fixture, layer, store } = await layered();
    const meta = `${fixture.root}/_meta`;
    const status = `INSERT DATA { GRAPH <${meta}> { <${fixture.root}> <${P}> "registered" } }`;
    await expect(tryUpdateWithTouchedGraphs(store, status, [meta], { writtenGraphs: [meta] })).resolves.toBe(true);
    const written = await adapter.query(`ASK { GRAPH <${meta}> { <${fixture.root}> <${P}> "registered" } }`);
    expect(written).toEqual({ type: 'boolean', value: true });
    // An update that declares nothing is refused before it reaches the store.
    const undeclared = { source: 'test' } as unknown as { readonly writtenGraphs: readonly string[] };
    await expect(tryUpdateWithTouchedGraphs(store, status, [meta], undeclared)).rejects.toBeInstanceOf(ReadGraphWriteRefusedError);
    await expectLayerUnions(adapter, layer, fixture, 'a declared `_meta` update');
  });

  it('keep each read graph equal to its members when an update replaces an asset graph and its record', async () => {
    const { adapter, fixture, layer, store } = await layered();
    const asset = fixture.graphs[1]!;
    const meta = `${fixture.root}/_meta`;
    const ual = 'urn:test:ual';
    // The shape of a graph-scoped update materialization.
    const update = [
      `DROP SILENT GRAPH <${asset}>`,
      `INSERT DATA { GRAPH <${asset}> { <urn:s:new> <${P}> "new" } }`,
      `DELETE WHERE { GRAPH <${meta}> { <${ual}> ?p ?o } }`,
      `INSERT DATA { GRAPH <${meta}> { <${ual}> <${P}> "record" } }`,
    ].join(';\n');
    await store.update!(update, { touchedGraphs: [asset, meta], writtenGraphs: [asset, meta] });
    expect(await adapter.countQuads(asset)).toBe(1);
    await expectLayerUnions(adapter, layer, fixture, 'an asset graph replaced with its record');
  });

  it('keep each read graph equal to its members when a heal copies an asset into a scoped data graph', async () => {
    const { adapter, fixture, layer, store } = await layered();
    const scoped = `${fixture.root}/context/7`;
    // The shape of a heal of a stranded scoped asset: a server-side copy into the graph it names. The
    // source is a registered child's graph, outside every read graph here, so only the maintenance of
    // the declared destination brings its triples into the context graph's VM read graph.
    const source = fixture.graphs[8]!;
    const heal = `INSERT { GRAPH <${scoped}> { ?s ?p ?o } } WHERE { GRAPH <${source}> { ?s ?p ?o } }`;
    const held = async () => (await adapter.query(
      `ASK { GRAPH <${fixture.readGraphs.wholeVm}> { <urn:s:8> <${P}> "v8" } }`)) as { type: string; value?: boolean };
    expect(await held()).toEqual({ type: 'boolean', value: false });
    await expect(tryUpdateWithTouchedGraphs(store, heal, [scoped], { writtenGraphs: [scoped] })).resolves.toBe(true);
    expect(await adapter.countQuads(scoped)).toBe(3);
    expect(await held()).toEqual({ type: 'boolean', value: true });
    await expectLayerUnions(adapter, layer, fixture, 'a heal copy into a scoped data graph');
  });
});
