import {
  prepareSparqlQuery,
  prepareSparql,
  type PreparedSparqlQuery,
  type SparqlQueryVariable,
  type SparqlLexicalToken,
  type ValidPreparedSparql,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  sparqlRewriteReady,
  sparqlRewriteUnsupported,
  type SparqlRewriteResult,
} from './sparql-rewrite-result.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';

type ValuedToken = Extract<SparqlLexicalToken, { value: string }>;

function isValuedToken(token: SparqlLexicalToken | undefined): token is ValuedToken {
  return token !== undefined && 'value' in token;
}

function iriValue(token: SparqlLexicalToken | undefined): string | null {
  return token?.kind === 'iri' ? token.logicalValue : null;
}

function assertNeverGraphTarget(target: never): never {
  throw new ScopedQueryViolationError(
    `unrecognized prepared GRAPH target: ${JSON.stringify(target)}`,
  );
}

interface SparqlGraphTargetCoordinates {
  readonly keywordTokenIndex: number;
  readonly targetTokenIndex: number;
  readonly braceDepth: number;
}

export type SparqlGraphTarget = SparqlGraphTargetCoordinates & (
  | { readonly kind: 'iri'; readonly iri: string }
  | { readonly kind: 'variable'; readonly variable: SparqlQueryVariable }
  | { readonly kind: 'invalid' }
);

/**
 * One canonical, source-coordinate model for graph authorization and rewrites.
 * Comments, strings, and IRI payloads have already been made opaque by the RDF
 * scanner; every fact below is derived from that same token stream.
 */
export interface PreparedGraphScope extends PreparedSparqlQuery {
  readonly prefixes: ReadonlyMap<string, string>;
  readonly hasDatasetClause: boolean;
  readonly hasGraphClause: boolean;
  readonly graphTargets: readonly SparqlGraphTarget[];
  readonly graphVariables: readonly SparqlQueryVariable[];
}

export type GraphScopeRewriteResult = SparqlRewriteResult<
  PreparedGraphScope,
  GraphScopeUnsupportedReason
>;

export type GraphScopeUnsupportedReason =
  | 'missing-where'
  | 'nested-union'
  | 'strategy-rejected'
  | 'helper-variable-collision'
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

/**
 * Own the state transition after a source edit. A no-op retains object identity;
 * every actual source change is prepared before it leaves this module.
 */
export function transitionGraphScope(
  scope: PreparedGraphScope,
  source: string,
): PreparedGraphScope {
  if (source === scope.source) return scope;
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') {
    throw new ScopedQueryViolationError('graph rewrite produced malformed SPARQL');
  }
  return prepareGraphScope(prepared);
}

function prefixesFromTokens(prepared: ValidPreparedSparql): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (let index = 0; index + 2 < prepared.prologue.endTokenIndex; index++) {
    const keyword = prepared.tokens[index];
    const name = prepared.tokens[index + 1];
    const iri = prepared.tokens[index + 2];
    if (
      !isValuedToken(keyword)
      || keyword.kind !== 'word'
      || keyword.upper !== 'PREFIX'
      || !isValuedToken(name)
      || name.kind !== 'prefixed-name'
      || !name.logicalValue.endsWith(':')
    ) continue;
    const declaredIri = iriValue(iri);
    if (declaredIri !== null) prefixes.set(name.logicalValue.slice(0, -1), declaredIri);
    index += 2;
  }
  return prefixes;
}

