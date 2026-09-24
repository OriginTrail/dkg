/**
 * The SPARQL statements the storage adapters build by string interpolation.
 *
 * Each builder returns a plan: the statement, the store operation it runs as,
 * and for an update the graphs it may write. The same operation labels every
 * term the builder renders, and the write scope comes from the same pass that
 * builds the statement.
 *
 * Reporting is an invariant: {@link sparqlStatements} is the only statement
 * factory, and every builder reports the invalid terms it rendered
 * (`sparql-term-observer.ts`) exactly once, before the adapter admits or
 * dispatches anything. A term rejected in reject mode is reported the same way
 * before the error propagates.
 */
import type { GraphWriteScope } from '../graph-write-gen.js';
import type { Quad } from '../triple-store.js';
import { renderBlankNodeSafeDelete } from './blank-node-safe-delete.js';
import { reportInvalidSparqlTerms } from './sparql-term-observer.js';
import {
  ADAPTER_SPARQL_TERM_POLICY,
  SparqlTermRejectedError,
  type SparqlTermPolicy,
  type SparqlTermRenderer,
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

/** The adapters' statement factory (see the module comment for its reporting invariant). */
export function sparqlStatements(
  adapter: SparqlTermSite['adapter'],
  terms: SparqlTermPolicy = ADAPTER_SPARQL_TERM_POLICY,
): SparqlStatements {
  /** Render one statement, then report its invalid terms: the one reporting boundary. */
  function build<P>(
    operation: SparqlTermSite['operation'],
    render: (renderer: SparqlTermRenderer) => P,
  ): P {
    const renderer = terms.renderer({ adapter, operation });
    let plan: P;
    try {
      plan = render(renderer);
    } catch (error) {
      if (error instanceof SparqlTermRejectedError) reportInvalidSparqlTerms([error.invalidTerm]);
      throw error;
    }
    reportInvalidSparqlTerms(renderer.invalidTerms);
    return plan;
  }
  const graphs = (...graphUris: string[]): GraphWriteScope => ({ kind: 'graphs', graphs: graphUris });

  return {
    insertData(quads) {
      return build<SparqlUpdatePlan>('insert', (render) => {
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
        return {
          operation: 'insert',
          update: `INSERT DATA {\n  ${parts.join('\n  ')}\n}`,
          scope: graphs(...byGraph.keys()),
        };
      });
    },

    deleteData(quads) {
      return build<SparqlUpdatePlan | null>('delete', (render) => {
        const update = renderBlankNodeSafeDelete(quads, render);
        if (update === null) return null;
        return { operation: 'delete', update, scope: graphs(...new Set(quads.map((q) => q.graph || ''))) };
      });
    },

    deleteByPattern(pattern) {
      return build<SparqlUpdatePlan>('deleteByPattern', (render) => {
        const s = pattern.subject ? render.iri(pattern.subject, 'subject') : '?s';
        const p = pattern.predicate ? render.iri(pattern.predicate, 'predicate') : '?p';
        const o = pattern.object ? render.rdf(pattern.object, 'object', 'reject') : '?o';
        const triple = `${s} ${p} ${o}`;
        // The template needs the `GRAPH` keyword even for the graph variable:
        // `{ ?g_ctx { … } }` is a syntax error that a spec-compliant endpoint
        // rejects with HTTP 400.
        const graph = pattern.graph ? render.iri(pattern.graph, 'graph') : '?g_ctx';
        return {
          operation: 'deleteByPattern',
          update: `DELETE { GRAPH ${graph} { ${triple} } } WHERE { GRAPH ${graph} { ${triple} } }`,
          scope: pattern.graph ? graphs(pattern.graph) : { kind: 'all' },
        };
      });
    },

    deleteBySubjectPrefix(graphUri, prefix) {
      return build<SparqlUpdatePlan>('deleteBySubjectPrefix', (render) => {
        const graph = render.iri(graphUri, 'graph');
        return {
          operation: 'deleteBySubjectPrefix',
          update: `DELETE { GRAPH ${graph} { ?s ?p ?o } } WHERE { GRAPH ${graph} { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), ${render.prefix(prefix)})) } }`,
          scope: graphs(graphUri),
        };
      });
    },

    dropGraph(graphUri) {
      return build<SparqlUpdatePlan>('dropGraph', (render) => ({
        operation: 'dropGraph',
        update: `DROP SILENT GRAPH ${render.iri(graphUri, 'graph')}`,
        scope: graphs(graphUri),
      }));
    },

    hasGraph(graphUri) {
      return build<SparqlQueryPlan>('hasGraph', (render) => ({
        operation: 'hasGraph',
        sparql: `ASK { GRAPH ${render.iri(graphUri, 'graph')} { ?s ?p ?o } }`,
      }));
    },

    countQuads(graphUri) {
      return build<SparqlQueryPlan>('countQuads', (render) => ({
        operation: 'countQuads',
        sparql: graphUri
          ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH ${render.iri(graphUri, 'graph')} { ?s ?p ?o } }`
          : 'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
      }));
    },
  };
}
