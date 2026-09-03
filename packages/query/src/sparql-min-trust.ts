import { TRUST_LEVEL_PREDICATE } from '@origintrail-official/dkg-core';
import {
  sparqlTokenIndexesAtDepth,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import {
  sparqlRewriteReady,
  sparqlRewriteUnsupported,
  type PreparedSparqlQuery,
  type SparqlRewriteResult,
} from './prepared-sparql-query.js';

type SourceSparqlToken = Extract<SparqlLexicalToken, { value: string }>;

function isSourceSparqlToken(
  token: SparqlLexicalToken | undefined,
): token is SourceSparqlToken {
  return token !== undefined && 'value' in token;
}

interface MinTrustBodyScan {
  readonly valuesClause: string | null;
  readonly bodySource: string;
  readonly bodyTokenStart: number;
  readonly bodyTokenEnd: number;
}

/** Locate the flat BGP that the min-trust policy can safely augment. */
function scanMinTrustBody(scope: PreparedSparqlQuery): MinTrustBodyScan | null {
  const { where } = scope;
  if (
    !where
    || !scope.structure.braces.balanced
    || !scope.structure.parentheses.balanced
    || !scope.structure.brackets.balanced
  ) return null;

  const { tokens } = scope.prepared;
  const bodyEnd = where.closingTokenIndex;
  let bodyTokenStart = where.openingTokenIndex + 1;
  let bodySourceStart = where.openEnd;
  let valuesClause: string | null = null;

  const first = tokens[bodyTokenStart];
  if (isSourceSparqlToken(first) && first.kind === 'word' && first.upper === 'VALUES') {
    const variable = tokens[bodyTokenStart + 1];
    const opening = tokens[bodyTokenStart + 2];
    if (
      !isSourceSparqlToken(variable)
      || variable.kind !== 'variable'
      || !isSourceSparqlToken(opening)
      || opening.kind !== 'symbol'
      || opening.logicalValue !== '{'
    ) return null;

    const valuesOpeningIndex = bodyTokenStart + 2;
    const valuesClosingIndex = scope.structure.braces.matchingTokenIndexes[valuesOpeningIndex]
      ?? -1;
    if (valuesClosingIndex <= valuesOpeningIndex || valuesClosingIndex >= bodyEnd) return null;

    for (let index = valuesOpeningIndex + 1; index < valuesClosingIndex; index++) {
      const token = tokens[index];
      if (
        isSourceSparqlToken(token)
        && token.kind === 'symbol'
        && ['{', '}', '(', ')'].includes(token.logicalValue)
      ) return null;
    }

    const closing = tokens[valuesClosingIndex];
    valuesClause = scope.source.slice(where.openEnd, closing.end).trim();
    bodyTokenStart = valuesClosingIndex + 1;
    bodySourceStart = closing.end;
  }

  const bodyDepth = scope.structure.braces.depthBefore[where.openingTokenIndex] + 1;
  const forbiddenWords = new Set([
    'GRAPH',
    'OPTIONAL',
    'UNION',
    'MINUS',
    'SERVICE',
    'VALUES',
    'SELECT',
  ]);
  const bodyTokenIndexes = sparqlTokenIndexesAtDepth(
    scope.structure.braces,
    bodyDepth,
    bodyTokenStart,
    bodyEnd,
  );
  if (bodyTokenIndexes.length !== bodyEnd - bodyTokenStart) return null;
  for (const index of bodyTokenIndexes) {
    const token = tokens[index];
    if (!isSourceSparqlToken(token)) continue;
    if (token.kind === 'symbol' && (token.logicalValue === '{' || token.logicalValue === '}')) {
      return null;
    }
    if (token.kind === 'word' && forbiddenWords.has(token.upper)) return null;
  }

  return {
    valuesClause,
    bodySource: scope.source.slice(bodySourceStart, where.close),
    bodyTokenStart,
    bodyTokenEnd: bodyEnd,
  };
}

function isDecimalPoint(tokens: readonly SparqlLexicalToken[], index: number): boolean {
  const previous = tokens[index - 1];
  const point = tokens[index];
  const next = tokens[index + 1];
  return isSourceSparqlToken(previous)
    && isSourceSparqlToken(point)
    && isSourceSparqlToken(next)
    && previous.end === point.start
    && point.end === next.start
    && /^\d$/u.test(previous.logicalValue)
    && /^\d$/u.test(next.logicalValue);
}

function skipMinTrustExpression(
  scope: PreparedSparqlQuery,
  start: number,
  end: number,
): number | null {
  const { tokens } = scope.prepared;
  let opening = start + 1;
  while (opening < end) {
    const token = tokens[opening];
    if (
      isSourceSparqlToken(token)
      && token.kind === 'symbol'
      && token.logicalValue === '('
    ) break;
    if (
      isSourceSparqlToken(token)
      && token.kind === 'symbol'
      && token.logicalValue === '.'
    ) return null;
    opening++;
  }
  if (opening >= end) return null;
  const closing = scope.structure.parentheses.matchingTokenIndexes[opening] ?? -1;
  return closing >= opening && closing < end ? closing + 1 : null;
}

/** Collect subject tokens in the supported flat group pattern. */
function minTrustSubjectTokens(
  scope: PreparedSparqlQuery,
  body: MinTrustBodyScan,
): SparqlLexicalToken[] | null {
  const { tokens } = scope.prepared;
  const subjects: SparqlLexicalToken[] = [];
  let expectSubject = true;
  let index = body.bodyTokenStart;
  while (index < body.bodyTokenEnd) {
    const token = tokens[index];

    if (
      isSourceSparqlToken(token)
      && token.kind === 'word'
      && (token.upper === 'FILTER' || token.upper === 'BIND')
    ) {
      const next = skipMinTrustExpression(scope, index, body.bodyTokenEnd);
      if (next === null) return null;
      expectSubject = true;
      index = next;
      continue;
    }

    if (
      isSourceSparqlToken(token)
      && token.kind === 'symbol'
      && token.logicalValue === '.'
      && !isDecimalPoint(tokens, index)
    ) {
      expectSubject = true;
      index++;
      continue;
    }

    if (
      isSourceSparqlToken(token)
      && token.kind === 'symbol'
      && ['(', ')', '[', ']'].includes(token.logicalValue)
    ) return null;

    if (expectSubject) {
      subjects.push(token);
      expectSubject = false;
    }
    index++;
  }
  return subjects;
}

/**
 * Add trust metadata requirements for every subject in one supported flat BGP.
 * Unsupported or structurally ambiguous shapes are returned for fail-closed
 * handling by the query engine.
 */
export function injectMinTrustFilter(
  query: PreparedSparqlQuery,
  minTrust: number,
): MinTrustRewriteResult {
  const unsupported = (): MinTrustRewriteResult => sparqlRewriteUnsupported(
    query,
    'unsupported-query-shape',
  );
  const bodyStart = query.where?.openEnd ?? -1;
  const braceEnd = query.where?.close ?? -1;
  const body = scanMinTrustBody(query);
  if (bodyStart < 0 || braceEnd < 0 || !body) return unsupported();

  const trimmedInner = body.bodySource.trim();
  if (trimmedInner.length === 0) return unsupported();

  const subjectTokens = minTrustSubjectTokens(query, body);
  if (!subjectTokens) return unsupported();
  const subjects = new Map<string, string>();
  for (const token of subjectTokens) {
    if (isSourceSparqlToken(token) && token.kind === 'variable') {
      subjects.set(`variable:${token.logicalValue.slice(1)}`, token.value);
      continue;
    }
    if (token.kind === 'iri') {
      subjects.set(
        `iri:${token.logicalValue}`,
        query.source.slice(token.start, token.end),
      );
      continue;
    }
    if (
      isSourceSparqlToken(token)
      && token.kind === 'prefixed-name'
      && !token.logicalValue.startsWith('_:')
    ) {
      subjects.set(`prefixed:${token.logicalValue}`, token.value);
      continue;
    }
    return unsupported();
  }
  if (subjects.size === 0) return unsupported();

  const extraClauses: string[] = [];
  const usedVariableNames = new Set(
    query.queryVariables.map((variable) => variable.logicalName),
  );
  let helperIndex = 0;
  for (const subject of subjects.values()) {
    let helperName: string;
    do {
      helperName = `__dkgTrust${helperIndex++}`;
    } while (usedVariableNames.has(helperName));
    usedVariableNames.add(helperName);
    const trustVar = `?${helperName}`;
    extraClauses.push(
      `${subject} <${TRUST_LEVEL_PREDICATE}> ${trustVar} . `
        + `FILTER(<http://www.w3.org/2001/XMLSchema#integer>(STR(${trustVar})) >= ${minTrust})`,
    );
  }

  const lastBodyToken = query.prepared.tokens[body.bodyTokenEnd - 1];
  const endsWithDot = isSourceSparqlToken(lastBodyToken)
    && lastBodyToken.kind === 'symbol'
    && lastBodyToken.logicalValue === '.';
  const separator = endsWithDot ? '\n' : '\n. ';
  const rewrittenBody = `${trimmedInner}${separator}${extraClauses.join(' ')}`;
  const rewrittenInner = body.valuesClause
    ? `${body.valuesClause}\n${rewrittenBody}`
    : rewrittenBody;

  return sparqlRewriteReady(
    `${query.source.slice(0, bodyStart)} ${rewrittenInner} ${query.source.slice(braceEnd)}`,
  );
}

export type MinTrustUnsupportedReason = 'unsupported-query-shape';

export type MinTrustRewriteResult = SparqlRewriteResult<
  string,
  MinTrustUnsupportedReason,
  PreparedSparqlQuery
>;
