import {
  prepareSparqlQuery,
  type PreparedSparqlQuery,
  type SparqlGraphTarget as PreparedSparqlGraphTarget,
  type SparqlLexicalToken,
  type ValidPreparedSparql,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { SparqlEngineFamily } from '@origintrail-official/dkg-storage';
import {
  sparqlRewriteReady,
  sparqlRewriteUnsupported,
  type SparqlRewriteResult,
} from './sparql-rewrite-result.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { applyGraphDataset } from './sparql-graph-dataset.js';
import { graphSubselectLimit } from './sparql-subselect-limit.js';
import { renderDedupPattern } from './sparql-dedup-pattern-source.js';
import { analyzeDedupPattern } from './sparql-dedup-pattern.js';
import { variablesOutsideHeldGraphGuards } from './sparql-held-graph-guard.js';
import { hasTopLevelDefaultGraphPattern } from './sparql-default-graph-pattern.js';
import { createGraphAccess, type GraphAccess } from './sparql-graph-access.js';
import { createBlankNodeRenamer, createVariableAllocator, type VariableAllocator } from './sparql-rewrite-names.js';
import { transitionGraphScope } from './sparql-query-transition.js';
export { transitionGraphScope } from './sparql-query-transition.js';

function iriValue(token: SparqlLexicalToken | undefined): string | null {
  return token?.kind === 'iri' ? token.logicalValue : null;
}

function assertNeverGraphTarget(target: never): never {
  throw new ScopedQueryViolationError(
    `unrecognized prepared GRAPH target: ${JSON.stringify(target)}`,
  );
}

export type SparqlGraphTarget = PreparedSparqlGraphTarget;

/**
 * One canonical, source-coordinate model for graph authorization and rewrites.
 * Comments, strings, and IRI payloads have already been made opaque by the RDF
 * scanner; every fact below is derived from that same token stream.
 */
export type PreparedGraphScope = PreparedSparqlQuery;

export type GraphScopeRewriteResult = SparqlRewriteResult<
  PreparedGraphScope,
  GraphScopeUnsupportedReason
>;

export type GraphScopeUnsupportedReason =
  | 'missing-where'
  | 'nested-union'
  | 'strategy-rejected'
  | 'no-projected-variables';

function ready(scope: PreparedGraphScope): GraphScopeRewriteResult {
  return sparqlRewriteReady(scope);
}

function unsupported(
  reason: GraphScopeUnsupportedReason,
): GraphScopeRewriteResult {
  return sparqlRewriteUnsupported(reason);
}

/** Convert a total rewrite result into the required scoped query boundary. */
export function requireGraphScopeRewrite(result: GraphScopeRewriteResult): PreparedGraphScope {
  if (result.kind === 'ready') return result.value;
  if (result.reason === 'missing-where') {
    throw new ScopedQueryViolationError('unable to locate a graph-scopable WHERE block');
  }
  throw new ScopedQueryViolationError(`graph rewrite is unsupported: ${result.reason}`);
}

export function prepareGraphScope(
  input: ValidPreparedSparql,
): PreparedGraphScope {
  return prepareSparqlQuery(input);
}

export function assertNoCallerDatasetClauses(scope: PreparedGraphScope): void {
  if (scope.hasDatasetClause) {
    throw new ScopedQueryViolationError('FROM clauses are not allowed on scoped local queries');
  }
}

export function assertExplicitGraphIrisAllowed(
  scope: PreparedGraphScope,
  allowedGraphs: readonly string[],
): void {
  const allowed = new Set(allowedGraphs);
  for (const target of scope.graphTargets) {
    switch (target.kind) {
      case 'invalid': {
        const token = scope.prepared.tokens[target.targetTokenIndex];
        if (token?.kind === 'prefixed-name') {
          throw new ScopedQueryViolationError(
            `GRAPH prefixed target ${token.logicalValue} cannot be resolved from PREFIX declarations`,
          );
        }
        throw new ScopedQueryViolationError(
          'GRAPH target must be a variable, explicit IRI, or resolvable prefixed name on scoped queries',
        );
      }
      case 'iri':
        if (!allowed.has(target.iri)) {
          throw new ScopedQueryViolationError(
            `GRAPH <${target.iri}> is outside the allowed graph set`,
          );
        }
        break;
      case 'variable':
        break;
      default:
        assertNeverGraphTarget(target);
    }
  }
}

export function wrapWithGraph(
  scope: PreparedGraphScope,
  graphUri: string,
): GraphScopeRewriteResult {
  if (scope.hasGraphClause) return ready(transitionGraphScope(scope, scope.source));
  if (!scope.where) return unsupported('missing-where');
  const { openEnd, close } = scope.where;
  const before = scope.source.slice(0, openEnd);
  const inner = scope.source.slice(openEnd, close);
  const after = scope.source.slice(close);
  return ready(transitionGraphScope(
    scope,
    `${before} GRAPH <${assertSafeIri(graphUri)}> { ${inner} } ${after}`,
  ));
}

export function wrapWithGraphUnion(
  scope: PreparedGraphScope,
  graphUris: readonly string[],
): GraphScopeRewriteResult {
  if (scope.hasGraphClause) return ready(transitionGraphScope(scope, scope.source));
  if (graphUris.length === 0) return ready(transitionGraphScope(scope, scope.source));
  if (!scope.where) return unsupported('missing-where');
  const { openEnd, close, hasUnion } = scope.where;
  const before = scope.source.slice(0, openEnd);
  const inner = scope.source.slice(openEnd, close);
  const after = scope.source.slice(close);
  if (graphUris.length === 1) {
    return ready(transitionGraphScope(
      scope,
      `${before} GRAPH <${assertSafeIri(graphUris[0])}> { ${inner} } ${after}`,
    ));
  }
  if (hasUnion) return unsupported('nested-union');
  const branchSource = createBlankNodeRenamer(scope);
  const branches = graphUris
    .map((graph) => `{ GRAPH <${assertSafeIri(graph)}> { ${branchSource(openEnd, close)} } }`)
    .join(' UNION ');
  return ready(transitionGraphScope(scope, `${before} ${branches} ${after}`));
}

interface ProjectedGraphPattern {
  readonly pattern: string;
  readonly distinct?: boolean;
  /** What the subselect projects when the caller's pattern has no variables: a private variable, never bound. */
  readonly emptyProjection?: string;
}

function wrapWithProjectedGraphSubselect(
  scope: PreparedGraphScope,
  graphUris: readonly string[],
  buildPattern: (inner: string, graphs: readonly string[]) => ProjectedGraphPattern | null,
): GraphScopeRewriteResult {
  if (scope.hasGraphClause) return ready(transitionGraphScope(scope, scope.source));
  if (graphUris.length === 0) return ready(transitionGraphScope(scope, scope.source));
  if (!scope.where) return unsupported('missing-where');

  const { openEnd, close, hasUnion } = scope.where;
  const inner = scope.source.slice(openEnd, close);
  const graphs = [...new Set(graphUris)];
  if (graphs.length === 1) {
    return ready(transitionGraphScope(
      scope,
      `${scope.source.slice(0, openEnd)} GRAPH <${assertSafeIri(graphs[0])}> { ${inner} } ${scope.source.slice(close)}`,
    ));
  }
  if (hasUnion) return unsupported('nested-union');
  const built = buildPattern(inner, graphs);
  if (!built) return unsupported('strategy-rejected');
  const { pattern, distinct, emptyProjection } = built;

  const innerVariables = variablesOutsideHeldGraphGuards(scope);
  const variables = innerVariables.length ? innerVariables.map(variable => variable.source).join(' ') : emptyProjection;
  if (!variables) return unsupported('no-projected-variables');
  const replacement = `{ SELECT ${distinct ? 'DISTINCT ' : ''}${variables} WHERE { ${pattern} }${graphSubselectLimit(scope)} }`;
  return ready(transitionGraphScope(
    scope,
    `${scope.source.slice(0, openEnd)} ${replacement} ${scope.source.slice(close)}`,
  ));
}

/** Own graph choice and FILTER placement inside the shared projection boundary. */
function buildDeduplicatedGraphPattern(
  scope: PreparedGraphScope, access: GraphAccess, allocate: VariableAllocator,
): ProjectedGraphPattern | null {
  const plan = analyzeDedupPattern(scope);
  if (!plan) return null;
  const { uniqueMappings, filters } = plan;
  // Deduplicate only mappings known to be unique within one graph. ASK uses
  // the same row semantics, including its modifiers and volatile FILTERs.
  const distinct = uniqueMappings;
  const movedFilters = filters;
  // Every retained row evaluates each moved FILTER once. Hidden blank-node
  // variables stay private across graph selection and replay.
  const callerVariables = variablesOutsideHeldGraphGuards(scope).map(variable => variable.source);
  // A mapping is read from one graph. The caller's variables are the mapping; blank nodes, like paths, then
  // repeat as often as the chosen graph holds them. Without caller variables the blank nodes are the mapping:
  // a mirrored match is read once, and distinct blank matches each. A collection's list nodes have no private
  // variable, and a path group is not told apart from a collection here: without caller variables, a pattern
  // that holds either keeps one branch per graph.
  if (!callerVariables.length && holdsParenthesis(scope, movedFilters)) return null;
  const { pattern: inner, blankVariables } = renderDedupPattern(scope, movedFilters, allocate, callerVariables.length === 0);
  // A pattern without caller variables projects one private variable, so its rows are read through this route too
  // and keep their multiplicity. Blazegraph counts no row that binds no variable, so the variable is bound, except
  // where the query projects every variable (`*`): there the rows themselves are the answer, and stay empty.
  const emptyProjection = callerVariables.length ? undefined : allocate('__dkgNoVariable');
  const bindEmpty = emptyProjection && !projectsEveryVariable(scope) ? ` BIND(true AS ${emptyProjection})` : '';
  const variables = callerVariables.length ? callerVariables.join(' ') : emptyProjection!;
  const keys = (callerVariables.length ? callerVariables : blankVariables).join(' ');
  const filterVariables = movedFilters.map((_filter, index) => allocate(`__dkgDedupFilter${index}`));
  // BIND evaluates on every retained row on the right of the rejoin. A raw
  // FILTER can be pushed onto the grouped left side by either engine, sampling
  // once for all identical mappings. Filtering these booleans after OPTIONAL
  // also discards its unmatched fallback row and expression errors.
  const filterBindings = movedFilters.map(({ expressionStart, end }, index) =>
    `BIND(${scope.source.slice(expressionStart, end)} AS ${filterVariables[index]})`,
  ).join(' ');
  const bindings = { pattern: filterBindings, projectedVariables: filterVariables };
  const graph = allocate('__dkgDedupGraph');
  const matchGraph = distinct ? graph : allocate('__dkgDedupMatchGraph');
  const candidate = access.candidate(inner, matchGraph);
  if (distinct) {
    if (!movedFilters.length) return { pattern: `${candidate}${bindEmpty}`, distinct, emptyProjection };
    const trailing = filterVariables.map(variable => `FILTER(${variable})`).join(' ');
    return { pattern: `{ SELECT DISTINCT ${variables} WHERE { ${candidate}${bindEmpty} } } ${filterBindings} ${trailing}`, emptyProjection };
  }
  // Choose one graph deterministically and replay its hidden-path multiplicity.
  // The access implementation owns the barriers required by its backend plan.
  const replay = access.replay(inner, graph, keys, bindings);
  const trailing = filterVariables.map(variable => `FILTER(${variable})`).join(' ');
  // Without keys all matches form one group, and no match still leaves its row with an unbound graph, which
  // the replay must never read: that row is dropped before the replay joins.
  const chosen = keys
    ? `{ SELECT ${keys} (MIN(${matchGraph}) AS ${graph}) WHERE { ${candidate} } GROUP BY ${keys} }`
    : `{ { SELECT (MIN(${matchGraph}) AS ${graph}) WHERE { ${candidate} } } FILTER(BOUND(${graph})) }`;
  return { pattern: `${chosen} ${replay} ${trailing}${bindEmpty}`, emptyProjection };
}

/** Whether the pattern holds a parenthesis outside its FILTERs: a collection or a path group. */
function holdsParenthesis(scope: PreparedGraphScope, filters: readonly { readonly start: number; readonly end: number }[]): boolean {
  const { tokens } = scope.prepared;
  for (let index = scope.where!.openingTokenIndex + 1; index < scope.where!.closingTokenIndex; index++) {
    const token = tokens[index];
    if (token.kind !== 'symbol' || token.logicalValue !== '(') continue;
    if (!filters.some(range => token.start >= range.start && token.start < range.end)) return true;
  }
  return false;
}

/** Whether the query projects every in-scope variable: `SELECT *` or `DESCRIBE *`, not the `*` of `COUNT(*)`. */
function projectsEveryVariable(scope: PreparedGraphScope): boolean {
  if ((scope.operation !== 'SELECT' && scope.operation !== 'DESCRIBE') || !scope.where) return false;
  const { tokens } = scope.prepared;
  let depth = 0;
  for (let index = scope.prepared.prologue.endTokenIndex + 1; index < scope.where.openingTokenIndex; index++) {
    const token = tokens[index];
    if (token.kind !== 'symbol') continue;
    if (token.logicalValue === '(') depth += 1;
    else if (token.logicalValue === ')') depth -= 1;
    else if (token.logicalValue === '*' && depth === 0) return true;
  }
  return false;
}

/** Scope a graph set, reading each mapping from one graph even when several hold it. */
export function wrapWithDeduplicatedGraphValues(
  input: PreparedGraphScope,
  graphUris: readonly string[],
): GraphScopeRewriteResult {
  const allocate = createVariableAllocator(input);
  return wrapWithDeduplicatedGraphSelection(input, graphUris, createGraphAccess('values', [...new Set(graphUris)], allocate), allocate);
}

function wrapWithDeduplicatedGraphSelection(
  input: PreparedGraphScope, graphUris: readonly string[], access: GraphAccess, allocate: VariableAllocator,
): GraphScopeRewriteResult {
  return wrapWithProjectedGraphSubselect(
    input, graphUris,
    () => buildDeduplicatedGraphPattern(input, access, allocate),
  );
}

/** Scope a graph set through a hidden VALUES/GRAPH subquery. */
export function wrapWithGraphValues(
  input: PreparedGraphScope,
  graphUris: readonly string[],
): GraphScopeRewriteResult {
  const access = createGraphAccess('values', [...new Set(graphUris)], createVariableAllocator(input));
  return wrapWithProjectedGraphSubselect(input, graphUris, inner => ({ pattern: access.fallback(inner) }));
}

export type GraphSetRoutingPolicy =
  | 'deduplicated-values-union'
  | 'values-union'
  | 'union-only';

/** Select the first supported graph-set strategy in one canonical order. */
export function rewriteGraphSet(
  scope: PreparedGraphScope,
  graphUris: readonly string[],
  policy: GraphSetRoutingPolicy,
  engine: SparqlEngineFamily | null = null,
): GraphScopeRewriteResult {
  return applyGraphDataset(scope, graphUris, engine, (graphAccess) => {
    const allocate = createVariableAllocator(scope);
    const access = createGraphAccess(graphAccess, [...new Set(graphUris)], allocate);
    const strategies = [wrapWithGraphUnion];
    if (policy !== 'union-only') {
      strategies.unshift((input, graphs) => wrapWithProjectedGraphSubselect(input, graphs, inner => ({ pattern: access.fallback(inner) })));
      if (policy === 'deduplicated-values-union') {
        strategies.unshift((input, graphs) => wrapWithDeduplicatedGraphSelection(input, graphs, access, allocate));
      }
    }
    let last = unsupported('strategy-rejected');
    for (const strategy of strategies) {
      const result = strategy(scope, graphUris);
      if (result.kind === 'ready') return result;
      last = result;
    }
    return last;
  });
}

/** Scope a read to one graph on a store with this engine. */
export function rewriteSingleGraph(scope: PreparedGraphScope, graphUri: string, engine: SparqlEngineFamily | null): GraphScopeRewriteResult {
  return applyGraphDataset(scope, [graphUri], engine, () => wrapWithGraph(scope, graphUri));
}

/** Apply a graph-set policy and its single-graph compatibility fallback. */
export function rewriteGraphRoute(
  scope: PreparedGraphScope,
  graphUris: readonly string[],
  fallbackGraphUri: string,
  policy: GraphSetRoutingPolicy,
  fallbackPolicy: 'compatibility' | 'preserve-scope' = 'compatibility',
  engine: SparqlEngineFamily | null = null,
): GraphScopeRewriteResult {
  if (graphUris.length > 0) {
    const selected = rewriteGraphSet(scope, graphUris, policy, engine);
    if (selected.kind === 'ready') return selected;
    if (fallbackPolicy === 'preserve-scope' && graphUris.some(graph => graph !== fallbackGraphUri)) return selected;
  }
  return rewriteSingleGraph(scope, fallbackGraphUri, engine);
}

/**
 * Return true only for the narrow fail-closed elision shape:
 * `VALUES ?g { <iri> prefix:name ... }` at the outer WHERE level, with every
 * resolved graph already present in the DKG allow-list.
 */
function callerGraphValuesAreAuthorized(
  scope: PreparedGraphScope,
  variableName: string,
  allowedGraphs: ReadonlySet<string>,
): boolean {
  const values = readTopLevelStaticGraphValues(scope, variableName);
  return values !== null && values.every((graph) => allowedGraphs.has(graph));
}

function readTopLevelStaticGraphValues(
  scope: PreparedGraphScope,
  variableName: string,
): string[] | null {
  const where = scope.where;
  if (!where) return null;
  const { tokens } = scope.prepared;
  const outerDepth = scope.structure.braces.depthBefore[where.openingTokenIndex] + 1;

  for (let index = where.openingTokenIndex + 1; index < where.closingTokenIndex; index++) {
    const keyword = tokens[index];
    if (
      scope.structure.braces.depthBefore[index] !== outerDepth
      || keyword.kind !== 'word'
      || keyword.upper !== 'VALUES'
    ) continue;

    const candidate = tokens[index + 1];
    if (
      candidate?.kind !== 'variable'
      || candidate.logicalValue.slice(1) !== variableName
    ) {
      continue;
    }
    const opening = tokens[index + 2];
    if (opening?.kind !== 'symbol' || opening.logicalValue !== '{') {
      return null;
    }
    const closingIndex = scope.structure.braces.matchingTokenIndexes[index + 2] ?? -1;
    if (closingIndex < 0 || closingIndex > where.closingTokenIndex) return null;
    return parseStaticGraphValues(scope, index + 3, closingIndex);
  }

  return null;
}

function parseStaticGraphValues(
  scope: PreparedGraphScope,
  startTokenIndex: number,
  endTokenIndex: number,
): string[] | null {
  const values: string[] = [];
  for (let index = startTokenIndex; index < endTokenIndex; index++) {
    const token = scope.prepared.tokens[index];
    const iri = iriValue(token);
    if (iri !== null) {
      values.push(iri);
      continue;
    }
    if (token.kind !== 'prefixed-name') return null;
    const colon = token.logicalValue.indexOf(':');
    const base = scope.prefixes.get(token.logicalValue.slice(0, colon));
    if (colon < 0 || base === undefined) return null;
    values.push(`${base}${token.logicalValue.slice(colon + 1)}`);
  }
  return values;
}

function nestedSelectContainsGraphVariable(scope: PreparedGraphScope): boolean {
  const { tokens } = scope.prepared;
  const activeSelectDepths: number[] = [];
  const variableGraphKeywords = new Set(scope.graphTargets
    .filter((target) => target.kind === 'variable')
    .map((target) => target.keywordTokenIndex));
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const tokenDepth = scope.structure.braces.depthBefore[index];
    if (
      token.kind === 'symbol'
      && token.logicalValue === '}'
    ) {
      while (
        activeSelectDepths.length > 0
        && activeSelectDepths[activeSelectDepths.length - 1] >= tokenDepth
      ) activeSelectDepths.pop();
      continue;
    }
    if (
      tokenDepth > 0
      && token.kind === 'word'
      && token.upper === 'SELECT'
    ) {
      activeSelectDepths.push(tokenDepth);
      continue;
    }
    if (
      activeSelectDepths.length > 0
      && variableGraphKeywords.has(index)
    ) return true;
  }
  return false;
}

