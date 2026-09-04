import { TRUST_LEVEL_PREDICATE } from '@origintrail-official/dkg-core';
import {
  sparqlTokenIndexesAtDepth,
  type PreparedSparqlQuery,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import {
  sparqlRewriteReady,
  sparqlRewriteUnsupported,
  type SparqlRewriteResult,
} from './sparql-rewrite-result.js';

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
  if (first?.kind === 'word' && first.upper === 'VALUES') {
    const variable = tokens[bodyTokenStart + 1];
    const opening = tokens[bodyTokenStart + 2];
    if (
      variable?.kind !== 'variable'
      || opening?.kind !== 'symbol'
      || opening.logicalValue !== '{'
    ) return null;

    const valuesOpeningIndex = bodyTokenStart + 2;
    const valuesClosingIndex = scope.structure.braces.matchingTokenIndexes[valuesOpeningIndex]
      ?? -1;
    if (valuesClosingIndex <= valuesOpeningIndex || valuesClosingIndex >= bodyEnd) return null;

    for (let index = valuesOpeningIndex + 1; index < valuesClosingIndex; index++) {
      const token = tokens[index];
      if (
        token.kind === 'symbol'
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
      token.kind === 'symbol'
      && token.logicalValue === '('
    ) break;
    if (
      token.kind === 'symbol'
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
      token.kind === 'word'
      && (token.upper === 'FILTER' || token.upper === 'BIND')
    ) {
      const next = skipMinTrustExpression(scope, index, body.bodyTokenEnd);
      if (next === null) return null;
      expectSubject = true;
      index = next;
      continue;
    }

    if (
      token.kind === 'symbol'
      && token.logicalValue === '.'
    ) {
      expectSubject = true;
      index++;
      continue;
    }

    if (
      token.kind === 'symbol'
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
    if (token.kind === 'variable') {
      subjects.set(`variable:${token.logicalValue.slice(1)}`, token.raw);
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
      token.kind === 'prefixed-name'
      && !token.logicalValue.startsWith('_:')
    ) {
      subjects.set(`prefixed:${token.logicalValue}`, token.raw);
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
  const endsWithDot = lastBodyToken?.kind === 'symbol'
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
  MinTrustUnsupportedReason
>;
