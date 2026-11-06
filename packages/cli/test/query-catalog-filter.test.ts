// The catalog filter of the query-catalog read, run on a real store: which
// saved queries a filter by catalog slug selects, for a slug as a writer
// passes it and as a read returns it.
import { afterEach, describe, expect, it } from 'vitest';
import { buildQueryCatalogWrite } from '@origintrail-official/dkg-core/query-catalog';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

import {
  buildContextGraphQueryCatalogSelect,
  queryCatalogFilterIris,
} from '../src/daemon/query-catalog-service.js';

const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/catalog-filter';
const GRAPH = 'urn:test:query-catalog';

const stores: OxigraphStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function savedQuery(catalogSlug: string, name: string) {
  return buildQueryCatalogWrite({
    contextGraphId: CONTEXT_GRAPH_ID,
    name,
    sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
    subGraph: 'meta',
    catalogSlug,
    catalogName: `Catalog ${catalogSlug}`,
    rank: 1,
    catalogRank: 1,
  });
}

async function storeHolding(...writes: Array<ReturnType<typeof savedQuery>>) {
  const store = new OxigraphStore();
  stores.push(store);
  await store.insert(writes.flatMap((write) => write.quads.map((quad) => ({ ...quad, graph: GRAPH }))));
  return store;
}

async function selectedQueries(store: OxigraphStore, catalogIris?: readonly string[]): Promise<string[]> {
  const result = await store.query(buildContextGraphQueryCatalogSelect(`<${GRAPH}>`, catalogIris));
  if (result.type !== 'bindings') throw new Error('expected bindings');
  return [...new Set(result.bindings.map((row) => String(row['q'])))].sort();
}

describe('the catalog filter of the query-catalog read', () => {
  it('selects only the saved queries of the named catalog', async () => {
    const alpha = savedQuery('alpha', 'First');
    const beta = savedQuery('beta', 'Second');
    const store = await storeHolding(alpha, beta);

    expect(await selectedQueries(store)).toEqual([alpha.savedQuery.queryUri, beta.savedQuery.queryUri].sort());
    expect(await selectedQueries(store, queryCatalogFilterIris(CONTEXT_GRAPH_ID, 'alpha')))
      .toEqual([alpha.savedQuery.queryUri]);
    expect(await selectedQueries(store, queryCatalogFilterIris(CONTEXT_GRAPH_ID, 'gamma'))).toEqual([]);
  });

  // A slug written as it is is stored percent-encoded in the catalog IRI, and a
  // read returns it in that stored form.
  it('selects a catalog whose slug needed encoding, by the written and by the returned slug', async () => {
    const spaced = savedQuery('my catalog', 'Spaced');
    const other = savedQuery('other', 'Other');
    const store = await storeHolding(spaced, other);

    expect(spaced.savedQuery.catalogUri.endsWith(':catalog:my%20catalog')).toBe(true);
    expect(await selectedQueries(store, queryCatalogFilterIris(CONTEXT_GRAPH_ID, 'my catalog')))
      .toEqual([spaced.savedQuery.queryUri]);
    expect(await selectedQueries(store, queryCatalogFilterIris(CONTEXT_GRAPH_ID, 'my%20catalog')))
      .toEqual([spaced.savedQuery.queryUri]);
  });

  it('keeps a slug that is not a valid IRI segment inside one encoded IRI', async () => {
    const store = await storeHolding(savedQuery('alpha', 'First'));

    for (const slug of ['current"> } ?x ?y ?z { #', '50%', 'a b<c>']) {
      const iris = queryCatalogFilterIris(CONTEXT_GRAPH_ID, slug);
      expect(iris).toHaveLength(1);
      expect(iris[0]).not.toMatch(/[\s<>"{}|^`\\]/u);
      expect(await selectedQueries(store, iris)).toEqual([]);
    }
  });
});
