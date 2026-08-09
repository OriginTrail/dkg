const PN_LOCAL_ESC_CHAR = /[_~.\-!$&'()*+,;=/?#@%]/u;
const SPARQL_PN_LOCAL_ESCAPED_CHARS = new Set(
  [..."_~.-!$&'()*+,;=/?#@%"],
);

function isSparqlIriRefBodyChar(ch: string | undefined): ch is string {
  return !!ch && !/[<>"{}|^`\\\s]/.test(ch) && ch >= '\x21';
}

function isEscapedPnLocalCharAt(src: string, index: number): boolean {
  return index >= 1
    && src[index - 1] === '\\'
    && PN_LOCAL_ESC_CHAR.test(src[index] ?? '');
}

export function stripSparqlLiteralsAndComments(sparql: string): string {
  const out = new Array<string>(sparql.length);
  let i = 0;
  const n = sparql.length;

  while (i < n) {
    const ch = sparql[i];

    if (
      (ch === '"' || ch === "'")
      && sparql[i + 1] === ch
      && sparql[i + 2] === ch
    ) {
      const start = i;
      i += 3;
      while (i < n) {
        if (sparql[i] === '\\') { i += 2; continue; }
        if (sparql[i] === ch && sparql[i + 1] === ch && sparql[i + 2] === ch) {
          i += 3;
          break;
        }
        i++;
      }
      for (let j = start; j < i && j < n; j++) out[j] = ' ';
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sparql[i] === '\\') { i += 2; continue; }
        if (sparql[i] === ch) { i++; break; }
        i++;
      }
      for (let j = start; j < i && j < n; j++) out[j] = ' ';
      continue;
    }

    if (ch === '<') {
      const prev = i > 0 ? sparql[i - 1] : '';
      const isComparison = prev
        && (/[a-zA-Z0-9?$_]/.test(prev) || prev === ')' || prev === ']');
      if (!isComparison) {
        const next = sparql[i + 1];
        if (next === '>' || isSparqlIriRefBodyChar(next)) {
          const start = i;
          i++;
          while (i < n && isSparqlIriRefBodyChar(sparql[i])) i++;
          if (i < n && sparql[i] === '>') {
            i++;
            for (let j = start; j < i; j++) out[j] = ' ';
            continue;
          }
        }
      }
    }

    if (ch === '#' && !isEscapedPnLocalCharAt(sparql, i)) {
      const start = i;
      while (i < n && sparql[i] !== '\n') i++;
      for (let j = start; j < i; j++) out[j] = ' ';
      continue;
    }

    out[i] = ch;
    i++;
  }

  return out.join('');
}

function isSparqlNameCharacter(ch: string | undefined): boolean {
  return ch !== undefined && (
    isSparqlWordContinuation(ch)
    || /[\p{L}\p{N}\p{M}:@-]/u.test(ch)
  );
}

/** A dot joins PN_LOCAL text only when the same uninterrupted token has a prefix colon. */
function isPrefixedNameDotBefore(src: string, index: number): boolean {
  if (src[index - 1] !== '.') return false;
  for (let cursor = index - 2; cursor >= 0; cursor--) {
    const ch = src[cursor];
    if (ch === ':') return true;
    if (ch === '.' || isSparqlNameCharacter(ch)) continue;
    if (isEscapedPnLocalCharAt(src, cursor)) {
      cursor--;
      continue;
    }
    return false;
  }
  return false;
}

function isSparqlNameAdjacentBefore(src: string, index: number): boolean {
  const previous = src[index - 1];
  return isSparqlNameCharacter(previous)
    || previous === '?'
    || previous === '$'
    || isPrefixedNameDotBefore(src, index)
    || isEscapedPnLocalCharAt(src, index - 1);
}

function isSparqlNameAdjacentAfter(src: string, index: number): boolean {
  return isSparqlNameCharacter(src[index])
    || (src[index] === '\\' && PN_LOCAL_ESC_CHAR.test(src[index + 1] ?? ''));
}

function isSparqlWordStart(ch: string | undefined): boolean {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z')
    || (ch >= 'a' && ch <= 'z')
    || ch === '_'
  );
}

