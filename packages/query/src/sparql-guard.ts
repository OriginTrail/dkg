/**
 * SPARQL query safety guard.
 *
 * The DKG controls writes exclusively via the publish/update protocol.
 * All user-facing SPARQL must be read-only (SELECT, CONSTRUCT, ASK, DESCRIBE).
 * This module rejects any SPARQL that attempts mutation operations.
 */

import type { Quad } from '@origintrail-official/dkg-storage';
import { stripLiteralsAndComments } from './sparql-utils.js';
import type { QueryResult } from './query-engine.js';

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

export type SparqlForm = 'SELECT' | 'CONSTRUCT' | 'ASK' | 'DESCRIBE';

/**
 * Classify the query form of a SPARQL string. Used by engines that need to
 * short-circuit a query (e.g. "no graphs resolved") while still returning a
 * result shape that matches the requested form — `QueryResult.bindings: []`
 * is not a valid ASK response (ASK must return a boolean binding) and is not
 * a valid CONSTRUCT/DESCRIBE response either (those must carry `quads: []`).
 */
export function classifySparqlForm(sparql: string): SparqlForm {
  const stripped = stripLiteralsAndComments(sparql);
  const match = READ_ONLY_FORMS.exec(stripped);
  const form = (match?.[1] ?? 'SELECT').toUpperCase();
  if (form === 'ASK' || form === 'CONSTRUCT' || form === 'DESCRIBE') {
    return form;
  }
  return 'SELECT';
}

/**
 * Produce an empty `QueryResult` that matches the requested query form.
 * Centralising this keeps every "nothing to query" short-circuit
 * (access-denied synthetic response, zero-graph resolution, etc.) aligned
 * on a single well-typed contract instead of returning `{ bindings: [] }`
 * for every form.
 */
export function emptyQueryResultForKind(sparql: string): QueryResult {
  const form = classifySparqlForm(sparql);
  if (form === 'ASK') {
    return { bindings: [{ result: 'false' }] };
  }
  if (form === 'CONSTRUCT' || form === 'DESCRIBE') {
    return { bindings: [], quads: [] as Quad[] };
  }
  return { bindings: [] };
}

