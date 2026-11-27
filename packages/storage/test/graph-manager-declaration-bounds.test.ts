import { afterEach, expect, it, vi } from 'vitest';
import { contextGraphDataUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type QueryOptions } from '../src/index.js';

const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const rootTypes = ['https://dkg.network/ontology#ContextGraph', 'http://dkg.io/ontology/ContextGraph'];
const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

it('addresses only eligible declaration graphs, preserving slash roots and caller admission', async () => {
  const store = new OxigraphStore(); stores.push(store);
  const manager = new GraphManager(store);
  const expected = new Set<string>();
  const quads = [];
  // Cross the existing batch boundary. Every third declaration lives in its
  // root's own metadata; the others use either supported system authority.
  for (let i = 0; i < 270; i++) {
    const id = `owner/root-${i}`; expected.add(id);
    const subject = contextGraphDataUri(id);
    const graph = [contextGraphDataUri('ontology'), contextGraphDataUri('agents'), contextGraphMetaUri(id)][i % 3];
    quads.push({ subject, predicate: type, object: rootTypes[i % 2], graph });
    quads.push({ subject, predicate: 'http://example.org/p', object: '"root"', graph: subject });
  }
  // An otherwise valid declaration in another root's metadata is not authority.
  const spoof = 'owner/spoof';
  quads.push({ subject: contextGraphDataUri(spoof), predicate: type, object: rootTypes[0],
    graph: contextGraphMetaUri('owner/root-0') });
  quads.push({ subject: contextGraphDataUri(spoof), predicate: 'http://example.org/p', object: '"payload"',
    graph: contextGraphDataUri(spoof) });
  await store.insert(quads);
  const query = vi.spyOn(store, 'query');
  const options: QueryOptions = { source: 'agent.swmHostMode.listContextGraphs', priority: 'normal',
    signal: new AbortController().signal, maxResponseBytes: 1024 * 1024 };
  const roots = await manager.listContextGraphs(options);
  expect(new Set(roots.filter(root => root.includes('/')))).toEqual(expected);
  expect(query.mock.calls.length).toBeGreaterThan(1);
  for (const [sparql, passedOptions] of query.mock.calls) {
    expect(passedOptions).toBe(options);
    // A late STR filter leaves the graph dimension unbound in Blazegraph's
    // access path. Demand concrete (root, authority graph) pairs before lookup.
    const pairs = [...sparql.matchAll(/\(<([^>]+)>\s+<([^>]+)>\)/g)];
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBeLessThanOrEqual(256);
    for (const [, root, graph] of pairs) {
      expect(graph).toBe(`${root}/_meta`);
    }
    expect(sparql).not.toContain('FILTER(STR(?metaGraph)');
  }
});
