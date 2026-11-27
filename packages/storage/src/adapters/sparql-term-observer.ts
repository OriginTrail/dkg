/**
 * Reports invalid SPARQL terms. This is the only code that touches the
 * counter, the warning log and its once-a-minute throttle. The adapters'
 * statement factory (`sparqlStatements` in `sparql-statements.ts`) hands
 * {@link reportInvalidSparqlTerm} to every renderer it creates.
 */
import { getMetrics } from '@origintrail-official/dkg-core';
import { describeInvalidTerm, type InvalidSparqlTerm } from './sparql-term-policy.js';

const INVALID_TERM_WARN_INTERVAL_MS = 60_000;
const lastInvalidTermWarnAt = new Map<string, number>();

/**
 * Count an invalid term under its enforcement mode, and warn at most once a
 * minute per site, label and mode. The warning gives the term's length and
 * fingerprint, never the term.
 */
export function reportInvalidSparqlTerm(invalidTerm: InvalidSparqlTerm): void {
  const { site, position, kind, enforcement } = invalidTerm;
  try {
    getMetrics().storeSparqlInvalidTermsTotal.add(1, {
      adapter: site.adapter,
      operation: site.operation,
      position,
      kind,
      enforcement,
    });
  } catch { /* metrics unavailable in some harnesses — never fail the write */ }

  const key = `${site.adapter}|${site.operation}|${position}|${kind}|${enforcement}`;
  const now = Date.now();
  const lastWarnAt = lastInvalidTermWarnAt.get(key);
  if (lastWarnAt !== undefined && now - lastWarnAt < INVALID_TERM_WARN_INTERVAL_MS) return;
  lastInvalidTermWarnAt.set(key, now);
  const outcome = enforcement === 'reject'
    ? 'Rejected it (reject mode). '
    : 'Rendered it in the pre-validation form (observe mode); a later release will reject it. ';
  console.warn(
    `[storage] ${site.adapter}.${site.operation}: invalid ${kind} in SPARQL ${position} ` +
      `position (${describeInvalidTerm(invalidTerm)}; the value is not logged). ${outcome}` +
      'Further occurrences are counted in dkg.store.sparql_invalid_terms_total ' +
      'and warned at most once a minute.',
  );
}
