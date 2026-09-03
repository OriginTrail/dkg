import {
  decodeSparqlCodePointEscapes,
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
    readonly kind: 'iri' | 'string';
    readonly start: number;
    readonly end: number;
  };

export interface SparqlLexicalScan {
  /** Source-length-preserving view with strings, IRIs, and comments blanked. */
  readonly masked: string;
  /** Tokens outside comments, including opaque string and IRI boundary tokens. */
  readonly tokens: readonly SparqlLexicalToken[];
  readonly unterminated: boolean;
  readonly prologue: {
    readonly endTokenIndex: number;
    readonly declaredPrefixes: readonly string[];
  };
}

export interface SparqlLexicalMask {
  readonly masked: string;
  readonly unterminated: boolean;
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

function lexicalToken(
  kind: 'word' | 'variable' | 'prefixed-name' | 'symbol',
  value: string,
  start: number,
  end: number,
  logicalValue = decodeSparqlCodePointEscapes(value) ?? value,
): SparqlLexicalToken {
  return {
    kind,
    value,
    logicalValue,
    upper: logicalValue.toUpperCase(),
    start,
    end,
  };
}

function valuedToken(
  token: SparqlLexicalToken | undefined,
): token is Extract<SparqlLexicalToken, { value: string }> {
  return token !== undefined && 'value' in token;
}

function scanPrologue(tokens: readonly SparqlLexicalToken[]): SparqlLexicalScan['prologue'] {
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
function scanSparql(value: string): SparqlLexicalScan {
  const masked = value.split('');
  const tokens: SparqlLexicalToken[] = [];
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
      while (index < value.length) {
        const comment = readSparqlLogicalCodePoint(value, index);
        if (!comment) {
          index++;
          continue;
        }
        if (comment.codePoint === 0x0a || comment.codePoint === 0x0d) break;
        index += comment.rawWidth;
      }
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
      tokens.push({ kind: 'string', start, end: index });
      if (!stringScan.closed) unterminated = true;
      continue;
    }

    if (logical.codePoint === 0x3c) {
      const iriEnd = skipSparqlIriRef(value, index);
      if (iriEnd !== null) {
        const start = index;
        index = iriEnd;
        blank(masked, start, index);
        tokens.push({ kind: 'iri', start, end: index });
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

  return {
    masked: masked.join(''),
    tokens,
    unterminated,
    prologue: scanPrologue(tokens),
  };
}

export function scanSparqlLexically(value: string): SparqlLexicalScan {
  return scanSparql(value);
}

/** Derive the public mask view from the same complete lexical artifact. */
export function maskSparqlLexicalRegions(value: string): SparqlLexicalMask {
  const scan = scanSparql(value);
  return { masked: scan.masked, unterminated: scan.unterminated };
}
