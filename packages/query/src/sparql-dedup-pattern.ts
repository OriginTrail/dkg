import type { PreparedSparqlQuery, SparqlLexicalToken } from '@origintrail-official/dkg-rdf-utils/sparql';
import { literalSuffixLength } from './sparql-literal-suffix.js';

interface SourceRange {
  readonly start: number;
  readonly end: number;
  readonly expressionStart: number;
}

const FORBIDDEN_PATTERN_WORDS = new Set([
  'OPTIONAL', 'MINUS', 'SERVICE', 'VALUES', 'BIND', 'SELECT', 'GRAPH', 'EXISTS',
]);
const unsupportedToken = (token: SparqlLexicalToken) =>
  (token.kind === 'word' && FORBIDDEN_PATTERN_WORDS.has(token.upper))
  || (token.kind === 'symbol' && (token.logicalValue === '{' || token.logicalValue === '}'));

function isSupportedFilterExpression(
  tokens: readonly SparqlLexicalToken[],
  start: number,
  end: number,
): boolean {
  for (let index = start; index < end; index++) {
    const token = tokens[index];
    if (unsupportedToken(token)) return false;
    if (token.kind === 'string') {
      const suffix = literalSuffixLength(tokens, index + 1);
      if (suffix < 0) return false;
      index += suffix;
    }
  }
  return true;
}

function isVisibleTripleToken(token: SparqlLexicalToken): boolean {
  switch (token.kind) {
    case 'variable':
    case 'iri':
    case 'prefixed-name':
    case 'number':
      return true;
    case 'word':
      return token.logicalValue === 'a' || token.upper === 'TRUE' || token.upper === 'FALSE';
    case 'symbol':
      return token.logicalValue === '.' || token.logicalValue === ';' || token.logicalValue === ',';
    default:
      return false;
  }
}

/**
 * Read a flat pattern's FILTERs and terms. When every term is visible, one graph
 * matches a mapping at most once. A path or blank node can match the same mapping
 * several ways, and those repeats are part of the caller's results.
 */
export function analyzeDedupPattern(scope: PreparedSparqlQuery): {
  readonly uniqueMappings: boolean;
  readonly filters: readonly SourceRange[];
} | null {
  if (!scope.where) return null;
  const tokens = scope.prepared.tokens;
  const end = scope.where.closingTokenIndex;
  const filters: SourceRange[] = [];
  let visible = true;
  let hasTriple = false;
  for (let index = scope.where.openingTokenIndex + 1; index < end; index++) {
    const token = tokens[index];
    if (token.kind === 'word' && token.upper === 'FILTER') {
      // FILTER ( ... ) or FILTER fn( ... )
      const isOpening = (at: number) => {
        const candidate = tokens[at];
        return candidate?.kind === 'symbol' && candidate.logicalValue === '(';
      };
      const opening = isOpening(index + 1) ? index + 1 : index + 2;
      const closing = isOpening(opening)
        ? scope.structure.parentheses.matchingTokenIndexes[opening] ?? -1
        : -1;
      if (closing <= opening || closing >= end) return null;
      if (!isSupportedFilterExpression(tokens, index + 1, closing)) return null;
      filters.push({ start: token.start, expressionStart: token.end, end: tokens[closing].end });
      index = closing;
      continue;
    }
    if (unsupportedToken(token)) return null;
    hasTriple = true;
    if (token.kind === 'string') {
      const suffix = literalSuffixLength(tokens, index + 1);
      if (suffix < 0) visible = false;
      else index += suffix;
    } else if (!isVisibleTripleToken(token)) {
      visible = false;
    }
  }
  return { uniqueMappings: hasTriple && visible, filters: hasTriple ? filters : [] };
}

