import {
  normalizeSparqlCodePointEscapes,
  readSparqlLogicalCodePoint,
  readSparqlVariableEnd,
  scanSparqlStringLiteral,
  skipSparqlIriRef,
  sparqlAsciiDigitWidth,
  sparqlPnCharsBaseWidth,
  sparqlPnCharsUWidth,
  sparqlPnCharsWidth,
} from './sparql-lexical-primitives.js';

export type SparqlLexicalToken =
  | {
    readonly kind: 'word' | 'variable' | 'prefixed-name' | 'symbol';
    /** Exact spelling in the unprocessed source. */
    readonly value: string;
    /** Value after SPARQL UCHAR preprocessing. */
    readonly logicalValue: string;
    readonly upper: string;
    readonly start: number;
    readonly end: number;
  }
  | {
    readonly kind: 'iri';
    /** IRIREF body after UCHAR decoding, without angle brackets. */
    readonly logicalValue: string;
    readonly start: number;
    readonly end: number;
  }
  | {
    readonly kind: 'string';
    readonly start: number;
    readonly end: number;
  };

interface PreparedSparqlCommon {
  /** Exact unprocessed input. */
  readonly source: string;
  /** Source-length-preserving view with strings, IRIs, and comments blanked. */
  readonly masked: string;
  /** Tokens outside comments, including opaque string and IRI boundary tokens. */
  readonly tokens: readonly SparqlLexicalToken[];
  readonly unterminated: boolean;
  /** Upper-cased logical word tokens, computed once for policy checks. */
  readonly wordTokens: ReadonlySet<string>;
  readonly prologue: {
    readonly endTokenIndex: number;
    readonly declaredPrefixes: readonly string[];
  };
}

export type PreparedSparql =
  | (PreparedSparqlCommon & { readonly status: 'valid' })
  | (PreparedSparqlCommon & {
    readonly status: 'malformed-uchar';
    readonly tokens: readonly [];
    readonly unterminated: false;
  });

type ScannedSparqlLexicalToken = SparqlLexicalToken & {
  readonly normalizedStart: number;
  readonly normalizedEnd: number;
};

interface ScannedSparql {
  readonly masked: string;
  readonly tokens: readonly ScannedSparqlLexicalToken[];
  readonly unterminated: boolean;
  readonly wordTokens: ReadonlySet<string>;
  readonly prologue: PreparedSparql['prologue'];
}

function logicalCodePointWidth(value: string, index: number, expected: number): number {
  const logical = readSparqlLogicalCodePoint(value, index);
  return logical?.codePoint === expected ? logical.rawWidth : 0;
}

function logicalAsciiHexWidth(value: string, index: number): number {
  const logical = readSparqlLogicalCodePoint(value, index);
  if (!logical) return 0;
  const accepted = (logical.codePoint >= 0x30 && logical.codePoint <= 0x39)
    || (logical.codePoint >= 0x41 && logical.codePoint <= 0x46)
    || (logical.codePoint >= 0x61 && logical.codePoint <= 0x66);
  return accepted ? logical.rawWidth : 0;
}

/** SPARQL PLX after UCHAR preprocessing. */
function plxWidth(value: string, index: number): number {
  const logical = readSparqlLogicalCodePoint(value, index);
  if (!logical) return 0;
  if (logical.codePoint === 0x25) {
    const firstHex = logicalAsciiHexWidth(value, index + logical.rawWidth);
    if (!firstHex) return 0;
    const secondHex = logicalAsciiHexWidth(value, index + logical.rawWidth + firstHex);
    return secondHex ? logical.rawWidth + firstHex + secondHex : 0;
  }
  if (logical.codePoint !== 0x5c) return 0;
  const escaped = readSparqlLogicalCodePoint(value, index + logical.rawWidth);
  if (!escaped) return 0;
  const escapedCharacter = String.fromCodePoint(escaped.codePoint);
  return "_~.-!$&'()*+,;=/?#@%".includes(escapedCharacter)
    ? logical.rawWidth + escaped.rawWidth
    : 0;
}

function pnLocalInitialWidth(value: string, index: number): number {
  return sparqlPnCharsUWidth(value, index)
    || sparqlAsciiDigitWidth(value, index)
    || logicalCodePointWidth(value, index, 0x3a)
    || plxWidth(value, index);
}

function pnLocalContinuationWidth(value: string, index: number): number {
  return sparqlPnCharsWidth(value, index)
    || logicalCodePointWidth(value, index, 0x3a)
    || plxWidth(value, index);
}

function scanPnLocalEnd(value: string, start: number): number {
  let cursor = start;
  let width = pnLocalInitialWidth(value, cursor);
  if (!width) return cursor;
  cursor += width;
  let lastValidEnd = cursor;
  while (cursor < value.length) {
    width = pnLocalContinuationWidth(value, cursor);
    if (width) {
      cursor += width;
      lastValidEnd = cursor;
      continue;
    }
    const dotWidth = logicalCodePointWidth(value, cursor, 0x2e);
    if (dotWidth) {
      cursor += dotWidth;
      continue;
    }
    break;
  }
  return lastValidEnd;
}

