import {
  readSparqlLogicalCodePoint,
  readSparqlVariableEnd,
  scanSparqlIriRef,
  scanSparqlStringLiteral,
  sparqlAsciiDigitWidth,
  sparqlPnCharsBaseWidth,
  sparqlPnCharsUWidth,
  sparqlPnCharsWidth,
} from './sparql-lexical-primitives.js';

interface SparqlLexicalTokenBase {
  /** Exact spelling in the unprocessed source. */
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

type SparqlLogicalToken<Kind extends 'variable' | 'prefixed-name' | 'symbol' | 'number'> =
  SparqlLexicalTokenBase & {
    readonly kind: Kind;
    /** Value after SPARQL UCHAR preprocessing. */
    readonly logicalValue: string;
  };

export type SparqlLexicalToken =
  | (SparqlLexicalTokenBase & {
    readonly kind: 'word';
    /** Value after SPARQL UCHAR preprocessing. */
    readonly logicalValue: string;
    readonly upper: string;
  })
  | SparqlLogicalToken<'variable'>
  | SparqlLogicalToken<'prefixed-name'>
  | SparqlLogicalToken<'symbol'>
  | SparqlLogicalToken<'number'>
  | (SparqlLexicalTokenBase & {
    readonly kind: 'iri';
    /** IRIREF body after UCHAR decoding, without angle brackets. */
    readonly logicalValue: string;
  })
  | (SparqlLexicalTokenBase & { readonly kind: 'string' });

interface PreparedSparqlCommon {
  /** Exact unprocessed input. */
  readonly source: string;
  /** Source-length-preserving view with strings, IRIs, and comments blanked. */
  readonly masked: string;
  /** Active UCHAR syntax decoded; opaque strings, IRIs, and comments preserved. */
  readonly materialized: string;
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

/** A canonical lexical artifact whose UCHAR preprocessing succeeded. */
export type ValidPreparedSparql = Extract<PreparedSparql, { readonly status: 'valid' }>;

interface ScannedSparql {
  readonly masked: string;
  readonly materialized: string;
  readonly tokens: readonly SparqlLexicalToken[];
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

function logicalTokenValue(value: string, start: number, end: number): string | null {
  const decoded: string[] = [];
  let index = start;
  while (index < end) {
    const logical = readSparqlLogicalCodePoint(value, index);
    if (!logical || index + logical.rawWidth > end) return null;
    decoded.push(String.fromCodePoint(logical.codePoint));
    index += logical.rawWidth;
  }
  return decoded.join('');
}

function scanLogicalDigits(source: string, start: number): { end: number; count: number } {
  let end = start;
  let count = 0;
  let width = sparqlAsciiDigitWidth(source, end);
  while (width > 0) {
    end += width;
    count++;
    width = sparqlAsciiDigitWidth(source, end);
  }
  return { end, count };
}

/** Scan SPARQL INTEGER, DECIMAL, and DOUBLE spellings, including signed forms. */
function scanNumberEnd(source: string, start: number): number | null {
  let cursor = start;
  const sign = readSparqlLogicalCodePoint(source, cursor);
  if (sign?.codePoint === 0x2b || sign?.codePoint === 0x2d) cursor += sign.rawWidth;

  const integer = scanLogicalDigits(source, cursor);
  cursor = integer.end;
  const integerEnd = cursor;
  const point = readSparqlLogicalCodePoint(source, cursor);
  let fractionCount = 0;
  let hasPoint = false;
  if (point?.codePoint === 0x2e) {
    hasPoint = true;
    const fraction = scanLogicalDigits(source, cursor + point.rawWidth);
    cursor = fraction.end;
    fractionCount = fraction.count;
  }
  if (integer.count === 0 && fractionCount === 0) return null;

  const exponent = readSparqlLogicalCodePoint(source, cursor);
  if (exponent?.codePoint === 0x45 || exponent?.codePoint === 0x65) {
    let exponentCursor = cursor + exponent.rawWidth;
    const exponentSign = readSparqlLogicalCodePoint(source, exponentCursor);
    if (exponentSign?.codePoint === 0x2b || exponentSign?.codePoint === 0x2d) {
      exponentCursor += exponentSign.rawWidth;
    }
    const exponentDigits = scanLogicalDigits(source, exponentCursor);
    if (exponentDigits.count > 0) return exponentDigits.end;
  }

  // A point with no fractional digits is legal only in a DOUBLE with an
  // exponent. Otherwise leave it for the statement-separator token.
  if (hasPoint && fractionCount === 0) return integer.count > 0 ? integerEnd : null;
  return cursor;
}

type LogicalSparqlToken = Exclude<SparqlLexicalToken, { readonly kind: 'iri' | 'string' }>;

function lexicalToken(
  kind: LogicalSparqlToken['kind'],
  source: string,
  start: number,
  end: number,
  logicalValue = logicalTokenValue(source, start, end),
): LogicalSparqlToken | null {
  if (logicalValue === null) return null;
  const common = { raw: source.slice(start, end), logicalValue, start, end };
  return kind === 'word'
    ? { kind, ...common, upper: logicalValue.toUpperCase() }
    : { kind, ...common };
}

function tokenCanEndExpression(token: SparqlLexicalToken | undefined): boolean {
  if (!token) return false;
  if (
    token.kind === 'variable'
    || token.kind === 'prefixed-name'
    || token.kind === 'number'
    || token.kind === 'iri'
    || token.kind === 'string'
  ) return true;
  if (token.kind === 'word') return token.upper === 'TRUE' || token.upper === 'FALSE';
  return token.logicalValue === ')';
}

function lessThanStartsIriRef(
  tokens: readonly SparqlLexicalToken[],
  openExpressionGroups: readonly ('(' | '{')[],
): boolean {
  return !(
    openExpressionGroups[openExpressionGroups.length - 1] === '('
    && tokenCanEndExpression(tokens[tokens.length - 1])
  );
}

function updateOpenExpressionGroups(
  stack: Array<'(' | '{'>,
  symbol: string,
): void {
  if (symbol === '(' || symbol === '{') {
    stack.push(symbol);
    return;
  }
  const expected = symbol === ')' ? '(' : symbol === '}' ? '{' : undefined;
  if (expected !== undefined && stack[stack.length - 1] === expected) stack.pop();
}

function scanPrologue(tokens: readonly SparqlLexicalToken[]): PreparedSparql['prologue'] {
  const declaredPrefixes: string[] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const keyword = tokens[cursor];
    if (keyword?.kind !== 'word') break;

    if (keyword.upper === 'BASE' && tokens[cursor + 1]?.kind === 'iri') {
      cursor += 2;
      continue;
    }
    if (keyword.upper !== 'PREFIX') break;

    const name = tokens[cursor + 1];
    const iri = tokens[cursor + 2];
    if (name?.kind !== 'prefixed-name' || keyword.end === name.start || iri?.kind !== 'iri') break;
    if (
      name.logicalValue.indexOf(':') !== name.logicalValue.length - 1
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
function scanSparql(value: string): ScannedSparql | null {
  const masked = value.split('');
  const materialized: string[] = [];
  const tokens: SparqlLexicalToken[] = [];
  // Maintain expression context during the scan. Looking backwards through
  // all prior tokens for every IRI candidate makes long PREFIX lists
  // quadratic; this stack keeps the same nearest-group decision O(1).
  const openExpressionGroups: Array<'(' | '{'> = [];
  let unterminated = false;
  let index = 0;

  while (index < value.length) {
    const logical = readSparqlLogicalCodePoint(value, index);
    if (!logical) {
      return null;
    }
    if (isWhitespace(logical.codePoint)) {
      materialized.push(String.fromCodePoint(logical.codePoint));
      index += logical.rawWidth;
      continue;
    }

    if (logical.codePoint === 0x23) {
      const start = index;
      index += logical.rawWidth;
      const bodyStart = index;
      // UCHAR-looking text is inert once the comment has opened. Only an
      // actual source line ending closes the comment.
      while (index < value.length && value[index] !== '\n' && value[index] !== '\r') index++;
      materialized.push(
        String.fromCodePoint(logical.codePoint),
        value.slice(bodyStart, index),
      );
      blank(masked, start, index);
      continue;
    }

    if (logical.codePoint === 0x22 || logical.codePoint === 0x27) {
      const start = index;
      const stringScan = scanSparqlStringLiteral(value, start);
      if (!stringScan) {
        materialized.push(String.fromCodePoint(logical.codePoint));
        index += logical.rawWidth;
        continue;
      }
      if (stringScan.malformedUchar) return null;
      index = stringScan.end;
      materialized.push(value.slice(start, index));
      blank(masked, start, index);
      tokens.push({
        kind: 'string',
        raw: value.slice(start, index),
        start,
        end: index,
      });
      if (!stringScan.closed) unterminated = true;
      continue;
    }

    if (
      logical.codePoint === 0x3c
      && lessThanStartsIriRef(tokens, openExpressionGroups)
    ) {
      const iriScan = scanSparqlIriRef(value, index);
      if (iriScan !== null) {
        const start = index;
        index = iriScan.end;
        materialized.push(value.slice(start, index));
        blank(masked, start, index);
        tokens.push({
          kind: 'iri',
          raw: value.slice(start, index),
          logicalValue: iriScan.logicalValue,
          start,
          end: index,
        });
        continue;
      }
    }

    if (logical.codePoint === 0x3f || logical.codePoint === 0x24) {
      const variableEnd = readSparqlVariableEnd(value, index);
      if (variableEnd !== null) {
        const start = index;
        index = variableEnd;
        const token = lexicalToken('variable', value, start, index);
        if (!token) return null;
        tokens.push(token);
        materialized.push(token.logicalValue);
        continue;
      }
    }

    const numberEnd = scanNumberEnd(value, index);
    if (numberEnd !== null) {
      const start = index;
      index = numberEnd;
      const token = lexicalToken('number', value, start, index);
      if (!token) return null;
      tokens.push(token);
      materialized.push(token.logicalValue);
      continue;
    }

    if (logical.codePoint === 0x3a) {
      const start = index;
      index = scanPnLocalEnd(value, index + logical.rawWidth);
      const token = lexicalToken('prefixed-name', value, start, index);
      if (!token) return null;
      tokens.push(token);
      materialized.push(token.logicalValue);
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
      const token = lexicalToken(kind, value, start, index);
      if (!token) return null;
      tokens.push(token);
      materialized.push(token.logicalValue);
      continue;
    }

    const start = index;
    index += logical.rawWidth;
    const token = lexicalToken(
      'symbol',
      value,
      start,
      index,
      String.fromCodePoint(logical.codePoint),
    );
    if (!token) return null;
    tokens.push(token);
    materialized.push(token.logicalValue);
    updateOpenExpressionGroups(openExpressionGroups, token.logicalValue);
  }

  const maskedValue = masked.join('');
  const wordTokens = new Set<string>();
  for (const token of tokens) {
    if (token.kind === 'word') wordTokens.add(token.upper);
  }
  return {
    masked: maskedValue,
    materialized: materialized.join(''),
    tokens,
    unterminated,
    wordTokens,
    prologue: scanPrologue(tokens),
  };
}

/** Canonical lexical artifact with raw source coordinates and logical values. */
function malformedPreparedSparql(source: string): Extract<
  PreparedSparql,
  { readonly status: 'malformed-uchar' }
> {
  return {
    status: 'malformed-uchar',
    source,
    masked: ' '.repeat(source.length),
    materialized: source,
    tokens: [],
    unterminated: false,
    wordTokens: new Set(),
    prologue: { endTokenIndex: 0, declaredPrefixes: [] },
  };
}

function hasStableLexicalSemantics(
  checked: ScannedSparql,
  execution: ScannedSparql,
): boolean {
  if (
    checked.unterminated !== execution.unterminated
    || checked.tokens.length !== execution.tokens.length
  ) return false;

  return checked.tokens.every((token, index) => {
    const executionToken = execution.tokens[index];
    if (executionToken?.kind !== token.kind) return false;
    if (token.kind === 'string') return executionToken.raw === token.raw;
    if (executionToken.kind === 'string') return false;
    return executionToken.logicalValue === token.logicalValue;
  });
}

export function prepareSparql(source: string): PreparedSparql {
  const scan = scanSparql(source);
  if (scan === null) return malformedPreparedSparql(source);

  if (scan.materialized !== source) {
    // The store/backend performs its own SPARQL UCHAR preprocessing. A decoded
    // active U+005C must not combine with following source text to create a
    // second-generation escape that was absent from the checked token stream
    // (for example, `\\u005Cu0053ERVICE`). Opaque strings, IRI bodies, and
    // comments retain their raw spelling, so rescanning changes the text only
    // when materialization exposed newly active syntax. Reject that boundary
    // rather than handing a second decoder unchecked syntax.
    const executionScan = scanSparql(scan.materialized);
    if (
      executionScan === null
      || executionScan.materialized !== scan.materialized
      || !hasStableLexicalSemantics(scan, executionScan)
    ) {
      return malformedPreparedSparql(source);
    }
  }

  return {
    status: 'valid',
    source,
    masked: scan.masked,
    materialized: scan.materialized,
    tokens: scan.tokens,
    unterminated: scan.unterminated,
    wordTokens: new Set(scan.wordTokens),
    prologue: scan.prologue,
  };
}

/** Materialize active UCHAR syntax from the canonical prepared artifact. */
export function materializePreparedSparql(prepared: ValidPreparedSparql): string {
  return prepared.materialized;
}
