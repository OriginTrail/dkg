/**
 * The SPARQL statements the storage adapters build by string interpolation.
 *
 * Each builder owns its operation's metric label, the position of every term,
 * and whether that position may hold a blank node, and it renders every term
 * through the adapters' term policy (`sparql-term-policy.ts`). An adapter
 * supplies only its identity and sends the statement.
 */
import type { Quad } from '../triple-store.js';
import type { StoreOperation } from '../store-operation-outcome.js';
import { buildBlankNodeSafeDelete } from './blank-node-safe-delete.js';
import {
  ADAPTER_SPARQL_TERM_POLICY,
  type SparqlTermPolicy,
  type SparqlTermSite,
} from './sparql-term-policy.js';

export interface SparqlStatements {
  /** `INSERT DATA` for `quads`, grouped by graph; subjects and objects may be blank nodes. */
  insertData(quads: readonly Quad[]): string;
  /**
   * An update deleting exactly `quads`, blank-node-bearing ones included, or
   * null when there are none (see `blank-node-safe-delete.ts`).
   */
  deleteData(quads: Quad[]): string | null;
  /**
   * Delete every quad matching `pattern`, where an unset term matches
   * anything. A DELETE template cannot hold a blank node.
   */
  deleteByPattern(pattern: Partial<Quad>): string;
  /** Delete every quad in `graph` whose subject IRI starts with `prefix`. */
  deleteBySubjectPrefix(graph: string, prefix: string): string;
  dropGraph(graph: string): string;
  hasGraph(graph: string): string;
  /** Count the quads in `graph`, or in the default graph and every named graph. */
  countQuads(graph?: string): string;
}

export function sparqlStatements(
  adapter: SparqlTermSite['adapter'],
  terms: SparqlTermPolicy = ADAPTER_SPARQL_TERM_POLICY,
): SparqlStatements {
  const site = (operation: StoreOperation): SparqlTermSite => ({ adapter, operation });

  return {
    insertData(quads) {
      const at = site('insert');
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
      return `INSERT DATA {\n  ${parts.join('\n  ')}\n}`;
    },

    deleteData(quads) {
      return buildBlankNodeSafeDelete(quads, adapter, terms);
    },

    deleteByPattern(pattern) {
      const at = site('deleteByPattern');
      const s = pattern.subject ? terms.iriTerm(pattern.subject, 'subject', at) : '?s';
      const p = pattern.predicate ? terms.iriTerm(pattern.predicate, 'predicate', at) : '?p';
      const o = pattern.object ? terms.rdfTerm(pattern.object, 'object', at, 'reject') : '?o';
      const triple = `${s} ${p} ${o}`;
      // The template needs the `GRAPH` keyword even for the graph variable:
      // `{ ?g_ctx { … } }` is a syntax error that a spec-compliant endpoint
      // rejects with HTTP 400.
      const graph = pattern.graph ? terms.iriTerm(pattern.graph, 'graph', at) : '?g_ctx';
      return `DELETE { GRAPH ${graph} { ${triple} } } WHERE { GRAPH ${graph} { ${triple} } }`;
    },

    deleteBySubjectPrefix(graphUri, prefix) {
      const at = site('deleteBySubjectPrefix');
      const graph = terms.iriTerm(graphUri, 'graph', at);
      return `DELETE { GRAPH ${graph} { ?s ?p ?o } } WHERE { GRAPH ${graph} { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), ${terms.iriPrefix(prefix, at)})) } }`;
    },

    dropGraph(graphUri) {
      return `DROP SILENT GRAPH ${terms.iriTerm(graphUri, 'graph', site('dropGraph'))}`;
    },

    hasGraph(graphUri) {
      return `ASK { GRAPH ${terms.iriTerm(graphUri, 'graph', site('hasGraph'))} { ?s ?p ?o } }`;
    },

    countQuads(graphUri) {
      return graphUri
        ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH ${terms.iriTerm(graphUri, 'graph', site('countQuads'))} { ?s ?p ?o } }`
        : 'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }';
    },
  };
}
