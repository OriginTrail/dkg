import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  readDurableDataPage,
  readDurableMetaPage,
} from '../src/sync/responder/graph-plan.js';

const DKG = 'http://dkg.io/ontology/';
const CG_ID = 'exact-asset-responder';
const AUTHOR = '0x00000000000000000000000000000000000000ab';
const integer = (value: number) =>
  `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;

function asset(index: number): { ual: string; graph: string; quads: Quad[] } {
  const ual = `did:dkg:base:84532/${AUTHOR}/${index}`;
  const graph = knowledgeAssetLayerGraphUri(
    CG_ID,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(ual, 1),
  );
  const meta = contextGraphMetaGraphUri(CG_ID);
  return {
    ual,
    graph,
    quads: [
      { graph: meta, subject: ual, predicate: `${DKG}contentScopeVersion`, object: integer(GRAPH_KA_CONTENT_SCOPE_VERSION) },
      { graph: meta, subject: ual, predicate: `${DKG}kaUal`, object: ual },
      { graph: meta, subject: ual, predicate: `${DKG}assertionVersion`, object: integer(1) },
      { graph: meta, subject: ual, predicate: `${DKG}assertionGraph`, object: graph },
      { graph: meta, subject: ual, predicate: `${DKG}contextGraph`, object: contextGraphDataGraphUri(CG_ID) },
      { graph: meta, subject: ual, predicate: `${DKG}publicTripleCount`, object: integer(1) },
      { graph: meta, subject: ual, predicate: `${DKG}privateTripleCount`, object: integer(0) },
      { graph: meta, subject: ual, predicate: `${DKG}status`, object: '"confirmed"' },
      { graph, subject: `urn:entity:${index}`, predicate: 'http://schema.org/name', object: `"asset-${index}"` },
    ],
  };
}

describe('exact asset responder', () => {
  it('serves only the requested confirmed descriptor and immutable data graph', async () => {
    const store = new OxigraphStore();
    const requested = asset(1);
    const alreadyPresent = asset(2);
    await store.insert([...requested.quads, ...alreadyPresent.quads]);
    const originalQuery = store.query.bind(store);
    const manifestQueries: string[] = [];
    store.query = (async (
      sparql: string,
      options?: Parameters<OxigraphStore['query']>[1],
    ) => {
      if (
        sparql.includes('<http://dkg.io/ontology/contentScopeVersion>') &&
        sparql.includes(`GRAPH <${contextGraphMetaGraphUri(CG_ID)}>`)
      ) {
        manifestQueries.push(sparql);
      }
      return originalQuery(sparql, options);
    }) as typeof store.query;

    const meta = await readDurableMetaPage({
      store,
      contextGraphId: CG_ID,
      registeredSubGraphNames: [],
      offset: 0,
      limit: 100,
      assetUals: [requested.ual],
    });
    const data = await readDurableDataPage({
      store,
      graphList: [requested.graph, alreadyPresent.graph],
      contextGraphId: CG_ID,
      sinceBatchId: null,
      offset: 0,
      limit: 100,
      assetUals: [requested.ual],
    });

    expect(new Set(meta.map((row) => row.s))).toEqual(new Set([requested.ual]));
    expect(meta).toHaveLength(8);
    expect(data).toEqual([{
      g: requested.graph,
      s: 'urn:entity:1',
      p: 'http://schema.org/name',
      o: '"asset-1"',
    }]);
    expect(manifestQueries).not.toHaveLength(0);
    for (const query of manifestQueries) {
      expect(query).toContain(`VALUES ?ual { <${requested.ual}> }`);
      expect(query).toMatch(new RegExp(
        `GRAPH <${contextGraphMetaGraphUri(CG_ID)}> \\{\\s*VALUES \\?ual`,
      ));
      expect(query).not.toContain(`<${alreadyPresent.ual}>`);
    }
  });
});