interface PrefixColon {
  readonly end: number;
}

function pnPrefixColon(value: string, start: number): PrefixColon | undefined {
  const firstWidth = sparqlPnCharsBaseWidth(value, start);
  if (!firstWidth) return undefined;
  let cursor = start + firstWidth;
  let lastValidEnd = cursor;
  while (cursor < value.length) {
    const width = sparqlPnCharsWidth(value, cursor);
    if (width) {
      cursor += width;
      lastValidEnd = cursor;
      continue;
    }
    const dotWidth = logicalCodePointWidth(value, cursor, 0x2e);
    if (dotWidth) {
      cursor += dotWidth;
      continue;
    }
    break;
  }
  const colonWidth = logicalCodePointWidth(value, cursor, 0x3a);
  return colonWidth && cursor === lastValidEnd
    ? { end: cursor + colonWidth }
    : undefined;
}

function isWhitespace(codePoint: number): boolean {
  return /\s/u.test(String.fromCodePoint(codePoint));
}

function blank(masked: string[], start: number, end: number): void {
  for (let index = start; index < end; index++) masked[index] = ' ';
}

function logicalIriValue(value: string, start: number, end: number): string | null {
  const decoded: string[] = [];
  let index = start + 1;
  while (index < end - 1) {
    const logical = readSparqlLogicalCodePoint(value, index);
    if (!logical || index + logical.rawWidth > end - 1) return null;
    decoded.push(String.fromCodePoint(logical.codePoint));
    index += logical.rawWidth;
  }
  return decoded.join('');
}

function lexicalToken(
  kind: 'word' | 'variable' | 'prefixed-name' | 'symbol',
  value: string,
  start: number,
  end: number,
  logicalValue = value,
): ScannedSparqlLexicalToken {
  return {
    kind,
    value,
    logicalValue,
    upper: logicalValue.toUpperCase(),
    start,
    end,
    normalizedStart: start,
    normalizedEnd: end,
  };
}

function valuedToken(
  token: SparqlLexicalToken | undefined,
): token is Extract<SparqlLexicalToken, { value: string }> {
  return token !== undefined && 'value' in token;
}

function scanPrologue(tokens: readonly SparqlLexicalToken[]): PreparedSparql['prologue'] {
  const declaredPrefixes: string[] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const keyword = tokens[cursor];
    if (!valuedToken(keyword) || keyword.kind !== 'word') break;

    if (keyword.upper === 'BASE' && tokens[cursor + 1]?.kind === 'iri') {
      cursor += 2;
      continue;
    }
    if (keyword.upper !== 'PREFIX') break;

    const name = tokens[cursor + 1];
    const iri = tokens[cursor + 2];
    if (!valuedToken(name) || keyword.end === name.start || iri?.kind !== 'iri') break;
    if (
      name.kind !== 'prefixed-name'
      || name.logicalValue.indexOf(':') !== name.logicalValue.length - 1
    ) break;
    declaredPrefixes.push(name.logicalValue.slice(0, -1));
    cursor += 3;
  }
  return { endTokenIndex: cursor, declaredPrefixes };
}

/**
 * Dependency-light SPARQL lexical scan shared by operation classification and
 * higher-level policy checks. It is deliberately not a parser: it owns only
 * lexical regions, PN_PREFIX-aware names, source offsets, and masking.
 */
