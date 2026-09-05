import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY, contextGraphDataUri, contextGraphMetaUri, contextGraphCatalogUri } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '../src/index.js';

const owner = '0x' + 'ab'.repeat(20);
const stores: OxigraphStore[] = [];
function setup() {
  const store = new OxigraphStore();
  stores.push(store);
  return { store, manager: new GraphManager(store) };
}
function declaration(id: string, graph: string, type = DKG_ONTOLOGY.DKG_CONTEXT_GRAPH): Quad {
  return { subject: contextGraphDataUri(id), predicate: DKG_ONTOLOGY.RDF_TYPE, object: type, graph };
}
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

describe('declared context graph listing (#2025)', () => {
  it('preserves owner/name identity across registries, root metadata and private catalogs', async () => {
    const { store, manager } = setup();
    const ids = [`${owner}/agents-declared`, `${owner}/ontology-declared`, `${owner}/root-declared`, `${owner}/catalog-only`];
    await store.insert([
      declaration(ids[0], contextGraphDataUri('agents')),
      declaration(ids[1], contextGraphDataUri('ontology')),
      declaration(ids[2], contextGraphMetaUri(ids[2])),
      declaration(ids[3], contextGraphCatalogUri(ids[3]), DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH),
      declaration(ids[0], contextGraphMetaUri(ids[0])),
    ]);
    expect(await manager.listContextGraphs()).toEqual([...ids].sort());
    // Enumeration survives creation of a fresh manager; no process-local set
    // or caller-specific owner splitting supplies the missing identities.
    expect(await new GraphManager(store).listContextGraphs()).toEqual([...ids].sort());
  });

  it('does not treat raw data, subgraphs or foreign metadata declarations as context graphs', async () => {
    const { store, manager } = setup();
    const id = `${owner}/declared`;
    await store.insert([
      declaration(id, contextGraphMetaUri(id)),
      declaration(`${id}/tasks`, contextGraphMetaUri(`${id}/tasks`)),
      declaration(`${owner}/foreign`, contextGraphMetaUri(id)),
      { subject: 'urn:test:s', predicate: 'urn:test:p', object: '"data"', graph: contextGraphDataUri(`${owner}/undeclared`) },
      { subject: 'urn:test:s', predicate: 'urn:test:p', object: '"data"', graph: contextGraphDataUri('bare-without-declaration') },
    ]);
    expect(await manager.listContextGraphs()).toEqual([id]);
  });

  it('bounds source batches and forwards cancellation/source options to every read', async () => {
    const { store, manager } = setup();
    const ids = Array.from({ length: 260 }, (_, i) => `${owner}/graph-${i}`);
    await store.insert(ids.map((id) => declaration(id, contextGraphMetaUri(id))));
    const query = vi.spyOn(store, 'query');
    const list = vi.spyOn(store, 'listGraphs');
    const options = { signal: new AbortController().signal, source: 'context-graph-list-test' };
    expect(await manager.listContextGraphs(options)).toEqual([...ids].sort());
    expect(query).toHaveBeenCalledTimes(4); // two registries, then 128/128/4 metadata sources
    for (const [sparql, actualOptions] of query.mock.calls) {
      expect(actualOptions).toBe(options);
      const values = sparql.match(/VALUES \?g \{([^}]+)\}/)?.[1] ?? '';
      expect(values.match(/<[^>]+>/g)!.length).toBeLessThanOrEqual(128);
    }
    expect(list).toHaveBeenCalledWith(options);
  });

  it('propagates store failure rather than returning an apparently complete empty listing', async () => {
    const { store, manager } = setup();
    vi.spyOn(store, 'query').mockRejectedValue(new Error('store unavailable'));
    await expect(manager.listContextGraphs()).rejects.toThrow('store unavailable');
  });
});
