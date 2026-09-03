import {
  scanSparqlLexically,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-core/sparql-lexical-scanner';

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

function delimitersBalanced(
  tokens: readonly SparqlLexicalToken[],
  open: string,
  close: string,
): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (!isValuedToken(token) || token.kind !== 'symbol') continue;
    if (token.value === open) depth++;
    if (token.value === close) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
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
      || (isValuedToken(following) && following.kind === 'symbol' && following.value === followingSymbol)
    ) return true;
  }
  return false;
}

function matchingParenthesis(
  tokens: readonly SparqlLexicalToken[],
  opening: number,
): number | undefined {
  let depth = 0;
  for (let index = opening; index < tokens.length; index++) {
    const token = tokens[index];
    if (!isValuedToken(token) || token.kind !== 'symbol') continue;
    if (token.value === '(') depth++;
    if (token.value === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function hasUnwrappedAggregateAlias(
  masked: string,
  tokens: readonly SparqlLexicalToken[],
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
      || opening.value !== '('
    ) continue;

    const closingIndex = matchingParenthesis(tokens, index + 1);
    if (closingIndex === undefined) continue;
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

/** Derive local-model policy facts from core's canonical lexical artifacts. */
export function scanSparqlPreflight(value: string): SparqlPreflightScan {
  const lexical = scanSparqlLexically(value);
  const tokens = lexical.tokens.slice(lexical.prologue.endTokenIndex);
  const first = tokens[0];
  const operation = isValuedToken(first)
    && first.kind === 'word'
    && (first.upper === 'SELECT' || first.upper === 'ASK' || first.upper === 'CONSTRUCT')
    ? first.upper
    : undefined;
  const declaredPrefixes = new Set(
    lexical.prologue.declaredPrefixes.map((prefix) => prefix.toLowerCase()),
  );
  const bareAbsolute = tokens.find((token) => {
    if (!isValuedToken(token) || token.kind !== 'prefixed-name') return false;
    const colon = token.value.indexOf(':');
    const scheme = token.value.slice(0, colon).toLowerCase();
    return ABSOLUTE_IRI_SCHEMES.has(scheme) && !declaredPrefixes.has(scheme);
  });

  return {
    masked: lexical.masked,
    unterminated: lexical.unterminated,
    operation,
    bracesBalanced: delimitersBalanced(lexical.tokens, '{', '}'),
    parenthesesBalanced: delimitersBalanced(lexical.tokens, '(', ')'),
    hasFrom: tokens.some(
      (token) => isValuedToken(token) && token.kind === 'word' && token.upper === 'FROM',
    ),
    hasFilterNotExistsParentheses: hasKeywordSequence(
      tokens,
      ['FILTER', 'NOT', 'EXISTS'],
      '(',
    ),
    hasStrcontains: hasKeywordSequence(tokens, ['STRCONTAINS'], '('),
    hasUnwrappedAggregateAlias: hasUnwrappedAggregateAlias(lexical.masked, tokens),
    bareAbsoluteIri: isValuedToken(bareAbsolute) ? bareAbsolute.value : undefined,
  };
}