/** @deprecated Use readStandaloneSparqlWord so boundary and token length share one model. */
export function isSparqlWordContinuation(ch: string | undefined): ch is string {
  return isSparqlWordStart(ch) || (!!ch && ch >= '0' && ch <= '9');
}

export interface StandaloneSparqlWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/** Read one standalone ASCII SPARQL word using the canonical name boundary model. */
export function readStandaloneSparqlWord(
  src: string,
  start: number,
): StandaloneSparqlWord | null {
  if (!isSparqlWordStart(src[start]) || isSparqlNameAdjacentBefore(src, start)) return null;
  if (readSparqlPrefixName(src, start) !== null) return null;
  let end = start + 1;
  while (end < src.length && isSparqlWordContinuation(src[end])) end++;
  if (isSparqlNameAdjacentAfter(src, end)) return null;
  return Object.freeze({ word: src.slice(start, end).toUpperCase(), start, end });
}

/** @deprecated Use readStandaloneSparqlWord and inspect the returned token. */
export function isSparqlKeywordStart(src: string, start: number): boolean {
  return readStandaloneSparqlWord(src, start) !== null;
}

/** @deprecated Use readStandaloneSparqlWord and inspect the returned token. */
export function isSparqlKeyword(
  src: string,
  start: number,
  end: number,
  keyword: string,
): boolean {
  const token = readStandaloneSparqlWord(src, start);
  return token?.end === end && token.word === keyword;
}

export interface SparqlPrefixName {
  readonly prefix: string;
  readonly local: string;
  readonly length: number;
}

/** Read one complete SPARQL prefixed name using the canonical PN_PREFIX/PN_LOCAL grammar. */
export function readSparqlPrefixName(
  sparql: string,
  start: number,
): SparqlPrefixName | null {
  const colon = readSparqlPrefixLabelEnd(sparql, start);
  if (sparql[colon] !== ':') return null;

  const end = readSparqlPrefixedLocalEnd(sparql, colon + 1);
  return Object.freeze({
    prefix: sparql.slice(start, colon),
    local: sparql.slice(colon + 1, end),
    length: end - start,
  });
}

function readSparqlPrefixLabelEnd(sparql: string, start: number): number {
  let cursor = start;
  let lastTerminalEnd = start;
  let position = 0;

  while (cursor < sparql.length) {
    const next = readCodePoint(sparql, cursor);
    if (!next) break;
    const allowed = position === 0
      ? isSparqlPnCharsBaseCodePoint(next.codePoint)
      : isSparqlPnCharsCodePoint(next.codePoint) || next.codePoint === 0x2e;
    if (!allowed) break;

    cursor += next.width;
    position++;
    if (next.codePoint !== 0x2e) lastTerminalEnd = cursor;
  }

  return lastTerminalEnd;
}

function readSparqlPrefixedLocalEnd(sparql: string, start: number): number {
  let cursor = start;
  let lastTerminalEnd = start;
  let localPosition = 0;

  while (cursor < sparql.length) {
    const ch = sparql[cursor];
    if (
      ch === '\\'
      && SPARQL_PN_LOCAL_ESCAPED_CHARS.has(sparql[cursor + 1] ?? '')
    ) {
      cursor += 2;
      lastTerminalEnd = cursor;
      localPosition++;
      continue;
    }
    if (
      ch === '%'
      && isAsciiHexDigit(sparql[cursor + 1])
      && isAsciiHexDigit(sparql[cursor + 2])
    ) {
      cursor += 3;
      lastTerminalEnd = cursor;
      localPosition++;
      continue;
    }

    const next = readCodePoint(sparql, cursor);
    if (!next) break;
    const allowed = localPosition === 0
      ? isSparqlPnLocalInitialCodePoint(next.codePoint)
      : isSparqlPnLocalContinuationCodePoint(next.codePoint);
    if (!allowed) break;

    cursor += next.width;
    localPosition++;
    if (next.codePoint !== 0x2e) lastTerminalEnd = cursor;
  }

  return lastTerminalEnd;
}

