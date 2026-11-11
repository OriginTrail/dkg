import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { READ_GRAPH_REGISTRY_PREDICATES as P, parseReadGraphRegistryRows, readReadGraphRegistry } from '../src/read-graph/registry.js';
import type { Quad } from '../src/triple-store.js';

const ROOT = 'did:dkg:context-graph:registry-test';
const META = `${ROOT}/_meta`;
const fact = (subject: string, predicate: string, object: string, graph = META): Quad => ({ subject, predicate, object, graph });

describe('read-graph registry', () => {
  it('reads the sub-graphs and children the view route reads, and nothing else', async () => {
    const store = new OxigraphStore();
    await store.insert([
      fact('urn:sg:1', P.type, P.subGraphClass), fact('urn:sg:1', P.name, '"code"'),
      // A name without the type does not register a sub-graph, and an invalid name is ignored.
      fact('urn:sg:2', P.name, '"untyped"'),
      fact('urn:sg:3', P.type, P.subGraphClass), fact('urn:sg:3', P.name, '"_hidden"'),
      fact('urn:asset:1', P.authenticatedSubGraphName, '"docs"^^<http://www.w3.org/2001/XMLSchema#string>'),
      fact('urn:asset:2', P.authenticatedSubGraphName, '"notes"@en'),
      // Names in another context graph's `_meta` do not count.
      fact('urn:sg:4', P.type, P.subGraphClass, `${ROOT}/kid/_meta`), fact('urn:sg:4', P.name, '"elsewhere"', `${ROOT}/kid/_meta`),
      // A child is registered in its own `_meta`, under the parent's root.
      fact(`${ROOT}/kid`, P.type, P.contextGraphClass, `${ROOT}/kid/_meta`),
      fact(`${ROOT}/kid2`, P.registrationStatus, '"registered"', `${ROOT}/kid2/_meta`),
      fact(`${ROOT}/kid3`, P.type, P.contextGraphClass),
      fact(`${ROOT}x`, P.type, P.contextGraphClass, `${ROOT}x/_meta`),
    ]);
    expect(await readReadGraphRegistry(store, 'registry-test')).toEqual({
      contextGraphId: 'registry-test',
      subGraphNames: ['code', 'docs', 'notes'],
      childContextGraphRoots: [`${ROOT}/kid`, `${ROOT}/kid2`],
    });
    expect(await readReadGraphRegistry(store, 'registry-test-empty')).toEqual({
      contextGraphId: 'registry-test-empty', subGraphNames: [], childContextGraphRoots: [],
    });
  });

  it('decodes names in either result form', () => {
    expect(parseReadGraphRegistryRows('c', [{ name: 'code' }, { name: '"docs"' }, { name: '"a b"' }, { child: 'did:dkg:context-graph:c/k' }, {}]))
      .toEqual({ contextGraphId: 'c', subGraphNames: ['code', 'docs'], childContextGraphRoots: ['did:dkg:context-graph:c/k'] });
  });
});
