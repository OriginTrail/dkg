// SPDX-License-Identifier: Apache-2.0
import { READ_GRAPH_SEGMENT } from '@origintrail-official/dkg-core';
import { isSparqlKeyword, type PreparedSparqlQuery, type SparqlLexicalToken } from '@origintrail-official/dkg-rdf-utils/sparql';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { hasDefaultGraphRead } from './sparql-default-graph-pattern.js';
import { isRepeatedPathOperator } from './sparql-graph-dataset.js';
import { transitionGraphScope } from './sparql-query-transition.js';
import { createVariableAllocator } from './sparql-rewrite-names.js';
import { defaultGraphEdits, UnrewrittenPatternError, type SourceEdit } from './unscoped-default-graph-rewrite.js';

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
 * partition: the SPARQL form of `isReadGraphPartitionIri`, the partition
 * segment (`READ_GRAPH_SEGMENT`) after the first segment of a context-graph IRI.
 * A graph term that is not an IRI passes.
 */
export function readGraphPartitionExclusionFilter(variable: string): string {
  const text = `STR(${variable})`;
  return `FILTER(!isIRI(${variable}) || !(STRSTARTS(${text}, "${CONTEXT_GRAPH_PREFIX}")`
    + ` && (CONTAINS(${text}, "/${READ_GRAPH_SEGMENT}/") || STRENDS(${text}, "/${READ_GRAPH_SEGMENT}"))))`;
}

/**
 * Prepare an unscoped query for a store that cannot restrict a query's dataset,
 * while the store may hold read-graph partitions:
 * - each `GRAPH ?g { … }` is followed by a filter that leaves the partitions
 *   out, wherever the clause is;
 * - on a store whose default graph merges every graph (`defaultGraphIsGraphUnion`),
 *   each triple pattern outside GRAPH keeps reading that merge, and only
 *   matches a triple that a graph outside the partitions holds (see
 *   `defaultGraphEdits`); `DESCRIBE` is sent as the store's description, one
 *   step out and one step in, written as a CONSTRUCT. On any other store a
 *   pattern outside GRAPH, and `DESCRIBE`, are refused.
 * A query this cannot keep out of the partitions is refused: one that names its
 * own dataset, declares BASE, carries a query hint (which can change how the store reads its
 * graphs), has a `*`, `+` or `?` path, or has a `GRAPH ?g` group that does not
 * begin with a triple pattern. Read-graph IRIs themselves were refused before.
 */
export function hideReadGraphPartitions(
  scope: PreparedSparqlQuery,
  store: { readonly defaultGraphIsGraphUnion?: boolean } = {},
): PreparedSparqlQuery {
  if (scope.hasDatasetClause) throw new UnscopedReadGraphQueryError('A query with FROM or FROM NAMED');
  // Without BASE, a constant graph is an IRI as written or a prefix and local name, which the
  // read-graph name check before this expands in full; GRAPH constants need no filter then.
  if (scope.prepared.tokens.some((_token, index) => isSparqlKeyword(scope.prepared.tokens, index, 'BASE'))) {
    throw new UnscopedReadGraphQueryError('A query with BASE');
  }
  if (carriesQueryHint(scope)) throw new UnscopedReadGraphQueryError('A query with a query hint');
  // A named subquery reads outside every check here, wherever its INCLUDE stands.
  if (scope.prepared.tokens.some((_token, index) => isSparqlKeyword(scope.prepared.tokens, index, 'INCLUDE')
    || (isSparqlKeyword(scope.prepared.tokens, index, 'WITH') && scope.prepared.tokens[index + 1]?.kind === 'symbol'
      && (scope.prepared.tokens[index + 1] as { logicalValue: string }).logicalValue === '{'))) {
    throw new UnscopedReadGraphQueryError('A query with a named subquery');
  }
  // The rewrite outside GRAPH checks each triple with GRAPH ?h, which only covers the default
  // graph where that graph merges every graph GRAPH ?h reaches.
  if (!store.defaultGraphIsGraphUnion) {
    if (scope.operation === 'DESCRIBE') throw new UnscopedReadGraphQueryError('DESCRIBE');
    if (hasDefaultGraphRead(scope)) throw new UnscopedReadGraphQueryError('A pattern outside GRAPH');
    return transitionGraphScope(scope, applyEdits(scope.source, graphFilterEdits(scope)));
  }
  const query = scope.operation === 'DESCRIBE' ? transitionGraphScope(scope, describeAsConstruct(scope))
    : isShortConstruct(scope) ? transitionGraphScope(scope, shortConstructAsLong(scope)) : scope;
  let edits: SourceEdit[];
  try {
    edits = [...graphFilterEdits(query), ...defaultGraphEdits(query, readGraphPartitionExclusionFilter)];
  } catch (error) {
    if (error instanceof UnrewrittenPatternError) throw new UnscopedReadGraphQueryError(error.what);
    throw error;
  }
  return transitionGraphScope(query, applyEdits(query.source, edits));
}

function applyEdits(text: string, edits: SourceEdit[]): string {
  let source = text;
  // From the end; at one offset, a replacement before an insertion, so the insertion stays in front of it.
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    source = `${source.slice(0, edit.start)}${edit.text}${source.slice(edit.end)}`;
  }
  return source;
}

const NOT_A_TRIPLE_START = new Set(['FILTER', 'BIND', 'VALUES', 'OPTIONAL', 'MINUS', 'GRAPH', 'SERVICE', 'SELECT']);

function graphFilterEdits(scope: PreparedSparqlQuery): SourceEdit[] {
  const { tokens } = scope.prepared;
  const insertions: SourceEdit[] = [];
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
    const offset = tokens[closing]!.end;
    insertions.push({ start: offset, end: offset, text: ` ${readGraphPartitionExclusionFilter(target.variable.source)}` });
  }
  return insertions;
}

