/**
 * SPARQL query safety guard.
 *
 * The DKG controls writes exclusively via the publish/update protocol.
 * All user-facing SPARQL must be read-only (SELECT, CONSTRUCT, ASK, DESCRIBE).
 * This module rejects any SPARQL that attempts mutation operations.
 */

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

/** SPARQL query form — enough to shape a `QueryResult` correctly. */
export type SparqlQueryForm = 'SELECT' | 'CONSTRUCT' | 'ASK' | 'DESCRIBE' | 'UNKNOWN';

/**
 * PR #229 bot review round 17 (r17-2): classify a read-only SPARQL
 * query so callers can produce a result shape that MATCHES what the
 * query engine would return for a successful-but-empty execution of
 * the same form:
 *
 *   - SELECT  → `{ bindings: [] }`
 *   - ASK     → `{ bindings: [{ result: 'false' }] }` (the `dkg-query-engine`
 *               convention: ASK results surface through bindings so
 *               callers don't need a separate branch)
 *   - CONSTRUCT / DESCRIBE → `{ bindings: [], quads: [] }`
 *   - UNKNOWN → `{ bindings: [] }` (safe default; unreachable from
 *               inside `DKGAgent.query` because `validateReadOnlySparql`
 *               rejects anything that doesn't match a known form)
 *
 * This lets fail-closed branches (WM cross-agent auth denial, private-CG
 * leak guard, quota exceed, ...) emit a result indistinguishable from
 * an empty legitimate response, without breaking downstream callers
 * that branch on the presence of `quads`.
 */
export function detectSparqlQueryForm(sparql: string): SparqlQueryForm {
  const stripped = stripLiteralsAndComments(sparql);
  const m = READ_ONLY_FORMS.exec(stripped);
  if (!m) return 'UNKNOWN';
  const kw = m[1].toUpperCase();
  if (kw === 'SELECT' || kw === 'CONSTRUCT' || kw === 'ASK' || kw === 'DESCRIBE') {
    return kw;
  }
  return 'UNKNOWN';
}

/**
 * Shape of an empty `QueryResult`.
 *
 * Now an alias of the canonical `QueryResult` so the empty-shape
 * contract and the success-shape contract cannot drift. Callers can
 * treat `EmptyQueryResultShape` and `QueryResult` interchangeably —
 * the only difference is a structural guarantee that `bindings` is
 * empty (and `quads`, when present, is `[]`).
 */
export type EmptyQueryResultShape = QueryResult;

/**
 * Build a shape-matched empty `QueryResult` for a given SPARQL form.
 *
 * Returns a FRESH object on every call so callers can safely mutate
 * it (append bindings on a subsequent fallthrough, e.g.) without
 * worrying about cross-call aliasing.
 *
 * PR #229 bot review (r3148... — sparql-guard.ts:56). This is the
 * SINGLE canonical empty-shape builder for the package — there is no
 * parallel `emptyQueryResultForKind` helper anymore. Any future
 * change to `QueryResult` only has to update this function and
 * `detectSparqlQueryForm` (also in this file).
 */
export function emptyResultForForm(form: SparqlQueryForm): QueryResult {
  if (form === 'CONSTRUCT' || form === 'DESCRIBE') {
    return { bindings: [], quads: [] };
  }
  if (form === 'ASK') {
    return { bindings: [{ result: 'false' }] };
  }
  return { bindings: [] };
}

/**
 * One-shot ergonomic helper: classify the SPARQL string and build a
 * shape-matched empty `QueryResult` in a single call. Equivalent to
 * `emptyResultForForm(detectSparqlQueryForm(sparql))` and exists
 * solely so callers that don't already need the form for branching
 * don't have to write the two-step every time.
 *
 * PR #229 bot review (r3148... — sparql-guard.ts:56) consolidation:
 * before this consolidation, two parallel pairs lived in this file
 * (`detectSparqlQueryForm` + `emptyResultForForm` AND
 * `classifySparqlForm` + `emptyQueryResultForKind`). The legacy pair
 * is gone; this helper replaces the legacy `emptyQueryResultForKind`
 * call sites without re-introducing a parallel classifier.
 */
export function emptyResultForSparql(sparql: string): QueryResult {
  return emptyResultForForm(detectSparqlQueryForm(sparql));
}

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