function graphVariablesAreTopLevel(scope: PreparedGraphScope): boolean {
  if (!scope.where) return false;
  const { openingTokenIndex, closingTokenIndex } = scope.where;
  const outerDepth = scope.structure.braces.depthBefore[openingTokenIndex] + 1;
  return scope.graphTargets.every((target) => target.kind !== 'variable'
    || (target.braceDepth === outerDepth
      && target.keywordTokenIndex > openingTokenIndex && target.keywordTokenIndex < closingTokenIndex));
}

/**
 * Constrain every caller-supplied GRAPH variable to the authorized graph set.
 * All structural decisions use the same prepared token coordinates as the
 * dataset and explicit-GRAPH authorization checks above. With `boundByDataset`
 * the read's dataset holds exactly these graphs, so the checks run and no
 * VALUES list is written.
 */
export function constrainGraphVariablesToAllowedSet(
  scope: PreparedGraphScope,
  allowedGraphs: readonly string[],
  { boundByDataset = false }: { boundByDataset?: boolean } = {},
): GraphScopeRewriteResult {
  if (nestedSelectContainsGraphVariable(scope)) {
    throw new ScopedQueryViolationError(
      'GRAPH variables inside nested SELECT subqueries cannot be constrained safely',
    );
  }
  if (scope.graphVariables.length === 0) return ready(transitionGraphScope(scope, scope.source));
  if (!scope.where) {
    return unsupported('missing-where');
  }
  if (!graphVariablesAreTopLevel(scope)) {
    throw new ScopedQueryViolationError(
      'GRAPH variables must appear at the top level of scoped local queries',
    );
  }
  if (hasTopLevelDefaultGraphPattern(scope)) {
    throw new ScopedQueryViolationError(
      'GRAPH variables cannot be mixed with default-graph triple patterns on scoped local queries',
    );
  }

  const allowed = new Set(allowedGraphs);
  const variablesNeedingConstraint = scope.graphVariables.filter(
    (variable) => !callerGraphValuesAreAuthorized(scope, variable.logicalName, allowed),
  );
  if (variablesNeedingConstraint.length === 0 || boundByDataset) {
    return ready(transitionGraphScope(scope, scope.source));
  }

  const values = allowedGraphs.map((graph) => `<${assertSafeIri(graph)}>`).join(' ');
  const constraints = variablesNeedingConstraint
    .map((variable) => `VALUES ${variable.source} { ${values} }`)
    .join(' ');
  return ready(transitionGraphScope(
    scope,
    `${scope.source.slice(0, scope.where.openEnd)} ${constraints} ${scope.source.slice(scope.where.openEnd)}`,
  ));
}
