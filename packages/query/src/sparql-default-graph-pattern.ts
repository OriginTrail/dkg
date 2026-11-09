import { readSparqlQueryBoundaries, type PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';

export function hasTopLevelDefaultGraphPattern(scope: PreparedSparqlQuery): boolean {
  const where = scope.where;
  if (!where) return true;
  return groupHasDefaultGraphPattern(
    scope,
    where.openingTokenIndex,
    where.closingTokenIndex,
  );
}

function nextGroupOpening(
  scope: PreparedSparqlQuery,
  start: number,
  limit: number,
  depth: number,
): number {
  for (let index = start; index < limit; index++) {
    const token = scope.prepared.tokens[index];
    if (
      scope.structure.braces.depthBefore[index] === depth
      && token.kind === 'symbol'
      && token.logicalValue === '{'
    ) return index;
  }
  return -1;
}

function groupHasDefaultGraphPattern(
  scope: PreparedSparqlQuery,
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

  // Projection variables are not default patterns, but projection/modifier
  // EXISTS expressions can read them. Keep their groups separate from WHERE.
  if (first?.kind === 'word' && first.upper === 'SELECT') {
    const { where } = readSparqlQueryBoundaries(scope.prepared, scope.structure,
      { operationTokenIndex: firstIndex, endTokenIndex: closingIndex });
    if (!where) return true;
    return groupHasDefaultGraphPattern(scope, where.openingTokenIndex, where.closingTokenIndex)
      || rangeHasDefaultGraphExpression(scope, firstIndex, closingIndex, where.openingTokenIndex, where.closingTokenIndex);
  }

  for (let index = openingIndex + 1; index < closingIndex; index++) {
    if (scope.structure.braces.depthBefore[index] !== contentDepth) continue;
    const token = tokens[index];

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
        expressionOpening?.kind !== 'symbol'
        || expressionOpening.logicalValue !== '('
      ) return true;
      const expressionClosing = scope.structure.parentheses.matchingTokenIndexes[index + 1] ?? -1;
      if (expressionClosing < 0 || expressionClosing >= closingIndex) return true;
      for (let nested = index + 2; nested < expressionClosing; nested++) {
        const candidate = tokens[nested];
        if (
          candidate.kind === 'symbol'
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

function rangeHasDefaultGraphExpression(scope: PreparedSparqlQuery, start: number, end: number,
  whereOpening: number, whereClosing: number): boolean {
  const { tokens } = scope.prepared;
  for (let index = start; index < end; index++) {
    if (index === whereOpening) { index = whereClosing; continue; }
    const token = tokens[index];
    if (token.kind !== 'word' || token.upper !== 'EXISTS') continue;
    const opening = tokens[index + 1];
    if (opening?.kind !== 'symbol' || opening.logicalValue !== '{') continue;
    const closing = scope.structure.braces.matchingTokenIndexes[index + 1] ?? -1;
    if (closing < 0 || groupHasDefaultGraphPattern(scope, index + 1, closing)) return true;
    index = closing;
  }
  return false;
}

/** Default-graph reads in projection and solution-modifier EXISTS expressions. */
export function hasOuterDefaultGraphPattern(scope: PreparedSparqlQuery): boolean {
  return rangeHasDefaultGraphExpression(scope, 0, scope.prepared.tokens.length,
    scope.where?.openingTokenIndex ?? -1, scope.where?.closingTokenIndex ?? -1);
}

/** Read planning needs a complete content dataset whenever either boundary reads it. */
export function hasDefaultGraphRead(scope: PreparedSparqlQuery): boolean {
  return hasTopLevelDefaultGraphPattern(scope) || hasOuterDefaultGraphPattern(scope);
}
