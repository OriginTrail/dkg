import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listGraphsByPrefixCandidate } from '../../scripts/blazegraph-prefix-candidate.mjs';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../../src/blazegraph-namespace-manager.js';
import { ATOMIC_GRAPH_REPLACE_STAGING_PREFIX } from '../../src/atomic-graph-replace.js';
import { startOxigraphSparqlEndpoint, type OxigraphSparqlEndpoint } from './oxigraph-sparql-endpoint.js';

export function graphPrefixConformance(backend: 'oxigraph-http' | 'blazegraph') {
  describe(`prefix enumeration (${backend})`, () => {
    let store: BlazegraphStore, external: BlazegraphStore;
    let endpoint: OxigraphSparqlEndpoint | undefined;
    let manager: BlazegraphNamespaceManager | undefined;
    let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> | undefined;
    const graphs = ['urn:scope:a', 'urn:scope:ab', 'urn:scope:a/assertions/1',
      'urn:scope:a/assertions/12', 'urn:scope:a-child', 'urn:scope:%22', 'urn:scope:é',
      'urn:scope:😀', 'urn:unrelated', `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}hidden`];
    beforeAll(async () => {
      let url: string;
      if (backend === 'blazegraph') {
        if (!process.env.BLAZEGRAPH_TEST_URL) throw new Error('The live Blazegraph lane requires BLAZEGRAPH_TEST_URL');
        manager = new BlazegraphNamespaceManager({ namespaceApiUrl:
          blazegraphNamespaceApiUrlFromSparqlEndpoint(process.env.BLAZEGRAPH_TEST_URL!),
        });
        handles = await manager.acquireMany([`prefix-${randomUUID()}`]);
        url = handles[0]!.sparqlUrl;
      } else {
        endpoint = await startOxigraphSparqlEndpoint(); url = endpoint.queryEndpoint;
      }
      store = new BlazegraphStore(url); external = new BlazegraphStore(url);
      // Raw SPARQL keeps astral IRIs portable: the Blazegraph bulk serializer's
      // Java surrogate escapes are not valid N-Quads for the Oxigraph oracle.
      await store.update(`INSERT DATA { ${graphs.map(graph =>
        `GRAPH <${graph}> { <urn:s:1> <urn:p> "value" . <urn:s:2> <urn:p> "value" . }`,
      ).join('\n')} }`);
    });
    afterAll(async () => {
      await store?.close(); await external?.close();
      await endpoint?.close();
      if (handles) await manager!.disposeAll(handles);
    });

    it('matches fresh full enumeration for empty, textual, escaped and assertion-child prefixes', async () => {
      for (const prefix of ['', 'urn:scope:a', 'urn:scope:a/', 'urn:scope:a/assertions/1',
        'urn:scope:%', 'urn:scope:é', 'urn:scope:😀', 'urn:scope:\uD83D', 'urn:scope:\uDE00',
        'urn:scope:"', 'urn:scope:\\', '\n\t\r',
        '") } UNION { GRAPH ?g { ?s ?p ?o } } #', ATOMIC_GRAPH_REPLACE_STAGING_PREFIX]) {
        const expected = (await store.listGraphs()).filter(g => g.startsWith(prefix)).sort();
        expect((await listGraphsByPrefixCandidate(store, prefix)).sort(), prefix).toEqual(expected);
      }
    });

    it('sees writes and removals from another client without sharing a cache', async () => {
      expect(await listGraphsByPrefixCandidate(store, 'urn:external:')).toEqual([]);
      await external.insert([{ graph: 'urn:external:new', subject: 'urn:s', predicate: 'urn:p', object: '"v"' }]);
      expect(await listGraphsByPrefixCandidate(store, 'urn:external:')).toEqual(['urn:external:new']);
      await external.dropGraph('urn:external:new');
      expect(await listGraphsByPrefixCandidate(store, 'urn:external:')).toEqual([]);
    });
  });
}