function scanSparql(value: string): ScannedSparql {
  const masked = value.split('');
  const tokens: ScannedSparqlLexicalToken[] = [];
  let unterminated = false;
  let index = 0;

  while (index < value.length) {
    const logical = readSparqlLogicalCodePoint(value, index);
    if (!logical) {
      const start = index++;
      tokens.push(lexicalToken('symbol', value[start], start, index));
      continue;
    }
    if (isWhitespace(logical.codePoint)) {
      index += logical.rawWidth;
      continue;
    }

    if (logical.codePoint === 0x23) {
      const start = index;
      index += logical.rawWidth;
      // UCHAR-looking text is inert once the comment has opened. Only an
      // actual source line ending closes the comment.
      while (index < value.length && value[index] !== '\n' && value[index] !== '\r') index++;
      blank(masked, start, index);
      continue;
    }

    if (logical.codePoint === 0x22 || logical.codePoint === 0x27) {
      const start = index;
      const stringScan = scanSparqlStringLiteral(value, start);
      if (!stringScan) {
        index += logical.rawWidth;
        continue;
      }
      index = stringScan.end;
      blank(masked, start, index);
      tokens.push({
        kind: 'string',
        start,
        end: index,
        normalizedStart: start,
        normalizedEnd: index,
      });
      if (!stringScan.closed) unterminated = true;
      continue;
    }

    if (logical.codePoint === 0x3c) {
      const iriEnd = skipSparqlIriRef(value, index);
      if (iriEnd !== null) {
        const start = index;
        index = iriEnd;
        const logicalValue = logicalIriValue(value, start, index);
        if (logicalValue === null) {
          unterminated = true;
          continue;
        }
        blank(masked, start, index);
        tokens.push({
          kind: 'iri',
          logicalValue,
          start,
          end: index,
          normalizedStart: start,
          normalizedEnd: index,
        });
        continue;
      }
    }

    if (logical.codePoint === 0x3f || logical.codePoint === 0x24) {
      const variableEnd = readSparqlVariableEnd(value, index);
      if (variableEnd !== null) {
        const start = index;
        index = variableEnd;
        tokens.push(lexicalToken('variable', value.slice(start, index), start, index));
        continue;
      }
    }

    if (logical.codePoint === 0x3a) {
      const start = index;
      index = scanPnLocalEnd(value, index + logical.rawWidth);
      tokens.push(lexicalToken('prefixed-name', value.slice(start, index), start, index));
      continue;
    }

    const wordStart = sparqlPnCharsBaseWidth(value, index);
    if (wordStart) {
      const start = index;
      const colon = pnPrefixColon(value, index);
      let kind: 'word' | 'prefixed-name';
      if (colon) {
        kind = 'prefixed-name';
        index = scanPnLocalEnd(value, colon.end);
      } else {
        kind = 'word';
        index += wordStart;
        let width = sparqlPnCharsWidth(value, index);
        while (width) {
          index += width;
          width = sparqlPnCharsWidth(value, index);
        }
      }
      tokens.push(lexicalToken(kind, value.slice(start, index), start, index));
      continue;
    }

    const start = index;
    index += logical.rawWidth;
    tokens.push(lexicalToken(
      'symbol',
      value.slice(start, index),
      start,
      index,
      String.fromCodePoint(logical.codePoint),
    ));
  }

  const maskedValue = masked.join('');
  const wordTokens = new Set<string>();
  for (const token of tokens) {
    if ('value' in token && token.kind === 'word') wordTokens.add(token.upper);
  }
  return {
    masked: maskedValue,
    tokens,
    unterminated,
    wordTokens,
    prologue: scanPrologue(tokens),
  };
}

function normalizedBoundaryToRaw(
  normalizedIndex: number,
  spans: readonly { rawStart: number; rawEnd: number }[],
  sourceLength: number,
  boundary: 'start' | 'end',
): number {
  if (normalizedIndex <= 0) return 0;
  if (normalizedIndex >= spans.length) return sourceLength;
  return boundary === 'start'
    ? spans[normalizedIndex].rawStart
    : spans[normalizedIndex - 1].rawEnd;
}

function exposeToken(
  token: ScannedSparqlLexicalToken,
  source: string,
  start: number,
  end: number,
): SparqlLexicalToken {
  if (token.kind === 'string') return { kind: 'string', start, end };
  if (token.kind === 'iri') {
    return { kind: 'iri', logicalValue: token.logicalValue, start, end };
  }
  return {
    kind: token.kind,
    value: source.slice(start, end),
    logicalValue: token.logicalValue,
    upper: token.upper,
    start,
    end,
  };
}

function exposeValidScan(source: string, scan: ScannedSparql): PreparedSparql {
  return {
    status: 'valid',
    source,
    masked: scan.masked,
    tokens: scan.tokens.map((token) => exposeToken(
      token,
      source,
      token.normalizedStart,
      token.normalizedEnd,
    )),
    unterminated: scan.unterminated,
    wordTokens: new Set(scan.wordTokens),
    prologue: scan.prologue,
  };
}

/** Canonical lexical artifact with raw source coordinates and logical values. */
export function prepareSparql(source: string): PreparedSparql {
  // The overwhelmingly common path contains no UCHAR. Avoid constructing an
  // O(n) span table and remapping every token when raw and logical coordinate
  // spaces are identical. This also keeps large valid PREFIX preambles well
  // below the ReDoS regression wall-clock guard while remaining linear.
  if (!source.includes('\\u') && !source.includes('\\U')) {
    return exposeValidScan(source, scanSparql(source));
  }

  const normalized = normalizeSparqlCodePointEscapes(source);
  if (normalized === null) {
    return {
      status: 'malformed-uchar',
      source,
      masked: ' '.repeat(source.length),
      tokens: [],
      unterminated: false,
      wordTokens: new Set(),
      prologue: { endTokenIndex: 0, declaredPrefixes: [] },
    };
  }

  const scan = scanSparql(normalized.value);
  const tokens = scan.tokens.map((token): SparqlLexicalToken => {
    const start = normalizedBoundaryToRaw(
      token.normalizedStart,
      normalized.spans,
      source.length,
      'start',
    );
    const end = normalizedBoundaryToRaw(
      token.normalizedEnd,
      normalized.spans,
      source.length,
      'end',
    );
    return exposeToken(token, source, start, end);
  });

  const masked = source.split('');
  for (let index = 0; index < scan.masked.length; index++) {
    if (scan.masked[index] !== ' ') continue;
    const span = normalized.spans[index];
    if (!span) continue;
    blank(masked, span.rawStart, span.rawEnd);
  }

  return {
    status: 'valid',
    source,
    masked: masked.join(''),
    tokens,
    unterminated: scan.unterminated,
    wordTokens: new Set(scan.wordTokens),
    prologue: scan.prologue,
  };
}