/** Skip one SPARQL short or triple-quoted literal. */
export function skipSparqlStringLiteral(src: string, start: number): number {
  const n = src.length;
  if (start >= n) return start;
  const ch = src[start];
  if (ch !== '"' && ch !== "'") return start;
  if (start + 2 < n && src[start + 1] === ch && src[start + 2] === ch) {
    let cursor = start + 3;
    while (cursor < n) {
      if (src[cursor] === '\\' && cursor + 1 < n) {
        cursor += 2;
        continue;
      }
      if (
        src[cursor] === ch
        && cursor + 2 < n
        && src[cursor + 1] === ch
        && src[cursor + 2] === ch
      ) {
        return cursor + 3;
      }
      cursor++;
    }
    return n;
  }
  let cursor = start + 1;
  while (cursor < n) {
    if (src[cursor] === '\\' && cursor + 1 < n) {
      cursor += 2;
      continue;
    }
    if (src[cursor] === ch) return cursor + 1;
    cursor++;
  }
  return cursor;
}

/** Skip a syntactically valid SPARQL IRIREF, or return null for `<` comparisons. */
export function skipSparqlIriRef(sparql: string, start: number): number | null {
  if (sparql[start] !== '<') return null;
  const next = sparql[start + 1];
  if (!isLikelyIriRefStart(next)) return null;

  for (let i = start + 1; i < sparql.length; i++) {
    const ch = sparql[i];
    if (ch === '>') return i + 1;
    if (
      ch === '<'
      || ch === '"'
      || ch === '{'
      || ch === '}'
      || ch === '|'
      || ch === '\\'
      || ch === '^'
      || ch === '`'
      || /\s/u.test(ch)
    ) {
      return null;
    }
  }
  return null;
}

function isLikelyIriRefStart(ch: string | undefined): boolean {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z')
    || (ch >= 'a' && ch <= 'z')
    || ch === '#'
    || ch === '_'
    || ch === '/'
    || ch === '.'
  );
}

/** Read a SPARQL variable using the full Unicode variable-name grammar. */
export function readSparqlVariable(sparql: string, start: number): string | null {
  const sigil = sparql[start];
  if (sigil !== '?' && sigil !== '$') return null;
  let end = start + 1;
  const first = readCodePoint(sparql, end);
  if (!first || !isSparqlVariableInitialCodePoint(first.codePoint)) return null;
  end += first.width;

  while (end < sparql.length) {
    const next = readCodePoint(sparql, end);
    if (!next || !isSparqlVariableContinuationCodePoint(next.codePoint)) break;
    end += next.width;
  }
  return sparql.slice(start, end);
}

/** Skip whitespace and `#` line comments between SPARQL tokens. */
export function skipSparqlSpaceAndLineComments(sparql: string, start: number): number {
  let cursor = start;
  while (cursor < sparql.length) {
    if (/\s/u.test(sparql[cursor])) {
      cursor++;
      continue;
    }
    if (sparql[cursor] === '#') {
      while (cursor < sparql.length && sparql[cursor] !== '\n') cursor++;
      continue;
    }
    break;
  }
  return cursor;
}

export type SparqlCodeToken =
  | { readonly kind: 'word'; readonly word: string; readonly start: number; readonly end: number }
  | { readonly kind: 'iri'; readonly iri: string; readonly start: number; readonly end: number }
  | { readonly kind: 'variable'; readonly variable: string; readonly start: number; readonly end: number }
  | { readonly kind: 'prefixedName'; readonly prefixedName: SparqlPrefixName; readonly start: number; readonly end: number }
  | { readonly kind: 'char'; readonly value: string; readonly start: number; readonly end: number };

