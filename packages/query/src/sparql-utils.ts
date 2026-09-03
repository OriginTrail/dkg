import {
  preprocessSparqlCodePointEscapes,
  readSparqlVariable,
  skipSparqlIriRefForStructuralScan,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
} from '@origintrail-official/dkg-core/sparql-cursors';

export {
  stripSparqlLiteralsAndComments as stripLiteralsAndComments,
} from '@origintrail-official/dkg-core';

// Keep the query package's cursor APIs stable while delegating their grammar
// and raw-offset handling to core's canonical low-level primitives.
export {
  preprocessSparqlCodePointEscapes,
  readSparqlVariable,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
};

export function skipSparqlIriRef(source: string, start: number): number | null {
  return skipSparqlIriRefForStructuralScan(source, start);
}

export function isSparqlKeywordStart(src: string, idx: number): boolean {
  const ch = src[idx];
  if (!isWordStart(ch)) return false;
  const prev = idx > 0 ? src[idx - 1] : '';
  return !prev || (
    !isSparqlWordContinuation(prev) &&
    prev !== '?' &&
    prev !== '$' &&
    prev !== ':' &&
    prev !== '#'
  );
}

export function isSparqlKeyword(
  src: string,
  start: number,
  end: number,
  keyword: string,
): boolean {
  const next = src[end];
  return src.slice(start, end).toUpperCase() === keyword
    && next !== ':'
    && next !== '-'
    && next !== '.';
}

function isWordStart(ch: string | undefined): boolean {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= 'a' && ch <= 'z') ||
    ch === '_'
  );
}

export function isSparqlWordContinuation(ch: string | undefined): ch is string {
  return isWordStart(ch) || (!!ch && ch >= '0' && ch <= '9');
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
