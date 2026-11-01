import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  prepareSparql,
  prepareSparqlQuery,
  type PreparedSparqlQuery,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import type { SparqlEngineFamily } from '@origintrail-official/dkg-storage';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { sparqlRewriteReady, sparqlRewriteUnsupported, type SparqlRewriteResult } from './sparql-rewrite-result.js';

/**
 * How a read scoped to a graph list uses the query's dataset (FROM, FROM NAMED).
 *
 * `VALUES ?g { ... } GRAPH ?g { ... }` limits only what the engine evaluates with
 * `?g` already bound. A nested SELECT has its own variables, so it doesn't get that
 * binding on any engine we run. Other than Oxigraph, an engine may also run a repeated
 * path or a named subquery before the binding arrives, and treat the default graph as
 * every graph. A dataset is applied by the store itself and holds for all of these.
 *
 * - `none`: the graph rewrite is enough, and the query stays as it is.
 * - `guard`: the rewrite stays, with the dataset alongside it.
 * - `dataset-only`: the dataset selects the graphs for a graph variable. A `VALUES` list
 *   here would only repeat each row once per graph, because the pattern never reads it.
 *   Constant GRAPH branches hold without the dataset, so a union-only route keeps them.
 * - `describe`: DESCRIBE reads its description outside the WHERE pattern, so a GRAPH
 *   around that pattern doesn't reach it. The default graph has to be the list.
 */
export type GraphDatasetRoute = 'none' | 'guard' | 'dataset-only' | 'describe';

function isSymbol(token: SparqlLexicalToken | undefined, value: string): boolean {
  return token?.kind === 'symbol' && token.logicalValue === value;
}

export function hasNestedSelect(scope: PreparedSparqlQuery): boolean {
  return scope.prepared.tokens
    .slice(scope.prepared.prologue.endTokenIndex + 1)
    .some((token) => token.kind === 'word' && token.upper === 'SELECT');
}

/**
 * True when a `+`, `*` or `?` follows something a path can repeat. Arithmetic after
 * a function call also matches, which only costs that query the dataset route.
 */
export function hasRepeatedPath(scope: PreparedSparqlQuery): boolean {
  const { tokens } = scope.prepared;
  return tokens.some((token, index) => {
    if (!isSymbol(token, '+') && !isSymbol(token, '*') && !isSymbol(token, '?')) return false;
    const before = tokens[index - 1];
    return before?.kind === 'iri' || before?.kind === 'prefixed-name' || isSymbol(before, ')')
      || (before?.kind === 'word' && before.logicalValue === 'a');
  });
}

export function planGraphDataset(
  scope: PreparedSparqlQuery,
  engine: SparqlEngineFamily | null,
): GraphDatasetRoute {
  const nestedSelect = hasNestedSelect(scope);
  if (engine === 'oxigraph') return nestedSelect ? 'dataset-only' : 'none';
  if (scope.operation === 'DESCRIBE') return 'describe';
  return nestedSelect || hasRepeatedPath(scope) ? 'dataset-only' : 'guard';
}

/** Dataset clauses go after the projection or CONSTRUCT template, before any group. */
function datasetClauseOffset(scope: PreparedSparqlQuery): number | null {
  const { tokens, prologue } = scope.prepared;
  let index = prologue.endTokenIndex + 1;
  if (scope.operation === 'CONSTRUCT' && isSymbol(tokens[index], '{')) {
    index = scope.structure.braces.matchingTokenIndexes[index] + 1;
    if (index === 0) return null;
  }
  for (; index < tokens.length; index++) {
    const token = tokens[index];
    if (isSymbol(token, '(')) {
      index = scope.structure.parentheses.matchingTokenIndexes[index];
      if (index < 0) return null;
    } else if (isSymbol(token, '{')
      || (token.kind === 'word' && (token.upper === 'WHERE' || token.upper === 'WITH'))) {
      return token.start;
    }
  }
  return null;
}

/** The query's source with its dataset set to these graphs, or null if it has no place for one. */
export function withDatasetClauses(
  scope: PreparedSparqlQuery,
  graphs: readonly string[],
  keyword: 'FROM' | 'FROM NAMED',
): string | null {
  const offset = datasetClauseOffset(scope);
  if (offset === null) return null;
  const clauses = [...new Set(graphs)].map((graph) => `${keyword} <${assertSafeIri(graph)}>`).join(' ');
  return `${scope.source.slice(0, offset)}${clauses} ${scope.source.slice(offset)}`;
}

/**
 * Run a read's graph rewrite and set the dataset its route needs. DESCRIBE with a
 * pattern skips the rewrite: a GRAPH around the pattern adds nothing once the default
 * graph is the list. Blazegraph fails most of the shapes a caller's own GRAPH gives
 * DESCRIBE, whatever the dataset, so those are refused here with a clear reason.
 */
export function applyGraphDataset<Reason extends string>(
  scope: PreparedSparqlQuery,
  graphs: readonly string[],
  engine: SparqlEngineFamily | null,
  rewrite: (route: GraphDatasetRoute) => SparqlRewriteResult<PreparedSparqlQuery, Reason>,
): SparqlRewriteResult<PreparedSparqlQuery, Reason | 'missing-where'> {
  const route = planGraphDataset(scope, engine);
  if (route === 'describe' && scope.hasGraphClause) {
    throw new ScopedQueryViolationError('DESCRIBE cannot be combined with a GRAPH clause on this store');
  }
  const result = route === 'describe' && scope.where ? sparqlRewriteReady(scope) : rewrite(route);
  if (route === 'none' || result.kind !== 'ready' || result.value.hasDatasetClause) return result;
  const source = withDatasetClauses(result.value, graphs, route === 'describe' ? 'FROM' : 'FROM NAMED');
  if (source === null) return sparqlRewriteUnsupported('missing-where');
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new ScopedQueryViolationError('graph rewrite produced malformed SPARQL');
  return sparqlRewriteReady(prepareSparqlQuery(prepared));
}
