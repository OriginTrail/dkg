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

type SparqlToken = {
  kind: 'word' | 'variable' | 'prefixed' | 'symbol';
  value: string;
  upper: string;
  start: number;
  end: number;
};

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

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function isWordStart(character: string | undefined): boolean {
  if (character === '_') return true;
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isWordContinuation(character: string | undefined): boolean {
  if (isWordStart(character) || character === '-') return true;
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code >= 0x30 && code <= 0x39;
}

function isPrefixedNameTerminator(character: string | undefined): boolean {
  return character === undefined
    || isWhitespace(character)
    || ';,.(){}[]<>\'"'.includes(character);
}

function maskLexicalRegions(value: string): { masked: string; unterminated: boolean } {
  const masked = value.split('');
  let quote: '"' | "'" | undefined;
  let tripleQuoted = false;
  let inIri = false;
  let inComment = false;
  let escaped = false;
  let knownNonIriUntil = -1;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (inComment) {
      if (character === '\n' || character === '\r') {
        inComment = false;
      } else {
        masked[index] = ' ';
      }
      continue;
    }
    if (quote) {
      if (
        tripleQuoted
        && character === quote
        && value[index + 1] === quote
        && value[index + 2] === quote
      ) {
        index += 2;
        quote = undefined;
        tripleQuoted = false;
        escaped = false;
        continue;
      }
      const closes = character === quote && !tripleQuoted && !escaped;
      if (!closes) masked[index] = ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (closes) quote = undefined;
      continue;
    }
    if (inIri) {
      if (character === '>') {
        inIri = false;
      } else {
        masked[index] = ' ';
      }
      continue;
    }
    if (character === '#') {
      inComment = true;
      masked[index] = ' ';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tripleQuoted = value[index + 1] === character && value[index + 2] === character;
      if (tripleQuoted) index += 2;
      continue;
    }
    if (character === '<' && index >= knownNonIriUntil) {
      let cursor = index + 1;
      while (
        cursor < value.length
        && value[cursor] !== '>'
        && !isWhitespace(value[cursor])
      ) cursor++;
      if (cursor > index + 1 && value[cursor] === '>') {
        inIri = true;
      } else {
        knownNonIriUntil = cursor;
      }
    }
  }
  return { masked: masked.join(''), unterminated: Boolean(quote || inIri) };
}

function tokenize(masked: string): SparqlToken[] {
  const tokens: SparqlToken[] = [];
  let cursor = 0;
  while (cursor < masked.length) {
    if (isWhitespace(masked[cursor])) {
      cursor++;
      continue;
    }
    const start = cursor;
    if (masked[cursor] === '?' && isWordStart(masked[cursor + 1])) {
      cursor += 2;
      while (isWordContinuation(masked[cursor])) cursor++;
      const value = masked.slice(start, cursor);
      tokens.push({ kind: 'variable', value, upper: value.toUpperCase(), start, end: cursor });
      continue;
    }
    if (isWordStart(masked[cursor])) {
      cursor++;
      while (isWordContinuation(masked[cursor])) cursor++;
      let kind: SparqlToken['kind'] = 'word';
      if (masked[cursor] === ':') {
        kind = 'prefixed';
        cursor++;
        while (!isPrefixedNameTerminator(masked[cursor])) cursor++;
      }
      const value = masked.slice(start, cursor);
      tokens.push({ kind, value, upper: value.toUpperCase(), start, end: cursor });
      continue;
    }
    cursor++;
    const value = masked.slice(start, cursor);
    tokens.push({ kind: 'symbol', value, upper: value, start, end: cursor });
  }
  return tokens;
}

function prefixDeclaration(
  tokens: readonly SparqlToken[],
  start: number,
): { end: number; prefix: string } | undefined {
  const keyword = tokens[start];
  const name = tokens[start + 1];
  const iriOpen = tokens[start + 2];
  const iriClose = tokens[start + 3];
  if (
    keyword?.kind !== 'word'
    || keyword.upper !== 'PREFIX'
    || !name
    || keyword.end === name.start
    || iriOpen?.value !== '<'
    || iriClose?.value !== '>'
    || iriClose.start <= iriOpen.end
  ) return undefined;

  if (name.kind === 'symbol' && name.value === ':') {
    return { end: start + 4, prefix: '' };
  }
  if (name.kind !== 'prefixed' || !name.value.endsWith(':')) return undefined;
  const prefix = name.value.slice(0, -1);
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix)
    ? { end: start + 4, prefix: prefix.toLowerCase() }
    : undefined;
}

