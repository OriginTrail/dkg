/**
 * The SPARQL statements the storage adapters build by string interpolation.
 *
 * Each builder returns a plan: the statement, the store operation it runs as,
 * and for an update the graphs it may write. The same operation labels every
 * term the builder renders through the adapters' term policy
 * (`sparql-term-policy.ts`), and the write scope comes from the same pass that
 * builds the statement. An adapter supplies only its identity, then sends the
 * plan under the plan's own operation and scope.
 */
import type { GraphWriteScope } from '../graph-write-gen.js';
import type { Quad } from '../triple-store.js';
import { buildBlankNodeSafeDelete } from './blank-node-safe-delete.js';
import {
  ADAPTER_SPARQL_TERM_POLICY,
  type SparqlTermPolicy,
  type SparqlTermSite,
} from './sparql-term-policy.js';

/** A query, and the store operation it runs as. */
export interface SparqlQueryPlan {
  readonly operation: 'hasGraph' | 'countQuads';
  readonly sparql: string;
}

/** An update, the store operation it runs as, and the graphs it may write. */
export interface SparqlUpdatePlan {
  readonly operation: 'insert' | 'delete' | 'deleteByPattern' | 'deleteBySubjectPrefix' | 'dropGraph';
  readonly update: string;
  readonly scope: GraphWriteScope;
}

export interface SparqlStatements {
  /** `INSERT DATA` for `quads`, grouped by graph; subjects and objects may be blank nodes. */
  insertData(quads: readonly Quad[]): SparqlUpdatePlan;
  /**
   * An update deleting exactly `quads`, blank-node-bearing ones included, or
   * null when there are none (see `blank-node-safe-delete.ts`).
   */
  deleteData(quads: Quad[]): SparqlUpdatePlan | null;
  /**
   * Delete every quad matching `pattern`, where an unset term matches
   * anything. A DELETE template cannot hold a blank node.
   */
  deleteByPattern(pattern: Partial<Quad>): SparqlUpdatePlan;
  /** Delete every quad in `graph` whose subject IRI starts with `prefix`. */
  deleteBySubjectPrefix(graph: string, prefix: string): SparqlUpdatePlan;
  dropGraph(graph: string): SparqlUpdatePlan;
  hasGraph(graph: string): SparqlQueryPlan;
  /** Count the quads in `graph`, or in the default graph and every named graph. */
  countQuads(graph?: string): SparqlQueryPlan;
}

export function sparqlStatements(
  adapter: SparqlTermSite['adapter'],
  terms: SparqlTermPolicy = ADAPTER_SPARQL_TERM_POLICY,
): SparqlStatements {
  const site = (operation: SparqlTermSite['operation']): SparqlTermSite => ({ adapter, operation });
  const graphs = (...graphUris: string[]): GraphWriteScope => ({ kind: 'graphs', graphs: graphUris });

  return {
    insertData(quads) {
      const operation = 'insert';
      const at = site(operation);
      const byGraph = new Map<string, Quad[]>();
      for (const q of quads) {
        const g = q.graph || '';
        if (!byGraph.has(g)) byGraph.set(g, []);
        byGraph.get(g)!.push(q);
      }
      const parts: string[] = [];
      for (const [graph, list] of byGraph) {
        const triples = list.map((q) =>
          `${terms.rdfTerm(q.subject, 'subject', at, 'allow')} ${terms.iriTerm(q.predicate, 'predicate', at)} ${terms.rdfTerm(q.object, 'object', at, 'allow')} .`,
        ).join('\n    ');
        if (graph) {
          parts.push(`GRAPH ${terms.iriTerm(graph, 'graph', at)} {\n    ${triples}\n  }`);
        } else {
          parts.push(triples);
        }
      }
      return {
        operation,
        update: `INSERT DATA {\n  ${parts.join('\n  ')}\n}`,
        scope: graphs(...byGraph.keys()),
      };
    },

    deleteData(quads) {
      const update = buildBlankNodeSafeDelete(quads, adapter, terms);
      if (update === null) return null;
      return {
        operation: 'delete',
        update,
        scope: graphs(...new Set(quads.map((q) => q.graph || ''))),
      };
    },

    deleteByPattern(pattern) {
      const operation = 'deleteByPattern';
      const at = site(operation);
      const s = pattern.subject ? terms.iriTerm(pattern.subject, 'subject', at) : '?s';
      const p = pattern.predicate ? terms.iriTerm(pattern.predicate, 'predicate', at) : '?p';
      const o = pattern.object ? terms.rdfTerm(pattern.object, 'object', at, 'reject') : '?o';
      const triple = `${s} ${p} ${o}`;
      // The template needs the `GRAPH` keyword even for the graph variable:
      // `{ ?g_ctx { … } }` is a syntax error that a spec-compliant endpoint
      // rejects with HTTP 400.
      const graph = pattern.graph ? terms.iriTerm(pattern.graph, 'graph', at) : '?g_ctx';
      return {
        operation,
        update: `DELETE { GRAPH ${graph} { ${triple} } } WHERE { GRAPH ${graph} { ${triple} } }`,
        scope: pattern.graph ? graphs(pattern.graph) : { kind: 'all' },
      };
    },

    deleteBySubjectPrefix(graphUri, prefix) {
      const operation = 'deleteBySubjectPrefix';
      const at = site(operation);
      const graph = terms.iriTerm(graphUri, 'graph', at);
      return {
        operation,
        update: `DELETE { GRAPH ${graph} { ?s ?p ?o } } WHERE { GRAPH ${graph} { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), ${terms.iriPrefix(prefix, at)})) } }`,
        scope: graphs(graphUri),
      };
    },

    dropGraph(graphUri) {
      const operation = 'dropGraph';
      return {
        operation,
        update: `DROP SILENT GRAPH ${terms.iriTerm(graphUri, 'graph', site(operation))}`,
        scope: graphs(graphUri),
      };
    },

    hasGraph(graphUri) {
      const operation = 'hasGraph';
      return {
        operation,
        sparql: `ASK { GRAPH ${terms.iriTerm(graphUri, 'graph', site(operation))} { ?s ?p ?o } }`,
      };
    },

    countQuads(graphUri) {
      const operation = 'countQuads';
      return {
        operation,
        sparql: graphUri
          ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH ${terms.iriTerm(graphUri, 'graph', site(operation))} { ?s ?p ?o } }`
          : 'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
      };
    },
  };
}
