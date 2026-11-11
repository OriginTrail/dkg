import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  isSparqlKeyword,
  type PreparedSparqlQuery,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import type { SparqlEngineFamily } from '@origintrail-official/dkg-storage';
import type { GraphAccessMode } from './sparql-graph-access.js';
import { hasOuterDefaultGraphPattern, hasTopLevelDefaultGraphPattern } from './sparql-default-graph-pattern.js';
import {
  bindCallerGraphsBeforeRead,
  callerGraphBranchesFit,
  hasCallerGraphAssignments,
  hasCallerGraphAssignmentsInside,
  hasCallerGraphExpressionAssignments,
} from './sparql-caller-graph-read.js';
import { transitionGraphScope } from './sparql-query-transition.js';
import { createVariableAllocator } from './sparql-rewrite-names.js';
import { heldGraphGuard } from './sparql-held-graph-guard.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { sparqlRewriteReady, sparqlRewriteUnsupported, type SparqlRewriteResult } from './sparql-rewrite-result.js';

/** Complete policy for graph access, dataset scope, and ordered transformations. */
export interface GraphDatasetPlan {
  readonly graphAccess: GraphAccessMode;
  /**
   * Every scoped read carries its dataset: FROM sets the default graph and FROM
   * NAMED the named graphs to the read's graphs.
   */
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

/** Keywords that start a construct which is not itself a triple pattern. */
const NON_TRIPLE_WORDS = new Set(['VALUES', 'BIND', 'FILTER', 'OPTIONAL', 'MINUS', 'UNION', 'EXISTS', 'NOT', 'GRAPH', 'SERVICE', 'SILENT', 'AS']);

/** Whether the group between these braces is a subquery: its content is a SELECT. */
function isSubqueryGroup(scope: PreparedSparqlQuery, opening: number): boolean {
  return isSparqlKeyword(scope.prepared.tokens, opening + 1, 'SELECT');
}

/** Whether the group between these braces has a path with `*` or `?` of its own, which matches without a triple. */
function hasOwnZeroLengthPath(scope: PreparedSparqlQuery, opening: number, closing: number): boolean {
  const { tokens } = scope.prepared;
  const depth = scope.structure.braces.depthBefore[opening] + 1;
  for (let index = opening + 1; index < closing; index++) {
    if (scope.structure.braces.depthBefore[index] !== depth) continue;
    if (!isSymbol(tokens[index], '*') && !isSymbol(tokens[index], '?')) continue;
    const before = tokens[index - 1];
    if (before?.kind === 'iri' || before?.kind === 'prefixed-name' || isSymbol(before, ')')
      || (before?.kind === 'word' && before.logicalValue === 'a' && isSparqlKeyword(tokens, index - 1, 'A'))) return true;
  }
  return false;
}

/**
 * Whether the group between these braces has a triple pattern of its own, not
 * only in nested groups, that needs a stored triple to match. A path with `*` or
 * `?` matches its endpoints without one, so a group that has one counts as having
 * no pattern of its own.
 */
function hasOwnTriplePattern(scope: PreparedSparqlQuery, opening: number, closing: number): boolean {
  const { tokens } = scope.prepared;
  // A group that is a subquery has no pattern of its own; the subquery's are nested.
  if (isSubqueryGroup(scope, opening) || hasOwnZeroLengthPath(scope, opening, closing)) return false;
  const depth = scope.structure.braces.depthBefore[opening] + 1;
  for (let index = opening + 1; index < closing; index++) {
    if (scope.structure.braces.depthBefore[index] !== depth) continue;
    const token = tokens[index];
    if (token.kind === 'symbol') {
      // An expression of BIND, FILTER or a VALUES header: no triple inside.
      if (token.logicalValue === '(') index = scope.structure.parentheses.matchingTokenIndexes[index] ?? closing;
      continue;
    }
    if (token.kind === 'word' && NON_TRIPLE_WORDS.has(token.upper)) {
      // The term after GRAPH, SERVICE or VALUES names a graph, an endpoint or a variable.
      if ((token.upper === 'GRAPH' || token.upper === 'SERVICE' || token.upper === 'VALUES') && tokens[index + 1]?.kind !== 'symbol') index++;
      // A FILTER whose constraint is a function named by an IRI, such as xsd:boolean(...).
      const after = tokens[index + 1];
      if (token.upper === 'FILTER' && (after?.kind === 'iri' || after?.kind === 'prefixed-name') && isSymbol(tokens[index + 2], '(')) index++;
      continue;
    }
    // A function call of a FILTER written without brackets, such as regex(...).
    const next = tokens[index + 1];
    if (token.kind === 'word' && next?.kind === 'symbol' && next.logicalValue === '(') continue;
    return true;
  }
  return false;
}

/**
 * Oxigraph does not evaluate `GRAPH ?var { P }` once per graph of the dataset
 * when P has no triple pattern of its own and holds a VALUES, a subquery or a
 * nested GRAPH, or when P assigns ?var an expression: such a read binds ?var
 * differently or repeats rows differently than with a graph list. Those reads
 * keep the list next to their dataset. (A constant graph branch would drop the
 * rows whose assignment fails.) P is a caller's GRAPH ?var block, or the whole
 * pattern when the rewrite wraps it.
 */
export function readsNeedGraphList(scope: PreparedSparqlQuery): boolean {
  if (scope.hasGraphClause && hasCallerGraphExpressionAssignments(scope)) return true;
  const { tokens } = scope.prepared;
  const groups: Array<readonly [number, number]> = scope.hasGraphClause
    ? scope.graphTargets.flatMap(target => target.kind === 'variable'
      ? [[target.targetTokenIndex + 1, scope.structure.braces.matchingTokenIndexes[target.targetTokenIndex + 1] ?? -1] as const] : [])
    : scope.where ? [[scope.where.openingTokenIndex, scope.where.closingTokenIndex] as const] : [];
  return groups.some(([opening, closing]) => {
    if (closing < 0) return false;
    let holds = false;
    for (let index = opening + 1; index < closing && !holds; index++) {
      holds = ['SELECT', 'GRAPH', 'VALUES'].some(keyword => isSparqlKeyword(tokens, index, keyword));
    }
    return holds && !hasOwnTriplePattern(scope, opening, closing);
  });
}

/** Groups nested deeper than this are not read for a stored triple; their block keeps its guard. */
const MAX_STORED_TRIPLE_DEPTH = 16;

/** Whether the `{` at `index` opens a plain nested group (or the first branch of a UNION), not a group of another construct. */
function opensPlainGroup(scope: PreparedSparqlQuery, index: number): boolean {
  const { tokens } = scope.prepared;
  const before = tokens[index - 1];
  if (isSymbol(before, '{') || isSymbol(before, '}') || isSymbol(before, '.')) return true;
  // `)` ends a BIND, a FILTER or a collection, or the variables of VALUES, whose data follow.
  if (isSymbol(before, ')')) return !isSparqlKeyword(tokens, (scope.structure.parentheses.matchingTokenIndexes[index - 1] ?? 0) - 1, 'VALUES');
  // OPTIONAL, MINUS, EXISTS, UNION and SILENT come before a group that is read on other terms.
  if (!before || before.kind === 'word') return false;
  // A term ends a triples block, unless it names a GRAPH, a SERVICE or a VALUES variable.
  return !['GRAPH', 'SERVICE', 'SILENT', 'VALUES'].some(keyword => isSparqlKeyword(tokens, index - 2, keyword));
}

/**
 * Whether every solution of the group between these braces reads a stored triple
 * of the graph it is read in: a triple pattern of its own, or a nested group, or
 * every branch of a UNION, that does. OPTIONAL, MINUS, EXISTS, a nested GRAPH
 * (another graph) and a subquery prove nothing for it.
 */
function readsStoredTriple(scope: PreparedSparqlQuery, opening: number, closing: number, depth = 0): boolean {
  if (hasOwnTriplePattern(scope, opening, closing)) return true;
  if (depth >= MAX_STORED_TRIPLE_DEPTH || isSubqueryGroup(scope, opening)) return false;
  const { tokens } = scope.prepared;
  const braces = scope.structure.braces.matchingTokenIndexes;
  const own = scope.structure.braces.depthBefore[opening] + 1;
  for (let index = opening + 1; index < closing; index++) {
    if (scope.structure.braces.depthBefore[index] !== own || !isSymbol(tokens[index], '{') || !opensPlainGroup(scope, index)) continue;
    let everyBranch = true;
    for (let branch = index; ; branch = index + 2) {
      const end = braces[branch] ?? -1;
      if (end <= branch || end >= closing) return false;
      everyBranch = readsStoredTriple(scope, branch, end, depth + 1) && everyBranch;
      index = end;
      if (!isSparqlKeyword(tokens, index + 1, 'UNION') || !isSymbol(tokens[index + 2], '{')) break;
    }
    if (everyBranch) return true;
  }
  return false;
}

/**
 * On Oxigraph a graph named in FROM NAMED counts as present even where the store
 * holds none of its triples, so a GRAPH block whose pattern can match without a
 * triple would match it. Each such block, and the whole pattern when the rewrite
 * wraps it, gets a guard that its graph holds a triple. A block every solution of
 * which reads a triple of its graph needs none.
 */
export function guardGraphBlocksWithoutTriples(scope: PreparedSparqlQuery): PreparedSparqlQuery {
  const { tokens } = scope.prepared;
  const closings = new Set<number>();
  if (scope.hasGraphClause) {
    for (const target of scope.graphTargets) {
      if (target.kind === 'invalid') continue;
      const opening = target.targetTokenIndex + 1;
      const closing = scope.structure.braces.matchingTokenIndexes[opening] ?? -1;
      if (closing > opening && !readsStoredTriple(scope, opening, closing)) closings.add(closing);
    }
  } else if (scope.where && !readsStoredTriple(scope, scope.where.openingTokenIndex, scope.where.closingTokenIndex)) {
    closings.add(scope.where.closingTokenIndex);
  }
  if (closings.size === 0) return scope;
  const guard = heldGraphGuard(createVariableAllocator(scope));
  // Insertions go from the end of the text, so earlier offsets stay valid.
  const insertions: Array<readonly [number, string]> = [];
  for (const closing of closings) {
    const opening = scope.structure.braces.matchingTokenIndexes[closing] ?? -1;
    // A subquery fills its group; it moves into a group of its own, which the guard follows.
    if (opening >= 0 && isSubqueryGroup(scope, opening)) {
      insertions.push([tokens[opening].end, ' {'], [tokens[closing].start, ` } ${guard} `]);
    } else {
      insertions.push([tokens[closing].start, ` ${guard} `]);
    }
  }
  let source = scope.source;
  for (const [at, text] of insertions.sort(([left], [right]) => right - left)) {
    source = `${source.slice(0, at)}${text}${source.slice(at)}`;
  }
  return transitionGraphScope(scope, source);
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
  const oxigraph = engine === 'oxigraph';
  // On Oxigraph the dataset's named graphs alone select the read's graphs: a list
  // beside them would cost a dataset lookup per listed graph. Only the reads that
  // Oxigraph evaluates differently without a list keep one.
  const graphAccess = oxigraph
    ? readsNeedGraphList(scope) ? nestedSelect ? 'dataset' : 'values' : 'named'
    : scopedDescription || nestedSelect || repeatedPath ? 'dataset' : 'values';
  // The dataset also scopes reads outside the graph wrapper: descriptions,
  // default and mixed expressions. Graphless descriptions need only FROM.
  const readsDefaultGraph = scope.operation === 'DESCRIBE' || scope.readsOnlyDeclaredNamedSet
    || hasOuterDefaultGraphPattern(scope) || (scope.hasGraphClause && hasTopLevelDefaultGraphPattern(scope));
  return {
    graphAccess,
    datasetClauses: graphlessDescription ? ['FROM']
      : !oxigraph || readsDefaultGraph ? ['FROM', 'FROM NAMED'] : ['FROM NAMED'],
    preservePattern: graphlessDescription || scope.readsOnlyDeclaredNamedSet,
    // Oxigraph repeats the rows of a GRAPH ?var block that assigns ?var a constant, at any
    // depth, once per graph it iterates; a constant branch per graph keeps one row per match.
    bindCallerGraphs: !scopedDescription && scope.graphVariables.length > 0 && (oxigraph
      ? hasCallerGraphAssignmentsInside(scope)
      : graphAccess === 'dataset' && repeatedPath && needsConstantCallerGraphs(scope)),
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
  if (result.kind !== 'ready') return result;
  let rewritten = result.value;
  // On Oxigraph a constant graph assignment over more graphs than the branches allow keeps
  // the graph list the engine left in place, as the read did before, instead of failing.
  if (plan.bindCallerGraphs && (engine !== 'oxigraph' || callerGraphBranchesFit(rewritten, graphs))) {
    rewritten = bindCallerGraphsBeforeRead(rewritten, graphs);
  }
  if (plan.wrapDescriptionPattern && rewritten.where) {
    const { openEnd, close } = rewritten.where;
    const source = `${rewritten.source.slice(0, openEnd)} { SELECT * WHERE { ${rewritten.source.slice(openEnd, close)} } } ${rewritten.source.slice(close)}`;
    rewritten = transitionGraphScope(rewritten, source);
  }
  const source = withDatasetClauses(rewritten, graphs, plan.datasetClauses);
  if (source === null) return sparqlRewriteUnsupported('missing-where');
  return sparqlRewriteReady(transitionGraphScope(rewritten, source));
}
