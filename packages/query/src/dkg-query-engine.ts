import type { TripleStore, Quad, QueryResult as StoreQueryResult } from '@dkg/storage';
import { GraphManager } from '@dkg/storage';
import type { QueryResult, QueryOptions, QueryEngine } from './query-engine.js';
import { paranetDataGraphUri, paranetMetaGraphUri } from '@dkg/core';

/**
 * Local-only query engine that executes SPARQL against this node's own
 * triple store. No remote query capability — by design (Spec §1.6 Store
 * Isolation). All data must arrive via protocol messages (publish, access,
 * sync) before it can be queried here.
 */
export class DKGQueryEngine implements QueryEngine {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;

  constructor(store: TripleStore) {
    this.store = store;
    this.graphManager = new GraphManager(store);
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    let effectiveSparql = sparql;

    // If paranetId is provided and the query doesn't contain FROM clauses,
    // wrap it to scope to the paranet's data graph
    if (options?.paranetId && !sparql.toLowerCase().includes('from ')) {
      const dataGraph = paranetDataGraphUri(options.paranetId);
      effectiveSparql = wrapWithGraph(sparql, dataGraph);
    }

    const result = await this.store.query(effectiveSparql);

    if (result.type === 'bindings') {
      return { bindings: result.bindings };
    }
    if (result.type === 'quads') {
      return {
        bindings: [],
        quads: result.quads,
      };
    }
    if (result.type === 'boolean') {
      return {
        bindings: [{ result: String(result.value) }],
      };
    }
    return { bindings: [] };
  }

  async resolveKA(ual: string): Promise<{
    rootEntity: string;
    paranetId: string;
    quads: Quad[];
  }> {
    // Look up KA metadata across all meta graphs
    const metaResult = await this.store.query(
      `SELECT ?rootEntity ?paranet WHERE {
        GRAPH ?g {
          ?ka <http://dkg.io/ontology/rootEntity> ?rootEntity .
          ?ka <http://dkg.io/ontology/partOf> <${ual}> .
          <${ual}> <http://dkg.io/ontology/paranet> ?paranet .
        }
      }`,
    );

    if (metaResult.type !== 'bindings' || metaResult.bindings.length === 0) {
      throw new Error(`KA not found for UAL: ${ual}`);
    }

    const rootEntity = metaResult.bindings[0]['rootEntity'];
    const paranetUri = metaResult.bindings[0]['paranet'];
    const paranetId = paranetUri.replace('did:dkg:paranet:', '');
    const dataGraph = paranetDataGraphUri(paranetId);

    // Fetch all triples for this entity
    const dataResult = await this.store.query(
      `SELECT ?s ?p ?o WHERE {
        GRAPH <${dataGraph}> {
          ?s ?p ?o .
          FILTER(
            ?s = <${rootEntity}>
            || STRSTARTS(STR(?s), "${rootEntity}/.well-known/genid/")
          )
        }
      }`,
    );

    const quads: Quad[] =
      dataResult.type === 'bindings'
        ? dataResult.bindings.map((row) => ({
            subject: row['s'],
            predicate: row['p'],
            object: row['o'],
            graph: dataGraph,
          }))
        : [];

    return { rootEntity, paranetId, quads };
  }

  /**
   * Execute a query across all locally-stored paranets.
   */
  async queryAllParanets(sparql: string): Promise<QueryResult> {
    const paranets = await this.graphManager.listParanets();
    const allBindings: Array<Record<string, string>> = [];

    for (const paranetId of paranets) {
      const result = await this.query(sparql, { paranetId });
      allBindings.push(...result.bindings);
    }

    return { bindings: allBindings };
  }
}

/**
 * Wraps a SELECT query to scope it to a named graph.
 * If the query already uses GRAPH patterns, returns it unchanged.
 */
function wrapWithGraph(sparql: string, graphUri: string): string {
  if (sparql.toLowerCase().includes('graph ')) return sparql;

  const whereIdx = sparql.search(/WHERE\s*\{/i);
  if (whereIdx === -1) return sparql;

  const braceStart = sparql.indexOf('{', whereIdx);
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < sparql.length; i++) {
    if (sparql[i] === '{') depth++;
    else if (sparql[i] === '}') {
      depth--;
      if (depth === 0) { braceEnd = i; break; }
    }
  }
  if (braceEnd === -1) return sparql;

  const before = sparql.slice(0, braceStart + 1);
  const inner = sparql.slice(braceStart + 1, braceEnd);
  const after = sparql.slice(braceEnd);

  return `${before} GRAPH <${graphUri}> { ${inner} } ${after}`;
}
