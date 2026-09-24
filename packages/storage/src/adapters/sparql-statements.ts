/**
 * The SPARQL statements the storage adapters build by string interpolation.
 *
 * Each builder returns a plan: the statement, the store operation it runs as,
 * and for an update the graphs it may write. The same operation labels every
 * term the builder renders, and the write scope comes from the same pass that
 * builds the statement.
 *
 * Reporting is an invariant: {@link sparqlStatements} is the only statement
 * factory, and every renderer it creates reports each invalid term
 * (`sparql-term-observer.ts`) the moment it renders it: exactly once, and
 * before the adapter admits or dispatches anything. In reject mode the term
 * is reported, then the error is thrown. The same holds for
 * {@link SparqlStatements.checkIris}, which checks the IRIs of the writes
 * whose terms these builders do not render.
 */
import type { GraphWriteScope } from '../graph-write-gen.js';
import type { Quad } from '../triple-store.js';
import { renderBlankNodeSafeDelete } from './blank-node-safe-delete.js';
import { reportInvalidSparqlTerm } from './sparql-term-observer.js';
import {
  ADAPTER_SPARQL_TERM_POLICY,
  type SparqlTermPolicy,
  type SparqlTermRenderer,
  type SparqlTermSite,
} from './sparql-term-policy.js';

export type SparqlQueryOperation = 'hasGraph' | 'countQuads';
/** A write whose terms no builder here renders: atomic replace, RFC-64 commit, N-Quads insert. */
export type QuadIriCheckOperation =
  | 'insert'
  | 'replaceGraph'
  | 'replaceGraphAndSubject'
  | 'replaceSubject'
  | 'rfc64AuthorCommitCasV1';
export type SparqlUpdateOperation =
  | 'insert'
  | 'delete'
  | 'deleteByPattern'
  | 'deleteBySubjectPrefix'
  | 'dropGraph';

/** A query, and the store operation it runs as. */
export interface SparqlQueryPlan<O extends SparqlQueryOperation = SparqlQueryOperation> {
  readonly operation: O;
  readonly sparql: string;
}

/** An update, the store operation it runs as, and the graphs it may write. */
export interface SparqlUpdatePlan<O extends SparqlUpdateOperation = SparqlUpdateOperation> {
  readonly operation: O;
  readonly update: string;
  readonly scope: GraphWriteScope;
}

/** Each builder's plan is typed by its exact operation. */
export interface SparqlStatements {
  /** `INSERT DATA` for `quads`, grouped by graph; subjects and objects may be blank nodes. */
  insertData(quads: readonly Quad[]): SparqlUpdatePlan<'insert'>;
  /**
   * An update deleting exactly `quads`, blank-node-bearing ones included, or
   * null when there are none (see `blank-node-safe-delete.ts`).
   */
  deleteData(quads: Quad[]): SparqlUpdatePlan<'delete'> | null;
  /**
   * Delete every quad matching `pattern`, where an unset term matches
   * anything. A DELETE template cannot hold a blank node.
   */
  deleteByPattern(pattern: Partial<Quad>): SparqlUpdatePlan<'deleteByPattern'>;
  /** Delete every quad in `graph` whose subject IRI starts with `prefix`. */
  deleteBySubjectPrefix(graph: string, prefix: string): SparqlUpdatePlan<'deleteBySubjectPrefix'>;
  dropGraph(graph: string): SparqlUpdatePlan<'dropGraph'>;
  hasGraph(graph: string): SparqlQueryPlan<'hasGraph'>;
  /** Count the quads in `graph`, or in the default graph and every named graph. */
  countQuads(graph?: string): SparqlQueryPlan<'countQuads'>;
  /**
   * Check the IRIs of `quads`, a literal's datatype included, against the
   * storage absolute-IRI rule, for a write whose terms none of these builders
   * render: an atomic-replace or RFC-64 update, whose builder checks the rest
   * of the syntax itself, or an N-Quads load. Builds nothing, so the write is
   * unchanged. Call it once per write, after its own builder has succeeded.
   */
  checkIris(operation: QuadIriCheckOperation, quads: readonly Quad[]): void;
}

type SparqlUpdateBody = Omit<SparqlUpdatePlan, 'operation'>;
type SparqlQueryBody = Omit<SparqlQueryPlan, 'operation'>;

