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