function delimitersBalanced(tokens: readonly SparqlToken[], open: string, close: string): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (token.value === open) depth++;
    if (token.value === close) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function hasKeywordSequence(
  tokens: readonly SparqlToken[],
  keywords: readonly string[],
  followingSymbol?: string,
): boolean {
  for (let index = 0; index <= tokens.length - keywords.length; index++) {
    let matches = true;
    for (let offset = 0; offset < keywords.length; offset++) {
      const token = tokens[index + offset];
      if (token?.kind !== 'word' || token.upper !== keywords[offset]) {
        matches = false;
        break;
      }
      if (offset > 0 && tokens[index + offset - 1]!.end === token.start) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (followingSymbol === undefined || tokens[index + keywords.length]?.value === followingSymbol) {
      return true;
    }
  }
  return false;
}

function matchingParenthesis(tokens: readonly SparqlToken[], opening: number): number | undefined {
  let depth = 0;
  for (let index = opening; index < tokens.length; index++) {
    if (tokens[index].value === '(') depth++;
    if (tokens[index].value === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function hasUnwrappedAggregateAlias(masked: string, tokens: readonly SparqlToken[]): boolean {
  for (let index = 0; index < tokens.length; index++) {
    const aggregate = tokens[index];
    if (
      aggregate.kind !== 'word'
      || !AGGREGATE_KEYWORDS.has(aggregate.upper)
      || (aggregate.start > 0 && !isWhitespace(masked[aggregate.start - 1]))
      || tokens[index + 1]?.value !== '('
    ) continue;

    const closingIndex = matchingParenthesis(tokens, index + 1);
    if (closingIndex === undefined) continue;
    const closing = tokens[closingIndex];
    const asToken = tokens[closingIndex + 1];
    const variable = tokens[closingIndex + 2];
    if (
      asToken?.kind === 'word'
      && asToken.upper === 'AS'
      && closing.end < asToken.start
      && variable?.kind === 'variable'
      && asToken.end < variable.start
    ) return true;
  }
  return false;
}

/**
 * Scan the bounded SPARQL preflight input once into a masked lexical view and
 * token stream. All validation facts are derived here so comments, literals,
 * IRIs, prefixes, and delimiter boundaries cannot be interpreted differently
 * by separate recognizers.
 */
export function scanSparqlPreflight(value: string): SparqlPreflightScan {
  const { masked, unterminated } = maskLexicalRegions(value);
  const tokens = tokenize(masked);
  const declaredPrefixes = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const declaration = prefixDeclaration(tokens, index);
    if (declaration) declaredPrefixes.add(declaration.prefix);
  }

  let bodyStart = 0;
  while (bodyStart < tokens.length) {
    const declaration = prefixDeclaration(tokens, bodyStart);
    if (!declaration) break;
    bodyStart = declaration.end;
  }
  const bodyTokens = tokens.slice(bodyStart);
  const first = bodyTokens[0];
  const operation = first?.kind === 'word'
    && (first.upper === 'SELECT' || first.upper === 'ASK' || first.upper === 'CONSTRUCT')
    ? first.upper
    : undefined;

  const bareAbsolute = bodyTokens.find((token) => {
    if (token.kind !== 'prefixed') return false;
    const colon = token.value.indexOf(':');
    const scheme = token.value.slice(0, colon).toLowerCase();
    return ABSOLUTE_IRI_SCHEMES.has(scheme) && !declaredPrefixes.has(scheme);
  });

  return {
    masked,
    unterminated,
    operation,
    bracesBalanced: delimitersBalanced(tokens, '{', '}'),
    parenthesesBalanced: delimitersBalanced(tokens, '(', ')'),
    hasFrom: bodyTokens.some((token) => token.kind === 'word' && token.upper === 'FROM'),
    hasFilterNotExistsParentheses: hasKeywordSequence(
      bodyTokens,
      ['FILTER', 'NOT', 'EXISTS'],
      '(',
    ),
    hasStrcontains: hasKeywordSequence(bodyTokens, ['STRCONTAINS'], '('),
    hasUnwrappedAggregateAlias: hasUnwrappedAggregateAlias(masked, bodyTokens),
    bareAbsoluteIri: bareAbsolute?.value,
  };
}
