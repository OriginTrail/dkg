/**
 * The storage adapters' rollout policy for SPARQL terms: what happens to a
 * term that fails {@link formatSparqlTerm}, and how that is observed. The term
 * syntax itself lives in `sparql-terms.ts`.
 *
 * The entry points currently run in observe mode (see `renderInvalidTerm`): a
 * term that fails validation is counted and logged, then rendered exactly as
 * before validation existed. Until the hard-reject flip, that still means
 * stripping characters from a malformed IRI.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { getMetrics } from '@origintrail-official/dkg-core';
import {
  formatIriPrefix,
  formatSparqlTerm,
  SparqlTermValidationError,
  type SparqlTermKind,
  type SparqlTermPosition,
} from '../sparql-terms.js';
import type { StoreOperation } from '../store-operation-outcome.js';

/** Metric position label: a term position, or a `deleteBySubjectPrefix` prefix. */
export type ObservedTermPosition = SparqlTermPosition | 'subject-prefix';

/** Where a term entered SPARQL; both fields are bounded metric labels. */
export interface SparqlTermSite {
  readonly adapter: 'oxigraph' | 'sparql-http' | 'blazegraph';
  readonly operation: StoreOperation;
}

/**
 * A graph name, predicate or match-pattern subject: an IRI, never a blank
 * node. Pre-validation form: `<iri>` with IRI-breaking characters deleted.
 */
export function sparqlIriTerm(
  term: string,
  position: SparqlTermPosition,
  site: SparqlTermSite,
): string {
  try {
    return formatSparqlTerm(term, { position });
  } catch (error) {
    return renderInvalidTerm(error, term, position, site, legacyStrippedIri);
  }
}

/**
 * A statement subject or object, or a match-pattern object. Pre-validation
 * form: the term as sent, `<…>`-wrapped when it is a bare IRI.
 */
export function sparqlRdfTerm(
  term: string,
  position: 'subject' | 'object',
  site: SparqlTermSite,
  blankNodes: 'allow' | 'reject',
): string {
  try {
    return formatSparqlTerm(term, { position, blankNodes });
  } catch (error) {
    return renderInvalidTerm(error, term, position, site, legacyRdfTerm);
  }
}

/**
 * A `deleteBySubjectPrefix` prefix. Pre-validation form: a string literal
 * that escapes only `\` and `"`.
 */
export function sparqlIriPrefix(prefix: string, site: SparqlTermSite): string {
  try {
    return formatIriPrefix(prefix);
  } catch (error) {
    return renderInvalidTerm(error, prefix, 'subject-prefix', site, legacyStringLiteral);
  }
}

/** How the adapter entry points treat a term that fails validation. */
const ADAPTER_ENFORCEMENT = 'observe';

/**
 * The adapter policy for a term that failed validation. Any error other than a
 * {@link SparqlTermValidationError} is a bug, not a bad term, and propagates.
 *
 * Observe mode: count and log the term, then render it the pre-validation way
 * (`legacy`), so a release can confirm that no well-formed write trips the
 * validators before they start rejecting.
 *
 * TODO(sparql-term-hard-reject): once a release shows
 * `dkg.store.sparql_invalid_terms_total` staying at zero, switch
 * `ADAPTER_ENFORCEMENT` to 'reject', rethrow `error` here instead of
 * rendering, and delete the legacy renderers. Before flipping, audit callers
 * that pass `<…>`-wrapped graph names: the graph position accepts only a bare
 * IRI.
 */
function renderInvalidTerm(
  error: unknown,
  term: string,
  position: ObservedTermPosition,
  site: SparqlTermSite,
  legacy: (term: string) => string,
): string {
  if (!(error instanceof SparqlTermValidationError)) throw error;
  recordInvalidTerm(term, position, error.kind, site);
  return legacy(term);
}

const INVALID_TERM_WARN_INTERVAL_MS = 60_000;
const lastInvalidTermWarnAt = new Map<string, number>();

// Terms are untrusted data that may hold private graph content or secrets, so
// the warning never includes one. A fingerprint keyed per process lets an
// operator match repeats in one node's logs, but it cannot be checked against
// guessed values or correlated across nodes and restarts.
const INVALID_TERM_FINGERPRINT_KEY = randomBytes(32);

function invalidTermFingerprint(term: string): string {
  return createHmac('sha256', INVALID_TERM_FINGERPRINT_KEY).update(term).digest('hex').slice(0, 12);
}

/**
 * Count every invalid term; warn at most once a minute per site and label,
 * with the term's length and fingerprint but never the term itself.
 */
function recordInvalidTerm(
  term: string,
  position: ObservedTermPosition,
  kind: SparqlTermKind,
  site: SparqlTermSite,
): void {
  try {
    getMetrics().storeSparqlInvalidTermsTotal.add(1, {
      adapter: site.adapter,
      operation: site.operation,
      position,
      kind,
      enforcement: ADAPTER_ENFORCEMENT,
    });
  } catch { /* metrics unavailable in some harnesses — never fail the write */ }

  const key = `${site.adapter}|${site.operation}|${position}|${kind}`;
  const now = Date.now();
  const lastWarnAt = lastInvalidTermWarnAt.get(key);
  if (lastWarnAt !== undefined && now - lastWarnAt < INVALID_TERM_WARN_INTERVAL_MS) return;
  lastInvalidTermWarnAt.set(key, now);
  console.warn(
    `[storage] ${site.adapter}.${site.operation}: invalid ${kind} in SPARQL ${position} ` +
      `position (${term.length} chars, fingerprint ${invalidTermFingerprint(term)}; the value is not logged). ` +
      'Sent it in the pre-validation form (observe mode); ' +
      'a later release will reject it. Further occurrences are counted in ' +
      'dkg.store.sparql_invalid_terms_total and warned at most once a minute.',
  );
}

// The pre-validation adapter renderers, byte for byte. Only a term that failed
// validation reaches them.

const LEGACY_BARE_DATATYPE_LITERAL = /^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/;

/** Former `escapeUri`: deletes IRI-breaking characters, retargeting the IRI. */
function legacyStrippedIri(term: string): string {
  return `<${term.replace(/[<>"{}|\\^`]/g, '')}>`;
}

/** Former `formatTerm`: passes literals, blank nodes and `<…>` through unchecked. */
function legacyRdfTerm(term: string): string {
  if (term.startsWith('"')) {
    const bareDatatype = term.match(LEGACY_BARE_DATATYPE_LITERAL);
    return bareDatatype ? `${bareDatatype[1]}^^<${bareDatatype[2]}>` : term;
  }
  if (term.startsWith('_:') || term.startsWith('<')) return term;
  return `<${term}>`;
}

/** Former `escapeString`: escapes only `\` and `"`, so a line break still breaks the update. */
function legacyStringLiteral(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}
