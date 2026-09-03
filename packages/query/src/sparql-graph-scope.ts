import {
  prepareSparql,
  type PreparedSparql,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { ScopedQueryViolationError } from './scoped-query-error.js';

type ValuedToken = Extract<SparqlLexicalToken, { value: string }>;

function isValuedToken(token: SparqlLexicalToken | undefined): token is ValuedToken {
  return token !== undefined && 'value' in token;
}

function iriValue(token: SparqlLexicalToken | undefined): string | null {
  return token?.kind === 'iri' ? token.logicalValue : null;
}

export interface SparqlWhereRange {
  /** Raw source span of the opening brace token. UCHAR tokens span >1 code unit. */
  readonly openStart: number;
  readonly openEnd: number;
  readonly close: number;
  readonly hasUnion: boolean;
  readonly openingTokenIndex: number;
  readonly closingTokenIndex: number;
}

export interface SparqlGraphTarget {
  readonly kind: 'iri' | 'variable' | 'invalid';
  readonly value?: string;
  readonly keywordTokenIndex: number;
  readonly targetTokenIndex: number;
  readonly braceDepth: number;
}

/** A variable's source spelling and its UCHAR-decoded SPARQL identity. */
export interface SparqlScopeVariable {
  readonly source: string;
  readonly logicalName: string;
}

/**
 * One canonical, source-coordinate model for graph authorization and rewrites.
 * Comments, strings, and IRI payloads have already been made opaque by the RDF
 * scanner; every fact below is derived from that same token stream.
 */
export interface PreparedGraphScope {
  readonly source: string;
  readonly prepared: PreparedSparql;
  readonly prefixes: ReadonlyMap<string, string>;
  readonly where: SparqlWhereRange | null;
  readonly operation: string | null;
  readonly hasDatasetClause: boolean;
  readonly hasGraphClause: boolean;
  readonly graphTargets: readonly SparqlGraphTarget[];
  readonly graphVariables: readonly SparqlScopeVariable[];
  readonly queryVariables: readonly SparqlScopeVariable[];
  readonly whereVariables: readonly SparqlScopeVariable[];
  /** Brace depth immediately before each canonical token. */
  readonly braceDepths: readonly number[];
  /** Matching token index for each `{`/`}`, or `-1` when unmatched/non-brace. */
  readonly matchingBraceTokenIndexes: readonly number[];
}

export type GraphScopeRewriteResult =
  | { readonly kind: 'ready'; readonly scope: PreparedGraphScope }
  | { readonly kind: 'unsupported'; readonly original: PreparedGraphScope };

function ready(scope: PreparedGraphScope): GraphScopeRewriteResult {
  return { kind: 'ready', scope };
}

function unsupported(original: PreparedGraphScope): GraphScopeRewriteResult {
  return { kind: 'unsupported', original };
}

/**
 * Own the state transition after a source edit. A no-op retains object identity;
 * every actual source change is prepared before it leaves this module.
 */
export function transitionGraphScope(
  scope: PreparedGraphScope,
  source: string,
): PreparedGraphScope {
  return source === scope.source ? scope : prepareGraphScope(source);
}

/**
 * Materialize active UCHAR-spelled syntax exactly once at the store boundary.
 * Opaque strings, IRIs, and comments retain their original source spelling.
 */
export function materializeGraphScopeForExecution(scope: PreparedGraphScope): string {
  const chunks: string[] = [];
  let cursor = 0;
  let changed = false;
  for (const token of scope.prepared.tokens) {
    if (!isValuedToken(token)) continue;
    const raw = scope.source.slice(token.start, token.end);
    if (raw === token.logicalValue) continue;
    chunks.push(scope.source.slice(cursor, token.start), token.logicalValue);
    cursor = token.end;
    changed = true;
  }
  if (!changed) return scope.source;
  chunks.push(scope.source.slice(cursor));
  return chunks.join('');
}

function braceStructure(tokens: readonly SparqlLexicalToken[]): {
  depths: number[];
  matching: number[];
} {
  const depths: number[] = [];
  const matching = Array<number>(tokens.length).fill(-1);
  const openings: number[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    depths.push(depth);
    if (!isValuedToken(token) || token.kind !== 'symbol') continue;
    if (token.logicalValue === '{') {
      openings.push(index);
      depth++;
    } else if (token.logicalValue === '}') {
      const opening = openings.pop();
      if (opening !== undefined) {
        matching[opening] = index;
        matching[index] = opening;
      }
      depth--;
    }
  }
  return { depths, matching };
}

function whereRange(
  prepared: PreparedSparql,
  matchingBraceTokenIndexes: readonly number[],
): SparqlWhereRange | null {
  const { tokens } = prepared;
  let depth = 0;
  const topLevelOpenings: number[] = [];
  let explicitOpening = -1;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (
      isValuedToken(token)
      && token.kind === 'word'
      && token.upper === 'WHERE'
      && depth === 0
    ) {
      const next = tokens[index + 1];
      if (!isValuedToken(next) || next.kind !== 'symbol' || next.logicalValue !== '{') {
        return null;
      }
      explicitOpening = index + 1;
      break;
    }
    if (!isValuedToken(token) || token.kind !== 'symbol') continue;
    if (token.logicalValue === '{') {
      if (depth === 0) topLevelOpenings.push(index);
      depth++;
    } else if (token.logicalValue === '}') {
      depth--;
      if (depth < 0) return null;
    }
  }

  const openingIndex = explicitOpening >= 0
    ? explicitOpening
    : depth === 0
      ? (topLevelOpenings.at(-1) ?? -1)
      : -1;
  if (openingIndex < 0) return null;
  const closingIndex = matchingBraceTokenIndexes[openingIndex] ?? -1;
  if (closingIndex < 0) return null;
  const hasUnion = tokens.slice(openingIndex + 1, closingIndex).some(
    (token) => isValuedToken(token) && token.kind === 'word' && token.upper === 'UNION',
  );
  return {
    openStart: tokens[openingIndex].start,
    openEnd: tokens[openingIndex].end,
    close: tokens[closingIndex].start,
    hasUnion,
    openingTokenIndex: openingIndex,
    closingTokenIndex: closingIndex,
  };
}