/**
 * A `*`, `+` or `?` path modifier inside a group. FILTER and BIND expressions
 * are skipped, except the groups of their EXISTS, which read like the group.
 */
function holdsRepeatedPath(scope: PreparedSparqlQuery, opening: number, closing: number): boolean {
  const { tokens } = scope.prepared;
  const parentheses = scope.structure.parentheses.matchingTokenIndexes;
  const braces = scope.structure.braces.matchingTokenIndexes;
  for (let index = opening + 1; index < closing; index++) {
    if (isSparqlKeyword(tokens, index, 'FILTER') || isSparqlKeyword(tokens, index, 'BIND')) {
      const expression = tokens[index + 1];
      if (expression?.kind !== 'symbol' || expression.logicalValue !== '(') continue;
      const end = Math.max(index, parentheses[index + 1] ?? index);
      for (let inner = index + 2; inner < end; inner++) {
        if (!isSparqlKeyword(tokens, inner, 'EXISTS')) continue;
        const groupEnd = braces[inner + 1] ?? -1;
        if (groupEnd > inner && holdsRepeatedPath(scope, inner + 1, groupEnd)) return true;
        if (groupEnd > inner) inner = groupEnd;
      }
      index = end;
      continue;
    }
    if (isRepeatedPathOperator(tokens, index)) return true;
  }
  return false;
}

function carriesQueryHint(scope: PreparedSparqlQuery): boolean {
  const { tokens } = scope.prepared;
  const isHint = (iri: string) => iri.startsWith(QUERY_HINT_NAMESPACE);
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


/**
 * `DESCRIBE` as the store's default description, one step out and one step in
 * from each described resource, written as a CONSTRUCT the rewrite can reach.
 * IRIs without a WHERE clause, or variables of a WHERE clause; solution
 * modifiers and `DESCRIBE *` are refused.
 */
function describeAsConstruct(scope: PreparedSparqlQuery): string {
  const { tokens } = scope.prepared;
  const operation = scope.prepared.prologue.endTokenIndex;
  const where = scope.where;
  const resources: SparqlLexicalToken[] = [];
  for (let index = operation + 1; index < (where?.openingTokenIndex ?? tokens.length); index++) {
    const token = tokens[index]!;
    if (isSparqlKeyword(tokens, index, 'WHERE')) break;
    if (token.kind === 'variable' || token.kind === 'iri' || token.kind === 'prefixed-name') resources.push(token);
    else throw new UnscopedReadGraphQueryError(token.kind === 'symbol' && token.logicalValue === '*' ? 'DESCRIBE *' : 'This DESCRIBE');
  }
  const variables = resources.filter(token => token.kind === 'variable').length;
  if (resources.length === 0 || (variables > 0 ? !where || variables < resources.length : where !== null)) {
    throw new UnscopedReadGraphQueryError('DESCRIBE that mixes IRIs and variables, or IRIs and WHERE');
  }
  if (where && where.closingTokenIndex !== tokens.length - 1) throw new UnscopedReadGraphQueryError('DESCRIBE with solution modifiers');
  // The store does not describe from a pattern that uses GRAPH.
  if (where && scope.graphTargets.length > 0) throw new UnscopedReadGraphQueryError('DESCRIBE over GRAPH');
  const fresh = createVariableAllocator(scope);
  const body = where ? scope.source.slice(tokens[where.openingTokenIndex]!.end, tokens[where.closingTokenIndex]!.start) : '';
  const template: string[] = [];
  const branches: string[] = [];
  for (const resource of resources) {
    const [verb, object, subject, inverseVerb] = ['_describedVerb', '_describedObject', '_describingSubject', '_describingVerb'].map(fresh);
    template.push(`${resource.raw} ${verb} ${object} . ${subject} ${inverseVerb} ${resource.raw} .`);
    branches.push(`{ ${resource.raw} ${verb} ${object} }`, `{ ${subject} ${inverseVerb} ${resource.raw} }`);
  }
  const prologue = scope.source.slice(0, tokens[operation]!.start);
  // The description joins the WHERE solutions as the store's own DESCRIBE does: a variable that a
  // solution leaves unbound is bound by the description, and the store describes every resource then.
  return `${prologue}CONSTRUCT { ${template.join(' ')} } WHERE { ${body} { ${branches.join(' UNION ')} } }`;
}

/** `CONSTRUCT WHERE { … }`: its template is its pattern, which can hold triples only. */
function isShortConstruct(scope: PreparedSparqlQuery): boolean {
  const operation = scope.prepared.prologue.endTokenIndex;
  return scope.operation === 'CONSTRUCT' && isSparqlKeyword(scope.prepared.tokens, operation + 1, 'WHERE');
}

/** The same query with its template written out, so that its pattern can take filters. */
function shortConstructAsLong(scope: PreparedSparqlQuery): string {
  const { tokens } = scope.prepared;
  const where = scope.where;
  if (!where) throw new UnscopedReadGraphQueryError('This CONSTRUCT');
  const template = scope.source.slice(tokens[where.openingTokenIndex]!.end, tokens[where.closingTokenIndex]!.start).trim();
  if (tokens.slice(where.openingTokenIndex, where.closingTokenIndex).some(token => token.kind === 'symbol'
    && (token.logicalValue === '_' || token.logicalValue === '['))) {
    throw new UnscopedReadGraphQueryError('A short CONSTRUCT with a blank node');
  }
  const operation = scope.prepared.prologue.endTokenIndex;
  return `${scope.source.slice(0, tokens[operation]!.end)} { ${template} } ${scope.source.slice(tokens[operation + 1]!.start)}`;
}
