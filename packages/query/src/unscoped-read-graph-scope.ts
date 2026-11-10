// SPDX-License-Identifier: Apache-2.0
import { READ_GRAPH_SEGMENT } from '@origintrail-official/dkg-core';
import { isSparqlKeyword, type PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { hasDefaultGraphRead } from './sparql-default-graph-pattern.js';
import { isRepeatedPathOperator } from './sparql-graph-dataset.js';
import { transitionGraphScope } from './sparql-query-transition.js';

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const QUERY_HINT_NAMESPACE = 'http://www.bigdata.com/queryHints#';
// The store resolves this prefix without a declaration in the query.
const BUILT_IN_QUERY_HINT_PREFIX = 'hint';
const LOCAL_NAME_ESCAPE = /\\([_~.\-!$&'()*+,;=/?#@%])/g;

export const UNSCOPED_READ_GRAPH_QUERY_CODE = 'UNSCOPED_QUERY_NEEDS_CONTEXT_GRAPH';

/** An unscoped query that this store cannot answer while it may hold read-graph partitions. */
export class UnscopedReadGraphQueryError extends ScopedQueryViolationError {
  readonly code = UNSCOPED_READ_GRAPH_QUERY_CODE;

  constructor(what: string) {
    super(`${what} cannot be answered without a context graph on this store; give the query a context graph`);
    this.name = 'UnscopedReadGraphQueryError';
  }
}

/**
 * A FILTER that keeps a graph term outside every context graph's read-graph
 * partition: the SPARQL form of `isReadGraphPartitionIri`, a `_read` path
 * segment after the first one of a context-graph IRI. A graph term that is not
 * an IRI passes.
 */
export function readGraphPartitionExclusionFilter(variable: string): string {
  const text = `STR(${variable})`;
  return `FILTER(!isIRI(${variable}) || !(STRSTARTS(${text}, "${CONTEXT_GRAPH_PREFIX}")`
    + ` && (CONTAINS(${text}, "/${READ_GRAPH_SEGMENT}/") || STRENDS(${text}, "/${READ_GRAPH_SEGMENT}"))))`;
}

/**
 * Prepare an unscoped query for a store that cannot restrict a query's dataset,
 * while the store may hold read-graph partitions. Each `GRAPH ?g { … }` is
 * followed by a filter that leaves the partitions out, wherever the clause is.
 * A query this cannot keep out of the partitions is refused: one that reads
 * outside `GRAPH` (including `DESCRIBE`), names its own dataset, or carries a
 * query hint, which can change how the store reads its graphs. So is a
 * `GRAPH ?g` group that does not begin with a triple pattern, or that holds a
 * path with `*`, `+` or `?`: the store does not apply the filter to those as
 * written. Read-graph IRIs themselves were refused before this.
 */
export function hideReadGraphPartitions(scope: PreparedSparqlQuery): PreparedSparqlQuery {
  if (scope.operation === 'DESCRIBE') throw new UnscopedReadGraphQueryError('DESCRIBE');
  if (scope.hasDatasetClause) throw new UnscopedReadGraphQueryError('A query with FROM or FROM NAMED');
  if (carriesQueryHint(scope)) throw new UnscopedReadGraphQueryError('A query with a query hint');
  if (hasDefaultGraphRead(scope)) throw new UnscopedReadGraphQueryError('A pattern outside GRAPH');
  return transitionGraphScope(scope, withGraphFilters(scope));
}

const NOT_A_TRIPLE_START = new Set(['FILTER', 'BIND', 'VALUES', 'OPTIONAL', 'MINUS', 'GRAPH', 'SERVICE', 'SELECT']);

function withGraphFilters(scope: PreparedSparqlQuery): string {
  const { tokens } = scope.prepared;
  const insertions: Array<{ readonly offset: number; readonly text: string }> = [];
  for (const target of scope.graphTargets) {
    if (target.kind === 'iri') continue;
    if (target.kind === 'invalid') throw new UnscopedReadGraphQueryError('A GRAPH clause without an IRI or a variable');
    const opening = target.targetTokenIndex + 1;
    const open = tokens[opening];
    const closing = scope.structure.braces.matchingTokenIndexes[opening] ?? -1;
    if (open?.kind !== 'symbol' || open.logicalValue !== '{' || closing < 0) {
      throw new UnscopedReadGraphQueryError('A GRAPH clause without a group');
    }
    const first = tokens[opening + 1]!;
    if ((first.kind === 'symbol' && (first.logicalValue === '{' || first.logicalValue === '}'))
      || (first.kind === 'word' && NOT_A_TRIPLE_START.has(first.upper))) {
      throw new UnscopedReadGraphQueryError('A GRAPH ?variable group that does not begin with a triple pattern');
    }
    if (holdsRepeatedPath(scope, opening, closing)) {
      throw new UnscopedReadGraphQueryError('A GRAPH ?variable group with a *, + or ? property path');
    }
    insertions.push({ offset: tokens[closing]!.end, text: ` ${readGraphPartitionExclusionFilter(target.variable.source)}` });
  }
  let source = scope.source;
  for (const { offset, text } of insertions.sort((a, b) => b.offset - a.offset)) {
    source = `${source.slice(0, offset)}${text}${source.slice(offset)}`;
  }
  return source;
}

/** A `*`, `+` or `?` path modifier inside a group, outside FILTER and BIND expressions. */
function holdsRepeatedPath(scope: PreparedSparqlQuery, opening: number, closing: number): boolean {
  const { tokens } = scope.prepared;
  const parentheses = scope.structure.parentheses.matchingTokenIndexes;
  for (let index = opening + 1; index < closing; index++) {
    if (isSparqlKeyword(tokens, index, 'FILTER') || isSparqlKeyword(tokens, index, 'BIND')) {
      const expression = tokens[index + 1];
      if (expression?.kind === 'symbol' && expression.logicalValue === '(') index = Math.max(index, parentheses[index + 1] ?? index);
      continue;
    }
    if (isRepeatedPathOperator(tokens, index)) return true;
  }
  return false;
}

function carriesQueryHint(scope: PreparedSparqlQuery): boolean {
  const { tokens } = scope.prepared;
  const baseToken = tokens.find((_token, index) => isSparqlKeyword(tokens, index - 1, 'BASE'));
  const base = baseToken?.kind === 'iri' ? baseToken.logicalValue : undefined;
  const isHint = (iri: string) => resolve(iri, base).startsWith(QUERY_HINT_NAMESPACE);
  for (const token of tokens) {
    if (token.kind === 'iri' && isHint(token.logicalValue)) return true;
    if (token.kind !== 'prefixed-name') continue;
    const colon = token.logicalValue.indexOf(':');
    const prefix = token.logicalValue.slice(0, colon);
    const namespace = scope.prefixes.get(prefix)
      ?? (prefix === BUILT_IN_QUERY_HINT_PREFIX ? QUERY_HINT_NAMESPACE : undefined);
    if (namespace !== undefined && isHint(namespace + token.logicalValue.slice(colon + 1).replace(LOCAL_NAME_ESCAPE, '$1'))) return true;
  }
  return false;
}

function resolve(iri: string, base: string | undefined): string {
  if (base === undefined || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(iri)) return iri;
  try {
    return new URL(iri, base).href;
  } catch {
    return iri;
  }
}
