export type SparqlLexicalToken =
  | {
    readonly kind: 'word' | 'variable' | 'prefixed-name' | 'symbol';
    readonly value: string;
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

function codePointWidth(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1;
}

/** SPARQL 1.1 PN_CHARS_BASE, evaluated by code point while retaining UTF-16 offsets. */
function pnCharsBaseWidth(value: string, index: number): number {
  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) return 0;
  const accepted =
    (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a)
    || (codePoint >= 0x00c0 && codePoint <= 0x00d6)
    || (codePoint >= 0x00d8 && codePoint <= 0x00f6)
    || (codePoint >= 0x00f8 && codePoint <= 0x02ff)
    || (codePoint >= 0x0370 && codePoint <= 0x037d)
    || (codePoint >= 0x037f && codePoint <= 0x1fff)
    || (codePoint >= 0x200c && codePoint <= 0x200d)
    || (codePoint >= 0x2070 && codePoint <= 0x218f)
    || (codePoint >= 0x2c00 && codePoint <= 0x2fef)
    || (codePoint >= 0x3001 && codePoint <= 0xd7ff)
    || (codePoint >= 0xf900 && codePoint <= 0xfdcf)
    || (codePoint >= 0xfdf0 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0xeffff);
  return accepted ? codePointWidth(codePoint) : 0;
}

function pnCharsUWidth(value: string, index: number): number {
  return value[index] === '_' ? 1 : pnCharsBaseWidth(value, index);
}

function pnCharsWidth(value: string, index: number): number {
  const baseWidth = pnCharsUWidth(value, index);
  if (baseWidth) return baseWidth;
  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) return 0;
  const accepted = codePoint === 0x2d
    || (codePoint >= 0x30 && codePoint <= 0x39)
    || codePoint === 0x00b7
    || (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x203f && codePoint <= 0x2040);
  return accepted ? codePointWidth(codePoint) : 0;
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function isPrefixedNameTerminator(character: string | undefined): boolean {
  return character === undefined
    || isWhitespace(character)
    || ';,.(){}[]<>\'"'.includes(character);
}

function isSparqlIriRefBodyChar(character: string | undefined): character is string {
  return !!character && !/[<>"{}|^`\\\s]/.test(character) && character >= '\x21';
}

function blank(masked: string[], start: number, end: number): void {
  for (let index = start; index < end; index++) masked[index] = ' ';
}

function lexicalToken(
  kind: 'word' | 'variable' | 'prefixed-name' | 'symbol',
  value: string,
  start: number,
  end: number,
): SparqlLexicalToken {
  return { kind, value, upper: value.toUpperCase(), start, end };
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
    if (name.kind === 'symbol' && name.value === ':') {
      declaredPrefixes.push('');
      cursor += 3;
      continue;
    }
    if (name.kind !== 'prefixed-name' || !name.value.endsWith(':')) break;
    declaredPrefixes.push(name.value.slice(0, -1));
    cursor += 3;
  }
  return { endTokenIndex: cursor, declaredPrefixes };
}

/**
 * Dependency-light SPARQL lexical scan shared by operation classification and
 * higher-level policy checks. It is deliberately not a parser: it owns only
 * lexical regions, PN_PREFIX-aware names, source offsets, and masking.
 */
function scanSparql(value: string, tokenize: boolean): SparqlLexicalScan {
  const masked = value.split('');
  const tokens: SparqlLexicalToken[] = [];
  let unterminated = false;
  let index = 0;

  while (index < value.length) {
    const character = value[index];
    if (isWhitespace(character)) {
      index++;
      continue;
    }

    if (character === '#') {
      const start = index;
      while (index < value.length && value[index] !== '\n' && value[index] !== '\r') index++;
      blank(masked, start, index);
      continue;
    }

    if (character === '"' || character === "'") {
      const start = index;
      const triple = value[index + 1] === character && value[index + 2] === character;
      index += triple ? 3 : 1;
      let closed = false;
      while (index < value.length) {
        if (value[index] === '\\') {
          index = Math.min(value.length, index + 2);
          continue;
        }
        if (
          value[index] === character
          && (!triple || (value[index + 1] === character && value[index + 2] === character))
        ) {
          index += triple ? 3 : 1;
          closed = true;
          break;
        }
        index++;
      }
      blank(masked, start, index);
      if (tokenize) tokens.push({ kind: 'string', start, end: index });
      if (!closed) unterminated = true;
      continue;
    }

    if (character === '<') {
      const previous = index > 0 ? value[index - 1] : '';
      const comparison = previous
        && (/[a-zA-Z0-9?$_]/.test(previous) || previous === ')' || previous === ']');
      if (!comparison) {
        let cursor = index + 1;
        if (value[cursor] === '>' || isSparqlIriRefBodyChar(value[cursor])) {
          while (cursor < value.length && isSparqlIriRefBodyChar(value[cursor])) cursor++;
          if (value[cursor] === '>') {
            const start = index;
            index = cursor + 1;
            blank(masked, start, index);
            if (tokenize) tokens.push({ kind: 'iri', start, end: index });
            continue;
          }
        }
      }
    }

    const variableStart = (character === '?' || character === '$')
      ? pnCharsUWidth(value, index + 1)
      : 0;
    if (variableStart) {
      const start = index;
      index += 1 + variableStart;
      let width = pnCharsWidth(value, index);
      while (width) {
        index += width;
        width = pnCharsWidth(value, index);
      }
      if (tokenize) {
        tokens.push(lexicalToken('variable', value.slice(start, index), start, index));
      }
      continue;
    }

    const wordStart = pnCharsBaseWidth(value, index);
    if (wordStart) {
      const start = index;
      index += wordStart;
      let width = pnCharsWidth(value, index);
      while (width || value[index] === '.') {
        index += width || 1;
        width = pnCharsWidth(value, index);
      }
      let kind: 'word' | 'prefixed-name' = 'word';
      if (value[index] === ':' && value[index - 1] !== '.') {
        kind = 'prefixed-name';
        index++;
        while (!isPrefixedNameTerminator(value[index])) index++;
      }
      if (tokenize) {
        tokens.push(lexicalToken(kind, value.slice(start, index), start, index));
      }
      continue;
    }

    const start = index;
    index++;
    if (tokenize) {
      tokens.push(lexicalToken('symbol', value.slice(start, index), start, index));
    }
  }

  return {
    masked: masked.join(''),
    tokens,
    unterminated,
    prologue: scanPrologue(tokens),
  };
}

export function scanSparqlLexically(value: string): SparqlLexicalScan {
  return scanSparql(value, true);
}

/** Mask lexical regions without allocating a token stream or policy facts. */
export function maskSparqlLexicalRegions(value: string): SparqlLexicalMask {
  const scan = scanSparql(value, false);
  return { masked: scan.masked, unterminated: scan.unterminated };
}
