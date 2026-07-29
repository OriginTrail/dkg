export {
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