function prefixesFromTokens(prepared: PreparedSparql): Map<string, string> {
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
  source: string,
  prepared: PreparedSparql = prepareSparql(source),
): PreparedGraphScope {
  const prefixes = prefixesFromTokens(prepared);
  const { depths, matching } = braceStructure(prepared.tokens);
  const graphTargets: SparqlGraphTarget[] = [];
  const graphVariables: SparqlScopeVariable[] = [];
  const graphVariableSet = new Set<string>();
  const queryVariables: SparqlScopeVariable[] = [];
  const queryVariableSet = new Set<string>();
  let hasDatasetClause = false;

  for (let index = 0; index < prepared.tokens.length; index++) {
    const token = prepared.tokens[index];
    if (isValuedToken(token) && token.kind === 'variable') {
      const logicalName = token.logicalValue.slice(1);
      if (!queryVariableSet.has(logicalName)) {
        queryVariableSet.add(logicalName);
        queryVariables.push({ source: token.value, logicalName });
      }
    }
    if (!isValuedToken(token) || token.kind !== 'word') continue;
    if (token.upper === 'FROM') hasDatasetClause = true;
    if (token.upper !== 'GRAPH') continue;

    const target = prepared.tokens[index + 1];
    if (isValuedToken(target) && target.kind === 'variable') {
      graphTargets.push({
        kind: 'variable',
        value: target.logicalValue,
        keywordTokenIndex: index,
        targetTokenIndex: index + 1,
        braceDepth: depths[index],
      });
      const logicalName = target.logicalValue.slice(1);
      if (!graphVariableSet.has(logicalName)) {
        graphVariableSet.add(logicalName);
        graphVariables.push({ source: target.value, logicalName });
      }
      continue;
    }

    const directIri = iriValue(target);
    if (directIri !== null) {
      graphTargets.push({
        kind: 'iri',
        value: directIri,
        keywordTokenIndex: index,
        targetTokenIndex: index + 1,
        braceDepth: depths[index],
      });
      continue;
    }

    if (isValuedToken(target) && target.kind === 'prefixed-name') {
      const colon = target.logicalValue.indexOf(':');
      const base = prefixes.get(target.logicalValue.slice(0, colon));
      if (colon >= 0 && base !== undefined) {
        graphTargets.push({
          kind: 'iri',
          value: `${base}${target.logicalValue.slice(colon + 1)}`,
          keywordTokenIndex: index,
          targetTokenIndex: index + 1,
          braceDepth: depths[index],
        });
        continue;
      }
    }

    graphTargets.push({
      kind: 'invalid',
      keywordTokenIndex: index,
      targetTokenIndex: index + 1,
      braceDepth: depths[index],
    });
  }

  const operationToken = prepared.tokens[prepared.prologue.endTokenIndex];
  const where = whereRange(prepared, matching);
  const whereVariables: SparqlScopeVariable[] = [];
  const whereVariableSet = new Set<string>();
  if (where) {
    for (let index = where.openingTokenIndex + 1; index < where.closingTokenIndex; index++) {
      const token = prepared.tokens[index];
      if (
        isValuedToken(token)
        && token.kind === 'variable'
        && !whereVariableSet.has(token.logicalValue.slice(1))
      ) {
        const logicalName = token.logicalValue.slice(1);
        whereVariableSet.add(logicalName);
        whereVariables.push({ source: token.value, logicalName });
      }
    }
  }
  return {
    source,
    prepared,
    prefixes,
    where,
    operation: isValuedToken(operationToken) && operationToken.kind === 'word'
      ? operationToken.upper
      : null,
    hasDatasetClause,
    hasGraphClause: graphTargets.length > 0,
    graphTargets,
    graphVariables,
    queryVariables,
    whereVariables,
    braceDepths: depths,
    matchingBraceTokenIndexes: matching,
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
    if (target.kind === 'invalid') {
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
    if (target.kind === 'iri' && target.value !== undefined && !allowed.has(target.value)) {
      throw new ScopedQueryViolationError(
        `GRAPH <${target.value}> is outside the allowed graph set`,
      );
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
): PreparedGraphScope {
  if (scope.hasGraphClause) return transitionGraphScope(scope, scope.source);
  if (!scope.where) {
    const describe = scopeGraphlessDescribe(scope, [graphUri]);
    if (describe !== null) return transitionGraphScope(scope, describe);
    throw new ScopedQueryViolationError('unable to locate a graph-scopable WHERE block');
  }
  const { openEnd, close } = scope.where;
  const before = scope.source.slice(0, openEnd);
  const inner = scope.source.slice(openEnd, close);
  const after = scope.source.slice(close);
  return transitionGraphScope(
    scope,
    `${before} GRAPH <${assertSafeIri(graphUri)}> { ${inner} } ${after}`,
  );
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
    throw new ScopedQueryViolationError('unable to locate a graph-scopable WHERE block');
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
  if (hasUnion) return unsupported(scope);
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
  if (!scope.where) return unsupported(scope);

  const { openEnd, close, hasUnion } = scope.where;
  const inner = scope.source.slice(openEnd, close);
  const graphs = [...new Set(graphUris)];
  if (graphs.length === 1) {
    return ready(transitionGraphScope(
      scope,
      `${scope.source.slice(0, openEnd)} GRAPH <${assertSafeIri(graphs[0])}> { ${inner} } ${scope.source.slice(close)}`,
    ));
  }
  if (hasUnion || !acceptsScope(scope)) return unsupported(scope);

  const helperNames = new Set(helperVariables.map((variable) => variable.slice(1)));
  if (scope.queryVariables.some((variable) => helperNames.has(variable.logicalName))) {
    return unsupported(scope);
  }

  const innerVariables = scope.whereVariables;
  if (innerVariables.length === 0) return unsupported(scope);
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
  const outerDepth = scope.braceDepths[where.openingTokenIndex] + 1;

  for (let index = where.openingTokenIndex + 1; index < where.closingTokenIndex; index++) {
    const keyword = tokens[index];
    if (
      scope.braceDepths[index] !== outerDepth
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
    const closingIndex = scope.matchingBraceTokenIndexes[index + 2] ?? -1;
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
    const tokenDepth = scope.braceDepths[index];
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
  const outerDepth = scope.braceDepths[scope.where.openingTokenIndex] + 1;
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
      scope.braceDepths[index] === depth
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
  const contentDepth = scope.braceDepths[openingIndex] + 1;
  let firstIndex = -1;
  for (let index = openingIndex + 1; index < closingIndex; index++) {
    if (scope.braceDepths[index] === contentDepth) {
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
        scope.braceDepths[index] === contentDepth
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
    const nestedClosing = scope.matchingBraceTokenIndexes[nestedOpening] ?? -1;
    return nestedClosing < 0 || groupHasDefaultGraphPattern(scope, nestedOpening, nestedClosing);
  }

  for (let index = openingIndex + 1; index < closingIndex; index++) {
    if (scope.braceDepths[index] !== contentDepth) continue;
    const token = tokens[index];
    if (!isValuedToken(token)) return true;

    if (token.kind === 'word' && token.upper === 'GRAPH') {
      const graphOpening = nextGroupOpening(scope, index + 2, closingIndex, contentDepth);
      if (graphOpening < 0) return true;
      const graphClosing = scope.matchingBraceTokenIndexes[graphOpening] ?? -1;
      if (graphClosing < 0) return true;
      index = graphClosing;
      continue;
    }
    if (token.kind === 'word' && token.upper === 'VALUES') {
      const valuesOpening = nextGroupOpening(scope, index + 1, closingIndex, contentDepth);
      if (valuesOpening < 0) return true;
      const valuesClosing = scope.matchingBraceTokenIndexes[valuesOpening] ?? -1;
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
          const nestedClosing = scope.matchingBraceTokenIndexes[nested] ?? -1;
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
      const nestedClosing = scope.matchingBraceTokenIndexes[nestedOpening] ?? -1;
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
      const nestedClosing = scope.matchingBraceTokenIndexes[index] ?? -1;
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
): PreparedGraphScope {
  if (nestedSelectContainsGraphVariable(scope)) {
    throw new ScopedQueryViolationError(
      'GRAPH variables inside nested SELECT subqueries cannot be constrained safely',
    );
  }
  if (scope.graphVariables.length === 0) return transitionGraphScope(scope, scope.source);
  if (!scope.where) {
    throw new ScopedQueryViolationError(
      'GRAPH variables cannot be constrained because the WHERE block could not be located',
    );
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
    return transitionGraphScope(scope, scope.source);
  }

  const values = allowedGraphs.map((graph) => `<${assertSafeIri(graph)}>`).join(' ');
  const constraints = variablesNeedingConstraint
    .map((variable) => `VALUES ${variable.source} { ${values} }`)
    .join(' ');
  return transitionGraphScope(
    scope,
    `${scope.source.slice(0, scope.where.openEnd)} ${constraints} ${scope.source.slice(scope.where.openEnd)}`,
  );
}
