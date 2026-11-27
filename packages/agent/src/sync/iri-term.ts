/**
 * Shared RDF-term IRI classifier for the durable `_meta` sync lane.
 *
 * Both the responder read path (graph-plan.ts) and the requester ingest path
 * (durable-integrity.ts) need to distinguish an IRI term from a blank node
 * (`_:…`) or a literal (`"…"`). They share ONE core predicate but expose it
 * under two names with a DELIBERATE, load-bearing divergence on empty/non-string
 * inputs — hence two exported functions rather than one with a flag. Collapsing
 * them (or defaulting a flag) would silently flip one side; keep them distinct.
 *
 * See {@link isIriTerm} (lenient, responder read) and
 * {@link isIriMetaSubject} (strict, fail-closed ingest).
 */

/**
 * The N-Quads term-kind test both callers agree on: a term is an IRI unless it
 * is a blank-node label (`_:…`) or a quoted literal (`"…"`). This is the exact
 * shared core; the divergence between the two exports is ONLY in their handling
 * of empty-string / non-string inputs, layered on top of this.
 */
function isIriTermCore(term: string): boolean {
  return !term.startsWith('_:') && !term.startsWith('"');
}

/**
 * Responder-read IRI test (graph-plan.ts). LENIENT by design: it is the bare
 * core predicate with no non-string or empty-string guard, so `isIriTerm('')`
 * is `true`. It runs on the responder's own store-derived rows (a trusted,
 * always-string source) on the protocol read/paging path, where byte-identical
 * behavior matters more than defensiveness. Do NOT add a length/`typeof` guard
 * here — that would change what the responder serves.
 *
 * Diverges from {@link isIriMetaSubject} on empty/non-string input: this returns
 * `true` for `''`, that returns `false`. The divergence is intentional (#1940).
 */
export function isIriTerm(term: string): boolean {
  return isIriTermCore(term);
}

/**
 * Requester-ingest `_meta` subject test (durable-integrity.ts). STRICT and
 * fail-closed: `isIriMetaSubject('')` is `false`, and a non-string subject is
 * `false` rather than throwing. A durable `_meta` subject must be an IRI —
 * conforming writers only emit IRI subjects (metadata generators build
 * deterministic UALs; the publisher rejects blank nodes; SWM writers skolemize
 * before storage). A blank-node (`_:…`) or literal (`"…"`) subject is only
 * reachable via unverified peer-ingest and has no trustworthy, stable identity,
 * so it is dropped at ingest (#1921) rather than persisted.
 *
 * The `typeof term === 'string' && term.length > 0` guard is load-bearing: this
 * runs at the verification-input boundary filters (selectVerifiedDurableSyncQuads
 * and planBoundedGraphScopedDurableBatch, both on RAW peer-fetched meta) and in
 * the admission selectors. A conforming quad always carries a non-empty string
 * subject; tolerate a malformed one (treat as non-IRI → drop) instead of
 * throwing. This is why it diverges from the lenient {@link isIriTerm}, which
 * runs on the responder's own trusted rows (#1940).
 *
 * The parameter is typed `unknown` on purpose (not `string`): this IS the shared
 * fail-closed validator for raw peer-ingest values, so a caller holding an
 * untyped/unknown-valued subject can delegate directly without a cast. The guard
 * narrows to a non-empty `string` before {@link isIriTermCore}, so tsc stays
 * clean and the behavior is byte-identical to the previous `string` signature
 * for the conforming call sites (`quad.subject` is already `string`). The
 * `string`-vs-`unknown` split across the two exports honestly reflects
 * trusted-input (responder read) vs fail-closed-untrusted-input (ingest).
 */
export function isIriMetaSubject(term: unknown): boolean {
  return typeof term === 'string' && term.length > 0 && isIriTermCore(term);
}
