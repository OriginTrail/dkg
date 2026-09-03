import {
  prepareSparql,
  readSparqlVariable,
  skipSparqlIriRef,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
  type PreparedSparql,
} from '@origintrail-official/dkg-rdf-utils/sparql';

export {
  stripSparqlLiteralsAndComments as stripLiteralsAndComments,
} from '@origintrail-official/dkg-core';

export {
  prepareSparql,
  readSparqlVariable,
  skipSparqlIriRef,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
};

/** Return the word facts already derived by canonical SPARQL preparation. */
export function collectSparqlWordTokens(
  source: string | PreparedSparql,
): ReadonlySet<string> {
  return typeof source === 'string' ? prepareSparql(source).wordTokens : source.wordTokens;
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
  return isWordStart(ch) || !!ch && ch >= '0' && ch <= '9';
}

/** Find a matching brace from prepared symbol tokens, never from payload text. */
export function findMatchingSparqlCloseBrace(
  sparql: string,
  openIdx: number,
  prepared: PreparedSparql = prepareSparql(sparql),
): number {
  let depth = 0;
  let opened = false;
  for (const token of prepared.tokens) {
    if (!('value' in token) || token.kind !== 'symbol') continue;
    const index = prepared.source === sparql ? token.start : token.normalizedStart;
    if (index < openIdx) continue;

    if (!opened) {
      if (index !== openIdx || token.logicalValue !== '{') return -1;
      opened = true;
      depth = 1;
      continue;
    }

    if (token.logicalValue === '{') {
      depth++;
    } else if (token.logicalValue === '}') {
      depth--;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}