export function prepareGraphScope(
  input: ValidPreparedSparql,
): PreparedGraphScope {
  const query = prepareSparqlQuery(input);
  const { prepared } = query;
  const prefixes = prefixesFromTokens(prepared);
  const braceDepths = query.structure.braces.depthBefore;
  const graphTargets: SparqlGraphTarget[] = [];
  const graphVariables: SparqlQueryVariable[] = [];
  const graphVariableSet = new Set<string>();
  let hasDatasetClause = false;

  for (let index = 0; index < prepared.tokens.length; index++) {
    const token = prepared.tokens[index];
    if (!isValuedToken(token) || token.kind !== 'word') continue;
    if (token.upper === 'FROM') hasDatasetClause = true;
    if (token.upper !== 'GRAPH') continue;

    const target = prepared.tokens[index + 1];
    if (isValuedToken(target) && target.kind === 'variable') {
      const variable = {
        source: target.value,
        logicalName: target.logicalValue.slice(1),
      };
      graphTargets.push({
        kind: 'variable',
        variable,
        keywordTokenIndex: index,
        targetTokenIndex: index + 1,
        braceDepth: braceDepths[index],
      });
      if (!graphVariableSet.has(variable.logicalName)) {
        graphVariableSet.add(variable.logicalName);
        graphVariables.push(variable);
      }
      continue;
    }

    const directIri = iriValue(target);
    if (directIri !== null) {
      graphTargets.push({
        kind: 'iri',
        iri: directIri,
        keywordTokenIndex: index,
        targetTokenIndex: index + 1,
        braceDepth: braceDepths[index],
      });
      continue;
    }

    if (isValuedToken(target) && target.kind === 'prefixed-name') {
      const colon = target.logicalValue.indexOf(':');
      const base = prefixes.get(target.logicalValue.slice(0, colon));
      if (colon >= 0 && base !== undefined) {
        graphTargets.push({
          kind: 'iri',
          iri: `${base}${target.logicalValue.slice(colon + 1)}`,
          keywordTokenIndex: index,
          targetTokenIndex: index + 1,
          braceDepth: braceDepths[index],
        });
        continue;
      }
    }

    graphTargets.push({
      kind: 'invalid',
      keywordTokenIndex: index,
      targetTokenIndex: index + 1,
      braceDepth: braceDepths[index],
    });
  }

  return {
    ...query,
    prefixes,
    hasDatasetClause,
    hasGraphClause: graphTargets.length > 0,
    graphTargets,
    graphVariables,
  };
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
        if (isValuedToken(token) && token.kind === 'prefixed-name') {
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

function scopeGraphlessDescribe(
  scope: PreparedGraphScope,
  graphUris: readonly string[],
): string | null {
  if (scope.operation !== 'DESCRIBE' || scope.where !== null) return null;
  if (scope.prepared.tokens.some(
    (token) => isValuedToken(token) && token.kind === 'symbol' && token.logicalValue === '{',
  )) return null;

  const operationIndex = scope.prepared.prologue.endTokenIndex;
  const tokens = scope.prepared.tokens.slice(operationIndex);
  const modifiers = new Set(['GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET']);
  const modifier = tokens.slice(1).find(
    (token) => isValuedToken(token) && token.kind === 'word' && modifiers.has(token.upper),
  );
  const last = tokens.at(-1);
  const insertion = modifier?.start ?? last?.end ?? scope.prepared.tokens[operationIndex]?.end;
  if (insertion === undefined) return null;
  const clauses = graphUris.map((graph) => `FROM <${assertSafeIri(graph)}>`).join(' ');
  return `${scope.source.slice(0, insertion)} ${clauses} ${scope.source.slice(insertion)}`;
}

export function wrapWithGraph(
  scope: PreparedGraphScope,
  graphUri: string,
): GraphScopeRewriteResult {
  if (scope.hasGraphClause) return ready(transitionGraphScope(scope, scope.source));
  if (!scope.where) {
    const describe = scopeGraphlessDescribe(scope, [graphUri]);
    if (describe !== null) return ready(transitionGraphScope(scope, describe));
    return unsupported('missing-where');
  }
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
  if (!scope.where) {
    const describe = scopeGraphlessDescribe(scope, graphUris);
    if (describe !== null) return ready(transitionGraphScope(scope, describe));
    return unsupported('missing-where');
  }
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
  const branches = graphUris
    .map((graph) => `{ GRAPH <${assertSafeIri(graph)}> { ${inner} } }`)
    .join(' UNION ');
  return ready(transitionGraphScope(scope, `${before} ${branches} ${after}`));
}

const VIEW_GRAPH_SENTINEL = '?__dkgViewGraph';
const DEDUP_GRAPH_SENTINEL = '?__dkgDedupGraph';
const DEDUP_RANK_SENTINEL = '?__dkgDedupRank';
const DEDUP_PRIOR_GRAPH_SENTINEL = '?__dkgDedupPriorGraph';
const DEDUP_PRIOR_RANK_SENTINEL = '?__dkgDedupPriorRank';

function wrapWithProjectedGraphSubselect(
  scope: PreparedGraphScope,
  graphUris: readonly string[],
  helperVariables: readonly string[],
  buildGraphPattern: (inner: string, graphs: readonly string[]) => string,
  acceptsScope: (scope: PreparedGraphScope) => boolean = () => true,
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
  if (!acceptsScope(scope)) return unsupported('strategy-rejected');

  const helperNames = new Set(helperVariables.map((variable) => variable.slice(1)));
  if (scope.queryVariables.some((variable) => helperNames.has(variable.logicalName))) {
    return unsupported('helper-variable-collision');
  }

  const innerVariables = scope.whereVariables;
  if (innerVariables.length === 0) return unsupported('no-projected-variables');
  const graphPattern = buildGraphPattern(inner, graphs);
  return ready(transitionGraphScope(
    scope,
    `${scope.source.slice(0, openEnd)} { SELECT ${innerVariables.map((variable) => variable.source).join(' ')} WHERE { ${graphPattern} } } ${scope.source.slice(close)}`,
  ));
}

function isDedupSafeBasicGraphPattern(scope: PreparedGraphScope): boolean {
  if (!scope.where) return false;
  const forbidden = new Set([
    'OPTIONAL', 'MINUS', 'SERVICE', 'VALUES', 'BIND', 'SELECT', 'GRAPH', 'EXISTS',
  ]);
  return !scope.prepared.tokens
    .slice(scope.where.openingTokenIndex + 1, scope.where.closingTokenIndex)
    .some((token) => isValuedToken(token) && (
    (token.kind === 'word' && forbidden.has(token.upper))
    || (token.kind === 'symbol' && (token.logicalValue === '{' || token.logicalValue === '}'))
    ));
}

/** Scope a graph set while suppressing mappings already emitted by an earlier graph. */
export function wrapWithDeduplicatedGraphValues(
  input: PreparedGraphScope,
  graphUris: readonly string[],
): GraphScopeRewriteResult {
  return wrapWithProjectedGraphSubselect(
    input,
    graphUris,
    [
      DEDUP_GRAPH_SENTINEL,
      DEDUP_RANK_SENTINEL,
      DEDUP_PRIOR_GRAPH_SENTINEL,
      DEDUP_PRIOR_RANK_SENTINEL,
    ],
    (inner, graphs) => {
      const rows = graphs
        .map((graph, rank) => `(<${assertSafeIri(graph)}> ${rank})`)
        .join(' ');
      return [
        `VALUES (${DEDUP_GRAPH_SENTINEL} ${DEDUP_RANK_SENTINEL}) { ${rows} }`,
        `GRAPH ${DEDUP_GRAPH_SENTINEL} { ${inner} }`,
        'FILTER NOT EXISTS {',
        `  VALUES (${DEDUP_PRIOR_GRAPH_SENTINEL} ${DEDUP_PRIOR_RANK_SENTINEL}) { ${rows} }`,
        `  FILTER (${DEDUP_PRIOR_RANK_SENTINEL} < ${DEDUP_RANK_SENTINEL})`,
        `  GRAPH ${DEDUP_PRIOR_GRAPH_SENTINEL} { ${inner} }`,
        '}',
      ].join(' ');
    },
    isDedupSafeBasicGraphPattern,
  );
}

/** Scope a graph set through a hidden VALUES/GRAPH subquery. */
export function wrapWithGraphValues(
  input: PreparedGraphScope,
  graphUris: readonly string[],
): GraphScopeRewriteResult {
  return wrapWithProjectedGraphSubselect(
    input,
    graphUris,
    [VIEW_GRAPH_SENTINEL],
    (inner, graphs) => {
      const values = graphs.map((graph) => `<${assertSafeIri(graph)}>`).join(' ');
      return `VALUES ${VIEW_GRAPH_SENTINEL} { ${values} } GRAPH ${VIEW_GRAPH_SENTINEL} { ${inner} }`;
    },
  );
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
): GraphScopeRewriteResult {
  const strategies = policy === 'deduplicated-values-union'
    ? [wrapWithDeduplicatedGraphValues, wrapWithGraphValues, wrapWithGraphUnion]
    : policy === 'values-union'
      ? [wrapWithGraphValues, wrapWithGraphUnion]
      : [wrapWithGraphUnion];
  let last = unsupported('strategy-rejected');
  for (const strategy of strategies) {
    const result = strategy(scope, graphUris);
    if (result.kind === 'ready') return result;
    last = result;
  }
  return last;
}

/** Apply a graph-set policy and its single-graph compatibility fallback. */
export function rewriteGraphRoute(
  scope: PreparedGraphScope,
  graphUris: readonly string[],
  fallbackGraphUri: string,
  policy: GraphSetRoutingPolicy,
): GraphScopeRewriteResult {
  if (graphUris.length > 0) {
    const selected = rewriteGraphSet(scope, graphUris, policy);
    if (selected.kind === 'ready') return selected;
  }
  return wrapWithGraph(scope, fallbackGraphUri);
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
      || !isValuedToken(keyword)
      || keyword.kind !== 'word'
      || keyword.upper !== 'VALUES'
    ) continue;

    const candidate = tokens[index + 1];
    if (
      !isValuedToken(candidate)
      || candidate.kind !== 'variable'
      || candidate.logicalValue.slice(1) !== variableName
    ) {
      continue;
    }
    const opening = tokens[index + 2];
    if (!isValuedToken(opening) || opening.kind !== 'symbol' || opening.logicalValue !== '{') {
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
    if (!isValuedToken(token) || token.kind !== 'prefixed-name') return null;
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
      isValuedToken(token)
      && token.kind === 'symbol'
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
      && isValuedToken(token)
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
  const outerDepth = scope.structure.braces.depthBefore[scope.where.openingTokenIndex] + 1;
  return scope.graphTargets.every(
    (target) => target.kind !== 'variable' || target.braceDepth === outerDepth,
  );
}

function findBalancedParenthesisEnd(
  tokens: readonly SparqlLexicalToken[],
  openingIndex: number,
  limit: number,
): number {
  let depth = 0;
  for (let index = openingIndex; index < limit; index++) {
    const token = tokens[index];
    if (!isValuedToken(token) || token.kind !== 'symbol') continue;
    if (token.logicalValue === '(') depth++;
    else if (token.logicalValue === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function hasTopLevelDefaultGraphPattern(scope: PreparedGraphScope): boolean {
  const where = scope.where;
  if (!where) return true;
  return groupHasDefaultGraphPattern(
    scope,
    where.openingTokenIndex,
    where.closingTokenIndex,
  );
}

function nextGroupOpening(
  scope: PreparedGraphScope,
  start: number,
  limit: number,
  depth: number,
): number {
  for (let index = start; index < limit; index++) {
    const token = scope.prepared.tokens[index];
    if (
      scope.structure.braces.depthBefore[index] === depth
      && isValuedToken(token)
      && token.kind === 'symbol'
      && token.logicalValue === '{'
    ) return index;
  }
  return -1;
}

function groupHasDefaultGraphPattern(
  scope: PreparedGraphScope,
  openingIndex: number,
  closingIndex: number,
): boolean {
  const { tokens } = scope.prepared;
  const contentDepth = scope.structure.braces.depthBefore[openingIndex] + 1;
  let firstIndex = -1;
  for (let index = openingIndex + 1; index < closingIndex; index++) {
    if (scope.structure.braces.depthBefore[index] === contentDepth) {
      firstIndex = index;
      break;
    }
  }
  const first = firstIndex >= 0 ? tokens[firstIndex] : undefined;

  // A nested SELECT's projection is not a default-graph pattern. Analyze only
  // its WHERE group (or shorthand group), using the same token coordinates.
  if (isValuedToken(first) && first.kind === 'word' && first.upper === 'SELECT') {
    let searchStart = firstIndex + 1;
    for (let index = searchStart; index < closingIndex; index++) {
      const token = tokens[index];
      if (
        scope.structure.braces.depthBefore[index] === contentDepth
        && isValuedToken(token)
        && token.kind === 'word'
        && token.upper === 'WHERE'
      ) {
        searchStart = index + 1;
        break;
      }
    }
    const nestedOpening = nextGroupOpening(scope, searchStart, closingIndex, contentDepth);
    if (nestedOpening < 0) return true;
    const nestedClosing = scope.structure.braces.matchingTokenIndexes[nestedOpening] ?? -1;
    return nestedClosing < 0 || groupHasDefaultGraphPattern(scope, nestedOpening, nestedClosing);
  }

  for (let index = openingIndex + 1; index < closingIndex; index++) {
    if (scope.structure.braces.depthBefore[index] !== contentDepth) continue;
    const token = tokens[index];
    if (!isValuedToken(token)) return true;

    if (token.kind === 'word' && token.upper === 'GRAPH') {
      const graphOpening = nextGroupOpening(scope, index + 2, closingIndex, contentDepth);
      if (graphOpening < 0) return true;
      const graphClosing = scope.structure.braces.matchingTokenIndexes[graphOpening] ?? -1;
      if (graphClosing < 0) return true;
      index = graphClosing;
      continue;
    }
    if (token.kind === 'word' && token.upper === 'VALUES') {
      const valuesOpening = nextGroupOpening(scope, index + 1, closingIndex, contentDepth);
      if (valuesOpening < 0) return true;
      const valuesClosing = scope.structure.braces.matchingTokenIndexes[valuesOpening] ?? -1;
      if (valuesClosing < 0) return true;
      index = valuesClosing;
      continue;
    }
    if (token.kind === 'word' && (token.upper === 'FILTER' || token.upper === 'BIND')) {
      const expressionOpening = tokens[index + 1];
      if (
        !isValuedToken(expressionOpening)
        || expressionOpening.kind !== 'symbol'
        || expressionOpening.logicalValue !== '('
      ) return true;
      const expressionClosing = findBalancedParenthesisEnd(tokens, index + 1, closingIndex);
      if (expressionClosing < 0) return true;
      for (let nested = index + 2; nested < expressionClosing; nested++) {
        const candidate = tokens[nested];
        if (
          isValuedToken(candidate)
          && candidate.kind === 'symbol'
          && candidate.logicalValue === '{'
        ) {
          const nestedClosing = scope.structure.braces.matchingTokenIndexes[nested] ?? -1;
          if (nestedClosing < 0 || groupHasDefaultGraphPattern(scope, nested, nestedClosing)) {
            return true;
          }
          nested = nestedClosing;
        }
      }
      index = expressionClosing;
      continue;
    }
    if (token.kind === 'word' && (token.upper === 'OPTIONAL' || token.upper === 'MINUS')) {
      const nestedOpening = nextGroupOpening(scope, index + 1, closingIndex, contentDepth);
      if (nestedOpening < 0) return true;
      const nestedClosing = scope.structure.braces.matchingTokenIndexes[nestedOpening] ?? -1;
      if (nestedClosing < 0 || groupHasDefaultGraphPattern(scope, nestedOpening, nestedClosing)) {
        return true;
      }
      index = nestedClosing;
      continue;
    }
    if (token.kind === 'word' && token.upper === 'UNION') continue;
    if (token.kind === 'word' && (token.upper === 'SERVICE' || token.upper === 'SELECT')) {
      return true;
    }
    if (token.kind === 'symbol' && token.logicalValue === '{') {
      const nestedClosing = scope.structure.braces.matchingTokenIndexes[index] ?? -1;
      if (nestedClosing < 0 || groupHasDefaultGraphPattern(scope, index, nestedClosing)) return true;
      index = nestedClosing;
      continue;
    }
    if (token.kind === 'symbol' && ['.', ';', ','].includes(token.logicalValue)) continue;
    return true;
  }
  return false;
}

/**
 * Constrain every caller-supplied GRAPH variable to the authorized graph set.
 * All structural decisions use the same prepared token coordinates as the
 * dataset and explicit-GRAPH authorization checks above.
 */
export function constrainGraphVariablesToAllowedSet(
  scope: PreparedGraphScope,
  allowedGraphs: readonly string[],
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
  if (variablesNeedingConstraint.length === 0) {
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
