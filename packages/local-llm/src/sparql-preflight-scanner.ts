import {
  prepareSparqlQuery,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';

const ABSOLUTE_IRI_SCHEMES = new Set([
  'urn',
  'http',
  'https',
  'did',
  'ipfs',
  'ipns',
  'tag',
  'mailto',
]);
const AGGREGATE_KEYWORDS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

type ValuedToken = Extract<SparqlLexicalToken, { value: string }>;

export interface SparqlPreflightScan {
  masked: string;
  unterminated: boolean;
  operation?: 'SELECT' | 'ASK' | 'CONSTRUCT';
  bracesBalanced: boolean;
  parenthesesBalanced: boolean;
  hasFrom: boolean;
  hasFilterNotExistsParentheses: boolean;
  hasStrcontains: boolean;
  hasUnwrappedAggregateAlias: boolean;
  bareAbsoluteIri?: string;
}

function isValuedToken(token: SparqlLexicalToken | undefined): token is ValuedToken {
  return token !== undefined && 'value' in token;
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function hasKeywordSequence(
  tokens: readonly SparqlLexicalToken[],
  keywords: readonly string[],
  followingSymbol?: string,
): boolean {
  for (let index = 0; index <= tokens.length - keywords.length; index++) {
    let matches = true;
    for (let offset = 0; offset < keywords.length; offset++) {
      const token = tokens[index + offset];
      const previous = tokens[index + offset - 1];
      if (!isValuedToken(token) || token.kind !== 'word' || token.upper !== keywords[offset]) {
        matches = false;
        break;
      }
      if (offset > 0 && previous?.end === token.start) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const following = tokens[index + keywords.length];
    if (
      followingSymbol === undefined
      || (
        isValuedToken(following)
        && following.kind === 'symbol'
        && following.logicalValue === followingSymbol
      )
    ) return true;
  }
  return false;
}

function hasUnwrappedAggregateAlias(
  masked: string,
  tokens: readonly SparqlLexicalToken[],
  matchingParenthesisTokenIndexes: readonly number[],
  tokenOffset: number,
): boolean {
  for (let index = 0; index < tokens.length; index++) {
    const aggregate = tokens[index];
    const opening = tokens[index + 1];
    if (
      !isValuedToken(aggregate)
      || aggregate.kind !== 'word'
      || !AGGREGATE_KEYWORDS.has(aggregate.upper)
      || (aggregate.start > 0 && !isWhitespace(masked[aggregate.start - 1]))
      || !isValuedToken(opening)
      || opening.kind !== 'symbol'
      || opening.logicalValue !== '('
    ) continue;

    const absoluteClosingIndex = matchingParenthesisTokenIndexes[index + 1 + tokenOffset] ?? -1;
    const closingIndex = absoluteClosingIndex - tokenOffset;
    if (closingIndex < 0) continue;
    const closing = tokens[closingIndex];
    const asToken = tokens[closingIndex + 1];
    const variable = tokens[closingIndex + 2];
    if (
      isValuedToken(asToken)
      && asToken.kind === 'word'
      && asToken.upper === 'AS'
      && closing.end < asToken.start
      && isValuedToken(variable)
      && variable.kind === 'variable'
      && asToken.end < variable.start
    ) return true;
  }
  return false;
}

function isBareIriTermBoundary(
  token: SparqlLexicalToken,
  index: number,
  tokens: readonly SparqlLexicalToken[],
): boolean {
  if (token.kind === 'string' || token.kind === 'iri') return true;
  if (!isValuedToken(token) || token.kind !== 'symbol') return false;
  if (['{', '}', '(', ')', '[', ']', ';', ','].includes(token.logicalValue)) return true;
  if (token.logicalValue !== '.') return false;
  const next = tokens[index + 1];
  return next === undefined
    || token.end !== next.start
    || (
      isValuedToken(next)
      && next.kind === 'symbol'
      && ['{', '}', '(', ')', '[', ']', ';', ','].includes(next.logicalValue)
    );
}

function findBareAbsoluteIri(
  source: string,
  tokens: readonly SparqlLexicalToken[],
  declaredPrefixes: ReadonlySet<string>,
): string | undefined {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!isValuedToken(token) || token.kind !== 'prefixed-name') continue;
    const colon = token.logicalValue.indexOf(':');
    const scheme = token.logicalValue.slice(0, colon).toLowerCase();
    if (!ABSOLUTE_IRI_SCHEMES.has(scheme) || declaredPrefixes.has(scheme)) continue;

    let end = token.end;
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const next = tokens[cursor];
      if (next.start !== end || isBareIriTermBoundary(next, cursor, tokens)) break;
      end = next.end;
    }
    return source.slice(token.start, end);
  }
  return undefined;
}

/** Derive local-model policy facts from core's canonical lexical artifacts. */
export function scanSparqlPreflight(value: string): SparqlPreflightScan {
  const query = prepareSparqlQuery(value);
  const { prepared: lexical, structure } = query;
  const tokens = lexical.tokens.slice(lexical.prologue.endTokenIndex);
  const operation = query.operation === 'SELECT'
    || query.operation === 'ASK'
    || query.operation === 'CONSTRUCT'
    ? query.operation
    : undefined;
  const declaredPrefixes = new Set(
    lexical.prologue.declaredPrefixes.map((prefix) => prefix.toLowerCase()),
  );
  const bareAbsoluteIri = findBareAbsoluteIri(value, tokens, declaredPrefixes);

  return {
    masked: lexical.masked,
    unterminated: lexical.unterminated,
    operation,
    bracesBalanced: structure.braces.balanced,
    parenthesesBalanced: structure.parentheses.balanced,
    hasFrom: tokens.some(
      (token) => isValuedToken(token) && token.kind === 'word' && token.upper === 'FROM',
    ),
    hasFilterNotExistsParentheses: hasKeywordSequence(
      tokens,
      ['FILTER', 'NOT', 'EXISTS'],
      '(',
    ),
    hasStrcontains: hasKeywordSequence(tokens, ['STRCONTAINS'], '('),
    hasUnwrappedAggregateAlias: hasUnwrappedAggregateAlias(
      lexical.masked,
      tokens,
      structure.parentheses.matchingTokenIndexes,
      lexical.prologue.endTokenIndex,
    ),
    bareAbsoluteIri,
  };
}
