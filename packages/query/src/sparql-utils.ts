export {
  readStandaloneSparqlWord,
  stripSparqlLiteralsAndComments as stripLiteralsAndComments,
} from '@origintrail-official/dkg-core';

/**
 * Skip one SPARQL short or triple-quoted literal, treating unterminated input
 * as opaque through the end of the source.
 */
export function skipSparqlStringLiteral(src: string, i: number): number {
  const n = src.length;
  if (i >= n) return i;
  const ch = src[i];
  if (ch !== '"' && ch !== "'") return i;
  if (i + 2 < n && src[i + 1] === ch && src[i + 2] === ch) {
    let j = i + 3;
    while (j < n) {
      if (src[j] === '\\' && j + 1 < n) {
        j += 2;
        continue;
      }
      if (
        src[j] === ch &&
        j + 2 < n &&
        src[j + 1] === ch &&
        src[j + 2] === ch
      ) {
        return j + 3;
      }
      j++;
    }
    return n;
  }
  let j = i + 1;
  while (j < n) {
    if (src[j] === '\\' && j + 1 < n) {
      j += 2;
      continue;
    }
    if (src[j] === ch) return j + 1;
    j++;
  }
  return j;
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
      ch === '<' ||
      ch === '"' ||
      ch === '{' ||
      ch === '}' ||
      ch === '|' ||
      ch === '\\' ||
      ch === '^' ||
      ch === '`' ||
      /\s/.test(ch)
    ) {
      return null;
    }
  }
  return null;
}

function isLikelyIriRefStart(ch: string | undefined): boolean {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= 'a' && ch <= 'z') ||
    ch === '#' ||
    ch === '_' ||
    ch === '/' ||
    ch === '.'
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

function readCodePoint(src: string, index: number): { codePoint: number; width: number } | null {
  if (index >= src.length) return null;
  const codePoint = src.codePointAt(index);
  if (codePoint === undefined) return null;
  return { codePoint, width: codePoint > 0xffff ? 2 : 1 };
}

function isSparqlVariableInitialCodePoint(codePoint: number): boolean {
  return isSparqlPnCharsUCodePoint(codePoint) || isAsciiDigitCodePoint(codePoint);
}

function isSparqlVariableContinuationCodePoint(codePoint: number): boolean {
  return (
    isSparqlPnCharsUCodePoint(codePoint) ||
    isAsciiDigitCodePoint(codePoint) ||
    codePoint === 0x00b7 ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x203f && codePoint <= 0x2040)
  );
}

function isSparqlPnCharsUCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x5f ||
    isAsciiAlphaCodePoint(codePoint) ||
    (codePoint >= 0x00c0 && codePoint <= 0x00d6) ||
    (codePoint >= 0x00d8 && codePoint <= 0x00f6) ||
    (codePoint >= 0x00f8 && codePoint <= 0x02ff) ||
    (codePoint >= 0x0370 && codePoint <= 0x037d) ||
    (codePoint >= 0x037f && codePoint <= 0x1fff) ||
    (codePoint >= 0x200c && codePoint <= 0x200d) ||
    (codePoint >= 0x2070 && codePoint <= 0x218f) ||
    (codePoint >= 0x2c00 && codePoint <= 0x2fef) ||
    (codePoint >= 0x3001 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
    (codePoint >= 0xfdf0 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0xeffff)
  );
}

function isAsciiAlphaCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a)
  );
}

function isAsciiDigitCodePoint(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x39;
}

/** Skip whitespace and `#` line comments between SPARQL tokens. */
export function skipSparqlSpaceAndLineComments(sparql: string, start: number): number {
  let i = start;
  while (i < sparql.length) {
    if (/\s/.test(sparql[i])) {
      i++;
      continue;
    }
    if (sparql[i] === '#') {
      while (i < sparql.length && sparql[i] !== '\n') i++;
      continue;
    }
    break;
  }
  return i;
}

/** Find the closing brace while treating strings, comments, and IRIREFs as opaque. */
export function findMatchingSparqlCloseBrace(sparql: string, openIdx: number): number {
  if (sparql[openIdx] !== '{') return -1;
  let depth = 0;
  let i = openIdx;
  while (i < sparql.length) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < sparql.length && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const iriEnd = skipSparqlIriRef(sparql, i);
      if (iriEnd) {
        i = iriEnd;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
    i++;
  }
  return -1;
}
