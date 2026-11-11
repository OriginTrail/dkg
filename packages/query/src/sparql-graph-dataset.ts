import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  isSparqlKeyword,
  type PreparedSparqlQuery,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import type { SparqlEngineFamily } from '@origintrail-official/dkg-storage';
import type { GraphAccessMode } from './sparql-graph-access.js';
import { hasOuterDefaultGraphPattern, hasTopLevelDefaultGraphPattern } from './sparql-default-graph-pattern.js';
import { bindCallerGraphsBeforeRead, hasCallerGraphAssignments } from './sparql-caller-graph-read.js';
import { transitionGraphScope } from './sparql-query-transition.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { sparqlRewriteReady, sparqlRewriteUnsupported, type SparqlRewriteResult } from './sparql-rewrite-result.js';

/** Complete policy for graph access, dataset scope, and ordered transformations. */
export interface GraphDatasetPlan {
  readonly graphAccess: GraphAccessMode;
  readonly datasetClauses: readonly ('FROM' | 'FROM NAMED')[];
  readonly preservePattern: boolean;
  readonly bindCallerGraphs: boolean;
  readonly wrapDescriptionPattern: boolean;
}

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
): GraphDatasetPlan {
  const graphlessDescription = scope.operation === 'DESCRIBE' && !scope.where;
  const scopedDescription = scope.operation === 'DESCRIBE' && (graphlessDescription || engine !== 'oxigraph');
  if (scopedDescription && scope.hasGraphClause) {
    throw new ScopedQueryViolationError('DESCRIBE cannot be combined with a GRAPH clause on this store');
  }
  const nestedSelect = hasNestedSelect(scope);
  const repeatedPath = hasRepeatedPath(scope);
  const graphAccess = scopedDescription || nestedSelect || (engine !== 'oxigraph' && repeatedPath)
    ? 'dataset' : 'values';
  // A dataset also scopes reads outside the graph wrapper, including descriptions
  // and mixed/default expressions. Graphless descriptions need only FROM.
  const needsDataset = graphAccess === 'dataset' || engine !== 'oxigraph'
    || hasOuterDefaultGraphPattern(scope) || (scope.hasGraphClause && hasTopLevelDefaultGraphPattern(scope));
  return {
    graphAccess,
    datasetClauses: graphlessDescription ? ['FROM'] : needsDataset ? ['FROM', 'FROM NAMED'] : [],
    preservePattern: graphlessDescription || scope.readsOnlyDeclaredNamedSet,
    bindCallerGraphs: !scopedDescription && graphAccess === 'dataset' && engine !== 'oxigraph'
      && scope.graphVariables.length > 0 && repeatedPath && needsConstantCallerGraphs(scope),
    wrapDescriptionPattern: scopedDescription && scope.where !== null,
  };
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
  rewrite: (access: GraphAccessMode) => SparqlRewriteResult<PreparedSparqlQuery, Reason>,
): SparqlRewriteResult<PreparedSparqlQuery, Reason | 'missing-where'> {
  const plan = planGraphDataset(scope, engine);
  const result = plan.preservePattern ? sparqlRewriteReady(scope) : rewrite(plan.graphAccess);
  if (plan.datasetClauses.length === 0 || result.kind !== 'ready') return result;
  let rewritten = result.value;
  if (plan.bindCallerGraphs) rewritten = bindCallerGraphsBeforeRead(rewritten, graphs);
  if (plan.wrapDescriptionPattern && rewritten.where) {
    const { openEnd, close } = rewritten.where;
    const source = `${rewritten.source.slice(0, openEnd)} { SELECT * WHERE { ${rewritten.source.slice(openEnd, close)} } } ${rewritten.source.slice(close)}`;
    rewritten = transitionGraphScope(rewritten, source);
  }
  const source = withDatasetClauses(rewritten, graphs, plan.datasetClauses);
  if (source === null) return sparqlRewriteUnsupported('missing-where');
  return sparqlRewriteReady(transitionGraphScope(rewritten, source));
}
