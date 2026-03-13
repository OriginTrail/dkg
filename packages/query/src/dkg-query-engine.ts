import type { TripleStore, Quad, QueryResult as StoreQueryResult } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import type { QueryResult, QueryOptions, QueryEngine } from './query-engine.js';
import { paranetDataGraphUri, paranetMetaGraphUri, paranetWorkspaceGraphUri, assertSafeIri, escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import { validateReadOnlySparql } from './sparql-guard.js';

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
    const guard = validateReadOnlySparql(sparql);
    if (!guard.safe) {
      throw new Error(`SPARQL rejected: ${guard.reason}`);
    }

    let effectiveSparql = sparql;

    if (options?.paranetId && !sparql.toLowerCase().includes('from ')) {
      const dataGraph = paranetDataGraphUri(options.paranetId);
      const workspaceGraph = paranetWorkspaceGraphUri(options.paranetId);
      if (options.includeWorkspace) {
        const dataSparql = wrapWithGraph(sparql, dataGraph);
        const workspaceSparql = wrapWithGraph(sparql, workspaceGraph);
        const dataResult = await this.store.query(dataSparql);
        const wsResult = await this.store.query(workspaceSparql);
        return mergeWorkspaceAndDataResults(dataResult, wsResult);
      }
      if (options.graphSuffix === '_workspace') {
        effectiveSparql = wrapWithGraph(sparql, workspaceGraph);
      } else {
        effectiveSparql = wrapWithGraph(sparql, dataGraph);
      }
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
          ?ka <http://dkg.io/ontology/partOf> <${assertSafeIri(ual)}> .
          <${assertSafeIri(ual)}> <http://dkg.io/ontology/paranet> ?paranet .
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
        GRAPH <${assertSafeIri(dataGraph)}> {
          ?s ?p ?o .
          FILTER(
            ?s = <${assertSafeIri(rootEntity)}>
            || STRSTARTS(STR(?s), "${escapeSparqlLiteral(rootEntity)}/.well-known/genid/")
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

function mergeWorkspaceAndDataResults(
  dataResult: StoreQueryResult,
  wsResult: StoreQueryResult,
): QueryResult {
  if (dataResult.type === 'quads' || wsResult.type === 'quads') {
    const mergedQuads = dedupeQuads([
      ...(dataResult.type === 'quads' ? dataResult.quads : []),
      ...(wsResult.type === 'quads' ? wsResult.quads : []),
    ]);
    return { bindings: [], quads: mergedQuads };
  }

  if (dataResult.type === 'boolean' || wsResult.type === 'boolean') {
    const value = (dataResult.type === 'boolean' ? dataResult.value : false)
      || (wsResult.type === 'boolean' ? wsResult.value : false);
    return { bindings: [{ result: String(value) }] };
  }

  const mergedBindings = dedupeBindings([
    ...(dataResult.type === 'bindings' ? dataResult.bindings : []),
    ...(wsResult.type === 'bindings' ? wsResult.bindings : []),
  ]);
  return { bindings: mergedBindings };
}

function dedupeBindings(
  bindings: Array<Record<string, string>>,
): Array<Record<string, string>> {
  const seen = new Set<string>();
  const out: Array<Record<string, string>> = [];
  for (const row of bindings) {
    const key = bindingKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function bindingKey(row: Record<string, string>): string {
  const entries = Object.entries(row).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function dedupeQuads(quads: Quad[]): Quad[] {
  const seen = new Set<string>();
  const out: Quad[] = [];
  for (const q of quads) {
    const key = `${q.subject}\u0000${q.predicate}\u0000${q.object}\u0000${q.graph}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

