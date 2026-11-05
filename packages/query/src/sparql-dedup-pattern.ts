import type { PreparedSparqlQuery, SparqlLexicalToken } from '@origintrail-official/dkg-rdf-utils/sparql';
import { literalSuffixLength } from './sparql-literal-suffix.js';

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export function isDedupSafeBasicGraphPattern(scope: PreparedSparqlQuery): boolean {
  if (!scope.where) return false;
  const forbidden = new Set([
    'OPTIONAL', 'MINUS', 'SERVICE', 'VALUES', 'BIND', 'SELECT', 'GRAPH', 'EXISTS',
  ]);
  return !scope.prepared.tokens
    .slice(scope.where.openingTokenIndex + 1, scope.where.closingTokenIndex)
    .some((token) => (
      (token.kind === 'word' && forbidden.has(token.upper))
      || (token.kind === 'symbol' && (token.logicalValue === '{' || token.logicalValue === '}'))
    ));
}

// These FILTER expressions only test an existing mapping, so they answer the same
// every time the pattern runs. A volatile or extension function might not, so the
// aggregate route, which runs the pattern twice, moves it after deduplication.
const DEDUP_PURE_FILTER_WORDS = new Set([
  'STR', 'STRSTARTS', 'STRENDS', 'CONTAINS', 'STRLEN', 'LCASE', 'UCASE',
  'BOUND', 'TRUE', 'FALSE', 'IN', 'NOT',
  'REGEX', 'LANG', 'LANGMATCHES', 'DATATYPE', 'SAMETERM',
  'ISIRI', 'ISURI', 'ISBLANK', 'ISLITERAL', 'ISNUMERIC',
]);

function isPureFilterExpression(
  tokens: readonly SparqlLexicalToken[],
  start: number,
  end: number,
): boolean {
  for (let index = start; index < end; index++) {
    const token = tokens[index];
    if (token.kind === 'string') {
      const suffix = literalSuffixLength(tokens, index + 1);
      if (suffix < 0) return false;
      index += suffix;
      continue;
    }
    if (token.kind === 'word' && !DEDUP_PURE_FILTER_WORDS.has(token.upper)) return false;
    const next = tokens[index + 1];
    if ((token.kind === 'iri' || token.kind === 'prefixed-name')
      && next?.kind === 'symbol' && next.logicalValue === '(') return false;
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
export function readDedupPattern(scope: PreparedSparqlQuery): {
  readonly uniqueMappings: boolean;
  readonly impureFilters: readonly SourceRange[];
} {
  const whole = { uniqueMappings: false, impureFilters: [] };
  if (!scope.where) return whole;
  const tokens = scope.prepared.tokens;
  const end = scope.where.closingTokenIndex;
  const impureFilters: SourceRange[] = [];
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
      if (closing <= opening || closing >= end) return whole;
      if (!isPureFilterExpression(tokens, index + 1, closing)) {
        impureFilters.push({ start: token.start, end: tokens[closing].end });
      }
      index = closing;
      continue;
    }
    hasTriple = true;
    if (token.kind === 'string') {
      const suffix = literalSuffixLength(tokens, index + 1);
      if (suffix < 0) visible = false;
      else index += suffix;
    } else if (!isVisibleTripleToken(token)) {
      visible = false;
    }
  }
  return hasTriple ? { uniqueMappings: visible, impureFilters } : whole;
}

