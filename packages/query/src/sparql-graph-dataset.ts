import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  isSparqlKeyword,
  type PreparedSparqlQuery,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import type { SparqlEngineFamily } from '@origintrail-official/dkg-storage';
import { hasOuterDefaultGraphPattern, hasTopLevelDefaultGraphPattern } from './sparql-default-graph-pattern.js';
import { bindCallerGraphsBeforeRead, hasCallerGraphAssignments } from './sparql-caller-graph-read.js';
import { transitionGraphScope } from './sparql-query-transition.js';
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
  const { tokens, prologue } = scope.prepared;
  return tokens.some((_token, index) => index > prologue.endTokenIndex && isSparqlKeyword(tokens, index, 'SELECT'));
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
      || (before?.kind === 'word' && before.logicalValue === 'a' && isSparqlKeyword(tokens, index - 1, 'A'));
  });
}

/** Atomic paths retain their GRAPH binding; compound paths need constant targets. */
function needsConstantCallerGraphs(scope: PreparedSparqlQuery): boolean {
  if (hasNestedSelect(scope) || hasCallerGraphAssignments(scope)) return true;
  const { tokens } = scope.prepared;
  return tokens.some((token, index) => {
    if (!isSymbol(token, '+') && !isSymbol(token, '*') && !isSymbol(token, '?')) return false;
    if (isSymbol(tokens[index - 2], '!')) return true;
    if (!isSymbol(tokens[index - 1], ')')) return false;
    const opening = scope.structure.parentheses.matchingTokenIndexes[index - 1] ?? -1;
    if (opening < 0) return false;
    const path = tokens.slice(opening + 1, index - 1);
    // Multiplication after a function call is not a compound property path.
    return path.length > 0 && path.every(part => part.kind === 'iri' || part.kind === 'prefixed-name'
      || (part.kind === 'word' && part.logicalValue === 'a')
      || (part.kind === 'symbol' && ['/', '|', '^', '!', '(', ')', '*', '+', '?'].includes(part.logicalValue)));
  });
}

export function planGraphDataset(
  scope: PreparedSparqlQuery,
  engine: SparqlEngineFamily | null,
): GraphDatasetRoute {
  // With no WHERE pattern to rewrite, only the dataset can scope a description.
  if (scope.operation === 'DESCRIBE' && !scope.where) return 'describe';
  const nestedSelect = hasNestedSelect(scope);
  // GRAPH wrappers do not cover projection/modifier expressions or default
  // patterns beside a caller GRAPH. Give those reads an authorized default graph.
  if (engine === 'oxigraph') return nestedSelect ? 'dataset-only'
    : hasOuterDefaultGraphPattern(scope) || (scope.hasGraphClause && hasTopLevelDefaultGraphPattern(scope)) ? 'guard' : 'none';
  if (scope.operation === 'DESCRIBE') return 'describe';
  return nestedSelect || hasRepeatedPath(scope) ? 'dataset-only' : 'guard';
}

/** The query's source with its dataset set to these graphs, or null if it has no place for one. */
export function withDatasetClauses(
  scope: PreparedSparqlQuery,
  graphs: readonly string[],
  keyword: 'FROM' | 'FROM NAMED' | readonly ('FROM' | 'FROM NAMED')[],
): string | null {
  const offset = scope.datasetInsertionOffset;
  if (offset === null) return null;
  const keywords = typeof keyword === 'string' ? [keyword] : keyword;
  const clauses = keywords.flatMap(clause => [...new Set(graphs)]
    .map(graph => `${clause} <${assertSafeIri(graph)}>`)).join(' ');
  const before = scope.source.slice(0, offset);
  const separator = /\s$/.test(before) ? '' : ' ';
  return `${before}${separator}${clauses} ${scope.source.slice(offset)}`;
}

/**
 * Run a read's graph rewrite and set the dataset its route needs. DESCRIBE must
 * still match WHERE inside individual graphs, while descriptions use the allowed
 * default dataset. Blazegraph needs the generated GRAPH inside a SELECT subquery.
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
  const result = (route === 'describe' && !scope.where) || scope.readsOnlyDeclaredNamedSet ? sparqlRewriteReady(scope)
    : rewrite(route === 'describe' ? 'dataset-only' : route);
  if (route === 'none' || result.kind !== 'ready') return result;
  let rewritten = result.value;
  if (route === 'dataset-only' && engine !== 'oxigraph' && scope.graphVariables.length
    && hasRepeatedPath(scope) && needsConstantCallerGraphs(scope)) {
    rewritten = bindCallerGraphsBeforeRead(rewritten, graphs);
  }
  if (route === 'describe' && rewritten.where) {
    const { openEnd, close } = rewritten.where;
    const source = `${rewritten.source.slice(0, openEnd)} { SELECT * WHERE { ${rewritten.source.slice(openEnd, close)} } } ${rewritten.source.slice(close)}`;
    rewritten = transitionGraphScope(rewritten, source);
  }
  // Expressions outside the GRAPH wrapper and mixed caller GRAPH/default
  // patterns read the default dataset too. Scope both datasets to the same
  // allowlist; FROM NAMED alone silently empties their valid matches.
  const keywords = scope.operation === 'DESCRIBE' && !scope.where
    ? 'FROM' : ['FROM', 'FROM NAMED'] as const;
  const source = withDatasetClauses(rewritten, graphs, keywords);
  if (source === null) return sparqlRewriteUnsupported('missing-where');
  return sparqlRewriteReady(transitionGraphScope(rewritten, source));
}