/** Read the next significant token while skipping whitespace, comments, and literals. */
export function readNextSparqlCodeToken(
  sparql: string,
  start: number,
  limit = sparql.length,
): SparqlCodeToken | null {
  let cursor = start;
  const end = Math.min(limit, sparql.length);
  while (cursor < end) {
    const ch = sparql[cursor];
    if (/\s/u.test(ch)) {
      cursor++;
      continue;
    }
    if (ch === '#') {
      while (cursor < end && sparql[cursor] !== '\n') cursor++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      cursor = Math.min(skipSparqlStringLiteral(sparql, cursor), end);
      continue;
    }
    if (ch === '<') {
      const iriEnd = skipSparqlIriRef(sparql, cursor);
      if (iriEnd !== null && iriEnd <= end) {
        return Object.freeze({
          kind: 'iri',
          iri: sparql.slice(cursor + 1, iriEnd - 1),
          start: cursor,
          end: iriEnd,
        });
      }
    }
    const variable = readSparqlVariable(sparql, cursor);
    if (variable !== null && cursor + variable.length <= end) {
      return Object.freeze({
        kind: 'variable',
        variable,
        start: cursor,
        end: cursor + variable.length,
      });
    }
    const prefixedName = readSparqlPrefixName(sparql, cursor);
    if (prefixedName !== null && cursor + prefixedName.length <= end) {
      return Object.freeze({
        kind: 'prefixedName',
        prefixedName,
        start: cursor,
        end: cursor + prefixedName.length,
      });
    }
    const word = readStandaloneSparqlWord(sparql, cursor);
    if (word !== null && word.end <= end) {
      return Object.freeze({ kind: 'word', ...word });
    }
    return Object.freeze({
      kind: 'char',
      value: ch,
      start: cursor,
      end: cursor + 1,
    });
  }
  return null;
}

/** Iterate significant SPARQL tokens while owning cursor advancement. */
export function* iterateSparqlCodeTokens(
  sparql: string,
  start = 0,
  limit = sparql.length,
): Generator<SparqlCodeToken, void, undefined> {
  let cursor = start;
  for (let token = readNextSparqlCodeToken(sparql, cursor, limit); token !== null;
    token = readNextSparqlCodeToken(sparql, cursor, limit)) {
    yield token;
    cursor = token.end;
  }
}

/** Find the closing brace while treating strings, comments, and IRIREFs as opaque. */
export function findMatchingSparqlCloseBrace(sparql: string, openIdx: number): number {
  if (sparql[openIdx] !== '{') return -1;
  let depth = 0;
  for (const token of iterateSparqlCodeTokens(sparql, openIdx)) {
    if (token.kind !== 'char') continue;
    if (token.value === '{') depth++;
    else if (token.value === '}') {
      depth--;
      if (depth === 0) return token.start;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function isSparqlVariableInitialCodePoint(codePoint: number): boolean {
  return isSparqlPnCharsUCodePoint(codePoint) || isAsciiDigitCodePoint(codePoint);
}

function isSparqlVariableContinuationCodePoint(codePoint: number): boolean {
  return isSparqlPnCharsUCodePoint(codePoint)
    || isAsciiDigitCodePoint(codePoint)
    || isSparqlPnCharsExtraCodePoint(codePoint);
}

function isSparqlPnLocalInitialCodePoint(codePoint: number): boolean {
  return isSparqlPnCharsUCodePoint(codePoint)
    || isAsciiDigitCodePoint(codePoint)
    || codePoint === 0x3a;
}

function isSparqlPnLocalContinuationCodePoint(codePoint: number): boolean {
  return isSparqlPnLocalInitialCodePoint(codePoint)
    || codePoint === 0x2d
    || codePoint === 0x2e
    || isSparqlPnCharsExtraCodePoint(codePoint);
}

function isSparqlPnCharsCodePoint(codePoint: number): boolean {
  return isSparqlPnCharsUCodePoint(codePoint)
    || isAsciiDigitCodePoint(codePoint)
    || codePoint === 0x2d
    || isSparqlPnCharsExtraCodePoint(codePoint);
}

function isSparqlPnCharsExtraCodePoint(codePoint: number): boolean {
  return codePoint === 0x00b7
    || (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x203f && codePoint <= 0x2040);
}

function isSparqlPnCharsUCodePoint(codePoint: number): boolean {
  return codePoint === 0x5f || isSparqlPnCharsBaseCodePoint(codePoint);
}

function isSparqlPnCharsBaseCodePoint(codePoint: number): boolean {
  return isAsciiAlphaCodePoint(codePoint)
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
}

function readCodePoint(src: string, index: number): { codePoint: number; width: number } | null {
  if (index >= src.length) return null;
  const codePoint = src.codePointAt(index);
  if (codePoint === undefined) return null;
  return { codePoint, width: codePoint > 0xffff ? 2 : 1 };
}

function isAsciiAlphaCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a);
}

function isAsciiDigitCodePoint(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x39;
}

function isAsciiHexDigit(ch: string | undefined): boolean {
  return !!ch && /[0-9A-Fa-f]/u.test(ch);
}
