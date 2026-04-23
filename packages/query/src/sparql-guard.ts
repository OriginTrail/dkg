/**
 * SPARQL query safety guard.
 *
 * The DKG controls writes exclusively via the publish/update protocol.
 * All user-facing SPARQL must be read-only (SELECT, CONSTRUCT, ASK, DESCRIBE).
 * This module rejects any SPARQL that attempts mutation operations.
 */

import { stripLiteralsAndComments } from './sparql-utils.js';

const MUTATING_KEYWORDS = [
  'INSERT',
  'DELETE',
  'LOAD',
  'CLEAR',
  'DROP',
  'CREATE',
  'COPY',
  'MOVE',
  'ADD',
] as const;

const MUTATING_PATTERN = new RegExp(
  `\\b(${MUTATING_KEYWORDS.join('|')})\\b`,
  'i',
);

// Matches the query form keyword after optional PREFIX/BASE preamble
const READ_ONLY_FORMS = /^\s*(?:(?:PREFIX|BASE)\s+[^\n]*\n\s*)*(SELECT|CONSTRUCT|ASK|DESCRIBE)\b/i;

export interface SparqlGuardResult {
  safe: boolean;
  reason?: string;
}

/**
 * Validates that a SPARQL query is read-only.
 * Returns `{ safe: true }` for SELECT/CONSTRUCT/ASK/DESCRIBE.
 * Returns `{ safe: false, reason }` for anything that could mutate data.
 */
export function validateReadOnlySparql(sparql: string): SparqlGuardResult {
  const stripped = stripLiteralsAndComments(sparql);

  if (!READ_ONLY_FORMS.test(stripped)) {
    return {
      safe: false,
      reason: `Query must start with SELECT, CONSTRUCT, ASK, or DESCRIBE. ` +
        `Mutations must go through the publish/update protocol.`,
    };
  }

  const match = MUTATING_PATTERN.exec(stripped);
  if (match) {
    return {
      safe: false,
      reason: `Query contains mutating keyword "${match[1]}". ` +
        `Use the publish() or update() API to modify data.`,
    };
  }

  return { safe: true };
}

export type SparqlQueryKind = 'SELECT' | 'ASK' | 'CONSTRUCT' | 'DESCRIBE';

/**
 * Detect the top-level SPARQL query form (SELECT / ASK / CONSTRUCT / DESCRIBE),
 * stripping any leading PREFIX / BASE preamble, comments, and string literals.
 * Defaults to SELECT if nothing matches — callers that need strictness should
 * pair this with {@link validateReadOnlySparql}.
 *
 * Used by access-denied synthetic responses so that denying an ASK query
 * returns `{ bindings: [{ result: 'false' }] }` instead of a SELECT-shaped
 * empty-bindings object, preserving the HTTP contract for every query form.
 */
export function detectSparqlQueryKind(sparql: string): SparqlQueryKind {
  const stripped = stripLiteralsAndComments(sparql);
  const match = READ_ONLY_FORMS.exec(stripped);
  if (!match) return 'SELECT';
  return match[1].toUpperCase() as SparqlQueryKind;
}

/**
 * Return an empty query result shaped to match the SPARQL query form.
 *
 *  - SELECT    → `{ bindings: [] }`
 *  - ASK       → `{ bindings: [{ result: 'false' }] }`
 *  - CONSTRUCT → `{ bindings: [], quads: [] }`
 *  - DESCRIBE  → `{ bindings: [], quads: [] }`
 *
 * This mirrors the shape {@link DKGQueryEngine.execAndNormalize} produces
 * for a successfully-executed query that happened to match no data — so
 * an access-denied synthetic response is indistinguishable from a real
 * empty result at the wire level.
 */
export function emptyQueryResultForKind(
  sparql: string,
): { bindings: Array<Record<string, string>>; quads?: unknown[] } {
  const kind = detectSparqlQueryKind(sparql);
  if (kind === 'ASK') return { bindings: [{ result: 'false' }] };
  if (kind === 'CONSTRUCT' || kind === 'DESCRIBE') return { bindings: [], quads: [] };
  return { bindings: [] };
}

