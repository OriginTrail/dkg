/**
 * The SPARQL statements the storage adapters build by string interpolation.
 *
 * Each builder returns a plan: the statement, the store operation it runs as,
 * for an update the graphs it may write, and the terms that failed validation
 * while it was rendered. Building a plan has no side effects. The adapter
 * reports the plan's invalid terms when it runs the operation, through
 * {@link reportedPlan}, and then sends the plan under its own operation and
 * scope. The same operation labels every term the builder renders, and the
 * write scope comes from the same pass that builds the statement.
 */
import type { GraphWriteScope } from '../graph-write-gen.js';
import type { Quad } from '../triple-store.js';
import { renderBlankNodeSafeDelete } from './blank-node-safe-delete.js';
import { reportInvalidSparqlTerms } from './sparql-term-observer.js';
import {
  ADAPTER_SPARQL_TERM_POLICY,
  SparqlTermRejectedError,
  type InvalidSparqlTerm,
  type SparqlTermPolicy,
  type SparqlTermSite,
} from './sparql-term-policy.js';

/** A query, the store operation it runs as, and its invalid terms. */
export interface SparqlQueryPlan {
  readonly operation: 'hasGraph' | 'countQuads';
  readonly sparql: string;
  readonly invalidTerms: readonly InvalidSparqlTerm[];
}

/** An update, the store operation it runs as, the graphs it may write, and its invalid terms. */
export interface SparqlUpdatePlan {
  readonly operation: 'insert' | 'delete' | 'deleteByPattern' | 'deleteBySubjectPrefix' | 'dropGraph';
  readonly update: string;
  readonly scope: GraphWriteScope;
  readonly invalidTerms: readonly InvalidSparqlTerm[];
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

/**
 * Build a plan and report its invalid terms: the adapter-operation boundary.
 * Adapters call this when they run an operation, before admission or
 * dispatch, so each invalid term is reported exactly once, whether or not the
 * statement is then sent. A term rejected in reject mode is reported the same
 * way before the error propagates.
 */
export function reportedPlan<P extends { readonly invalidTerms: readonly InvalidSparqlTerm[] } | null>(
  build: () => P,
): P {
  let plan: P;
  try {
    plan = build();
  } catch (error) {
    if (error instanceof SparqlTermRejectedError) reportInvalidSparqlTerms([error.invalidTerm]);
    throw error;
  }
  if (plan !== null) reportInvalidSparqlTerms(plan.invalidTerms);
  return plan;
}

export function sparqlStatements(
  adapter: SparqlTermSite['adapter'],
  terms: SparqlTermPolicy = ADAPTER_SPARQL_TERM_POLICY,
): SparqlStatements {
  const renderer = (operation: SparqlTermSite['operation']) => terms.renderer({ adapter, operation });
  const graphs = (...graphUris: string[]): GraphWriteScope => ({ kind: 'graphs', graphs: graphUris });

  return {
    insertData(quads) {
      const operation = 'insert';
      const render = renderer(operation);
      const byGraph = new Map<string, Quad[]>();
      for (const q of quads) {
        const g = q.graph || '';
        if (!byGraph.has(g)) byGraph.set(g, []);
        byGraph.get(g)!.push(q);
      }
      const parts: string[] = [];
      for (const [graph, list] of byGraph) {
        const triples = list.map((q) =>
          `${render.rdf(q.subject, 'subject', 'allow')} ${render.iri(q.predicate, 'predicate')} ${render.rdf(q.object, 'object', 'allow')} .`,
        ).join('\n    ');
        if (graph) {
          parts.push(`GRAPH ${render.iri(graph, 'graph')} {\n    ${triples}\n  }`);
        } else {
          parts.push(triples);
        }
      }
      const update = `INSERT DATA {\n  ${parts.join('\n  ')}\n}`;
      return { operation, update, scope: graphs(...byGraph.keys()), invalidTerms: render.invalidTerms };
    },

    deleteData(quads) {
      const operation = 'delete';
      const render = renderer(operation);
      const update = renderBlankNodeSafeDelete(quads, render);
      if (update === null) return null;
      return {
        operation,
        update,
        scope: graphs(...new Set(quads.map((q) => q.graph || ''))),
        invalidTerms: render.invalidTerms,
      };
    },

    deleteByPattern(pattern) {
      const operation = 'deleteByPattern';
      const render = renderer(operation);
      const s = pattern.subject ? render.iri(pattern.subject, 'subject') : '?s';
      const p = pattern.predicate ? render.iri(pattern.predicate, 'predicate') : '?p';
      const o = pattern.object ? render.rdf(pattern.object, 'object', 'reject') : '?o';
      const triple = `${s} ${p} ${o}`;
      // The template needs the `GRAPH` keyword even for the graph variable:
      // `{ ?g_ctx { … } }` is a syntax error that a spec-compliant endpoint
      // rejects with HTTP 400.
      const graph = pattern.graph ? render.iri(pattern.graph, 'graph') : '?g_ctx';
      const update = `DELETE { GRAPH ${graph} { ${triple} } } WHERE { GRAPH ${graph} { ${triple} } }`;
      return {
        operation,
        update,
        scope: pattern.graph ? graphs(pattern.graph) : { kind: 'all' },
        invalidTerms: render.invalidTerms,
      };
    },

    deleteBySubjectPrefix(graphUri, prefix) {
      const operation = 'deleteBySubjectPrefix';
      const render = renderer(operation);
      const graph = render.iri(graphUri, 'graph');
      const update = `DELETE { GRAPH ${graph} { ?s ?p ?o } } WHERE { GRAPH ${graph} { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), ${render.prefix(prefix)})) } }`;
      return { operation, update, scope: graphs(graphUri), invalidTerms: render.invalidTerms };
    },

    dropGraph(graphUri) {
      const operation = 'dropGraph';
      const render = renderer(operation);
      const update = `DROP SILENT GRAPH ${render.iri(graphUri, 'graph')}`;
      return { operation, update, scope: graphs(graphUri), invalidTerms: render.invalidTerms };
    },

    hasGraph(graphUri) {
      const operation = 'hasGraph';
      const render = renderer(operation);
      const sparql = `ASK { GRAPH ${render.iri(graphUri, 'graph')} { ?s ?p ?o } }`;
      return { operation, sparql, invalidTerms: render.invalidTerms };
    },

    countQuads(graphUri) {
      const operation = 'countQuads';
      const render = renderer(operation);
      const sparql = graphUri
        ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH ${render.iri(graphUri, 'graph')} { ?s ?p ?o } }`
        : 'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }';
      return { operation, sparql, invalidTerms: render.invalidTerms };
    },
  };
}
