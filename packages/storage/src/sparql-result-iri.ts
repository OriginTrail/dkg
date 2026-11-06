import { isSafeResultIri } from '@origintrail-official/dkg-core';

const MAX_CACHED_IRI_LENGTH = 1024;
const MAX_CONSECUTIVE_IRI_MISSES = 16;
const PAUSED_IRI_COMPARISON_ROWS = 128;

export const MAX_CACHED_SPARQL_IRI_VARIABLES = 128;
export type SparqlResultIriValidator = (value: string) => boolean;

/** Match the established JSON/TSV result contract, including bare `scheme:` IRIs. */
export function isSafeSparqlResultIri(value: string): boolean {
  return isSafeResultIri(value);
}

/** One last successful value per response column role, never a growing cache. */
export function createSparqlResultIriValidator(): SparqlResultIriValidator {
  let lastValidIri: string | undefined;
  let consecutiveMisses = 0;
  let pausedRows = 0;
  return value => {
    if (pausedRows > 0) {
      pausedRows -= 1;
      return isSafeSparqlResultIri(value);
    }
    if (value === lastValidIri) {
      consecutiveMisses = 0;
      return true;
    }
    const valid = isSafeSparqlResultIri(value);
    if (valid && value.length <= MAX_CACHED_IRI_LENGTH) lastValidIri = value;
    consecutiveMisses += 1;
    if (consecutiveMisses >= MAX_CONSECUTIVE_IRI_MISSES) {
      pausedRows = PAUSED_IRI_COMPARISON_ROWS;
      consecutiveMisses = 0;
      lastValidIri = undefined;
    }
    return valid;
  };
}