/** The adapters' statement factory (see the module comment for its reporting invariant). */
export function sparqlStatements(
  adapter: SparqlTermSite['adapter'],
  terms: SparqlTermPolicy = ADAPTER_SPARQL_TERM_POLICY,
): SparqlStatements {
  /** A renderer for one statement at `operation` that reports each invalid term. */
  const renderer = (operation: SparqlTermSite['operation']): SparqlTermRenderer =>
    terms.renderer({ adapter, operation }, reportInvalidSparqlTerm);

  // The plan's operation comes from the same value that labelled its terms,
  // so the two cannot diverge.
  function update<O extends SparqlUpdateOperation>(
    operation: O,
    render: (renderer: SparqlTermRenderer) => SparqlUpdateBody,
  ): SparqlUpdatePlan<O>;
  function update<O extends SparqlUpdateOperation>(
    operation: O,
    render: (renderer: SparqlTermRenderer) => SparqlUpdateBody | null,
  ): SparqlUpdatePlan<O> | null;
  function update<O extends SparqlUpdateOperation>(
    operation: O,
    render: (renderer: SparqlTermRenderer) => SparqlUpdateBody | null,
  ): SparqlUpdatePlan<O> | null {
    const body = render(renderer(operation));
    return body === null ? null : { operation, ...body };
  }

  function query<O extends SparqlQueryOperation>(
    operation: O,
    render: (renderer: SparqlTermRenderer) => SparqlQueryBody,
  ): SparqlQueryPlan<O> {
    return { operation, ...render(renderer(operation)) };
  }
  const graphs = (...graphUris: string[]): GraphWriteScope => ({ kind: 'graphs', graphs: graphUris });

  return {
    insertData(quads) {
      return update('insert', (render) => {
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
          update: `INSERT DATA {\n  ${parts.join('\n  ')}\n}`,
          scope: graphs(...byGraph.keys()),
        };
      });
    },

    deleteData(quads) {
      return update('delete', (render) => {
        const statement = renderBlankNodeSafeDelete(quads, render);
        if (statement === null) return null;
        return { update: statement, scope: graphs(...new Set(quads.map((q) => q.graph || ''))) };
      });
    },

    deleteByPattern(pattern) {
      return update('deleteByPattern', (render) => {
        const s = pattern.subject ? render.iri(pattern.subject, 'subject') : '?s';
        const p = pattern.predicate ? render.iri(pattern.predicate, 'predicate') : '?p';
        const o = pattern.object ? render.rdf(pattern.object, 'object', 'reject') : '?o';
        const triple = `${s} ${p} ${o}`;
        // The template needs the `GRAPH` keyword even for the graph variable:
        // `{ ?g_ctx { … } }` is a syntax error that a spec-compliant endpoint
        // rejects with HTTP 400.
        const graph = pattern.graph ? render.iri(pattern.graph, 'graph') : '?g_ctx';
        return {
          update: `DELETE { GRAPH ${graph} { ${triple} } } WHERE { GRAPH ${graph} { ${triple} } }`,
          scope: pattern.graph ? graphs(pattern.graph) : { kind: 'all' },
        };
      });
    },

    deleteBySubjectPrefix(graphUri, prefix) {
      return update('deleteBySubjectPrefix', (render) => {
        const graph = render.iri(graphUri, 'graph');
        return {
          update: `DELETE { GRAPH ${graph} { ?s ?p ?o } } WHERE { GRAPH ${graph} { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), ${render.prefix(prefix)})) } }`,
          scope: graphs(graphUri),
        };
      });
    },

    dropGraph(graphUri) {
      return update('dropGraph', (render) => ({
        update: `DROP SILENT GRAPH ${render.iri(graphUri, 'graph')}`,
        scope: graphs(graphUri),
      }));
    },

    hasGraph(graphUri) {
      return query('hasGraph', (render) => ({
        sparql: `ASK { GRAPH ${render.iri(graphUri, 'graph')} { ?s ?p ?o } }`,
      }));
    },

    countQuads(graphUri) {
      return query('countQuads', (render) => ({
        sparql: graphUri
          ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH ${render.iri(graphUri, 'graph')} { ?s ?p ?o } }`
          : 'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
      }));
    },

    checkIris(operation, quads) {
      const render = renderer(operation);
      for (const q of quads) {
        render.checkIri(q.subject, 'subject');
        render.checkIri(q.predicate, 'predicate');
        render.checkIri(q.object, 'object');
        if (q.graph) render.checkIri(q.graph, 'graph');
      }
    },
  };
}
