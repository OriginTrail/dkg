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
 * classify a read-only SPARQL
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
 * — sparql-guard.ts:56). This is the
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
 * — sparql-guard.ts:56) consolidation:
 * before this consolidation, two parallel pairs lived in this file
 * (`detectSparqlQueryForm` + `emptyResultForForm` AND
 * `classifySparqlForm` + `emptyQueryResultForKind`). The legacy pair
 * is gone; this helper replaces the legacy `emptyQueryResultForKind`
 * call sites without re-introducing a parallel classifier.
 */
export function emptyResultForSparql(sparql: string): QueryResult {
  return emptyResultForForm(detectSparqlQueryForm(sparql));
}

// ─────────────────────────────────────────────────────────────────────
// packages/query/src/index.ts:7).
//
// r30-3 consolidated two parallel SPARQL form classifier pairs onto
// the canonical `detectSparqlQueryForm` + `emptyResultForForm` pair
// and DELETED the legacy `classifySparqlForm` + `emptyQueryResultForKind`
// + `SparqlForm` symbols outright. The bot's r31-2 thread on
// `packages/query/src/index.ts:7` flagged the deletion as a source-
// breaking API change for downstream consumers of
// `@origintrail-official/dkg-query` even though the package version
// here is unchanged.
//
// Restored as `@deprecated` wrappers + a re-exported type alias.
// Same semantic behaviour as the legacy pair (notably:
// `classifySparqlForm` silently mapped unparseable input to
// `'SELECT'` rather than `'UNKNOWN'`, which the wrapper preserves
// to keep BYTE-COMPATIBLE branching for any caller that switches
// on the form). The internal call sites in `dkg-query-engine.ts`
// and `dkg-agent.ts` continue to use the canonical pair so the
// drift surface r30-3 closed stays closed.
//
// Migration path for consumers:
//   - `classifySparqlForm(s)` → `detectSparqlQueryForm(s)` (returns
//     `'UNKNOWN'` instead of silently coercing to `'SELECT'`).
//   - `emptyQueryResultForKind(form)` → `emptyResultForForm(form)`
//     (drop-in replacement; same shape, same fresh-object guarantee).
//   - `SparqlForm` type → `SparqlQueryForm` (adds the `'UNKNOWN'`
//     variant so unparseable input is observable rather than
//     silently coerced).
// ─────────────────────────────────────────────────────────────────────

/**
 * @deprecated
 *
 * Legacy SPARQL form type. The canonical replacement is
 * {@link SparqlQueryForm}, which adds an explicit `'UNKNOWN'`
 * variant so unparseable input is observable rather than silently
 * coerced to `'SELECT'`. Migrate at your earliest convenience —
 * this alias will be removed in the next breaking release of
 * `@origintrail-official/dkg-query`.
 */
export type SparqlForm = 'SELECT' | 'CONSTRUCT' | 'ASK' | 'DESCRIBE';

/**
 * @deprecated
 *
 * Legacy classifier preserved as a thin wrapper. Use
 * {@link detectSparqlQueryForm} for new code — it returns the
 * richer {@link SparqlQueryForm} type with a `'UNKNOWN'` variant so
 * unparseable input is observable rather than silently coerced to
 * `'SELECT'`.
 *
 * **Behavioural compat note**: this wrapper preserves the legacy
 * "unparseable → `'SELECT'`" mapping so any caller that switches
 * on the returned string keeps branching identically across the
 * deprecation window. New code should call `detectSparqlQueryForm`
 * directly and handle the `'UNKNOWN'` variant explicitly — the
 * silent SELECT coercion is exactly the drift hazard the canonical
 * helper closes.
 */
export function classifySparqlForm(sparql: string): SparqlForm {
  const form = detectSparqlQueryForm(sparql);
  if (form === 'UNKNOWN') return 'SELECT';
  return form;
}

/**
 * @deprecated
 *
 * Legacy one-shot helper preserved as a thin composition over the
 * canonical primitives. Use {@link emptyResultForSparql} for new
 * code (drop-in replacement that exists for the same ergonomic
 * "single call" reason this helper did) or
 * {@link emptyResultForForm} when the form is already known.
 *
 * **Signature compat**: the legacy `emptyQueryResultForKind`
 * accepted the raw SPARQL **string** and classified it internally.
 * Changing the parameter type to `SparqlForm` would silently break
 * `JS`/`any` callers — they would pass a SPARQL string into a
 * slot typed as a form discriminator,
 * and the function returned the SELECT-shaped empty result for
 * `ASK` / `CONSTRUCT` queries (because the string didn't match any
 * variant). The signature is restored to `string` here so existing
 * `emptyQueryResultForKind(query)` call sites compile and behave
 * identically to the surface, with the form classification
 * delegated to {@link emptyResultForSparql}.
 *
 * Behaviour matches the legacy implementation: for unparseable
 * input this routes onto the canonical `'SELECT'` empty shape
 * (`{ bindings: [] }`), preserving downstream callers' branching
 * across the deprecation window. The `quads`-presence parity that
 * matters for CONSTRUCT/DESCRIBE branching is unchanged because
 * the canonical {@link emptyResultForForm} already handles those
 * forms identically.
 */
export function emptyQueryResultForKind(sparql: string): QueryResult {
  return emptyResultForSparql(sparql);
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
