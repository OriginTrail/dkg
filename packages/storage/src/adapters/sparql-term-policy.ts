/**
 * The storage adapters' rollout policy for SPARQL terms: what happens to a
 * term that fails {@link formatSparqlTerm}, and how that is observed. The term
 * syntax itself is core's (`@origintrail-official/dkg-core`, `sparql-terms.ts`).
 *
 * The adapters build their statements with `sparql-statements.ts`, which
 * renders every term under {@link ADAPTER_SPARQL_TERM_POLICY}. That policy is
 * currently in observe mode: a term that fails validation is counted and
 * logged, then rendered exactly as before validation existed. Until the
 * hard-reject flip, that still means stripping characters from a malformed
 * IRI.
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  formatIriPrefix,
  formatSparqlTerm,
  getMetrics,
  SparqlTermValidationError,
  type SparqlTermKind,
  type SparqlTermPosition,
} from '@origintrail-official/dkg-core';
import type { StoreOperation } from '../store-operation-outcome.js';

/** Metric position label: a term position, or a `deleteBySubjectPrefix` prefix. */
export type ObservedTermPosition = SparqlTermPosition | 'subject-prefix';

/** Where a term entered SPARQL; both fields are bounded metric labels. */
export interface SparqlTermSite {
  readonly adapter: 'oxigraph' | 'sparql-http' | 'blazegraph';
  readonly operation: StoreOperation;
}

/**
 * What an adapter does with a term that fails validation. Both modes count it
 * in `dkg.store.sparql_invalid_terms_total` under this value as the
 * `enforcement` label, and warn at most once a minute.
 * - `observe`: send the term in its pre-validation form, as before validation
 *   existed, so a release can confirm that no well-formed write trips the
 *   validators before they start rejecting.
 * - `reject`: throw a {@link SparqlTermValidationError}, so nothing is sent.
 */
export type SparqlTermEnforcement = 'observe' | 'reject';

/** The adapters' term entry points under one enforcement mode. */
export interface SparqlTermPolicy {
  readonly enforcement: SparqlTermEnforcement;
  /**
   * A graph name, predicate or match-pattern subject: an IRI, never a blank
   * node. Pre-validation form: `<iri>` with IRI-breaking characters deleted.
   */
  iriTerm(term: string, position: SparqlTermPosition, site: SparqlTermSite): string;
  /**
   * A statement subject or object, or a match-pattern object. Pre-validation
   * form: the term as sent, `<…>`-wrapped when it is a bare IRI.
   */
  rdfTerm(
    term: string,
    position: 'subject' | 'object',
    site: SparqlTermSite,
    blankNodes: 'allow' | 'reject',
  ): string;
  /**
   * A `deleteBySubjectPrefix` prefix. Pre-validation form: a string literal
   * that escapes only `\` and `"`.
   */
  iriPrefix(prefix: string, site: SparqlTermSite): string;
  /**
   * A blank-node label that the caller rewrites to a query variable instead of
   * sending. It is checked like any sent term.
   */
  checkBlankNodeLabel(label: string, position: 'subject' | 'object', site: SparqlTermSite): void;
}

export function createSparqlTermPolicy(enforcement: SparqlTermEnforcement): SparqlTermPolicy {
  /**
   * A term failed validation. Any error other than a
   * {@link SparqlTermValidationError} is a bug, not a bad term, and propagates.
   */
  function onInvalidTerm(
    error: unknown,
    term: string,
    position: ObservedTermPosition,
    site: SparqlTermSite,
    legacy: (term: string) => string,
  ): string {
    if (!(error instanceof SparqlTermValidationError)) throw error;
    recordInvalidTerm(term, position, error.kind, site, enforcement);
    if (enforcement === 'reject') {
      // A fresh error, without `cause`: the validator's message quotes the term.
      throw new SparqlTermValidationError(
        `${site.adapter}.${site.operation}: invalid ${error.kind} in SPARQL ${position} ` +
          `position (${describeInvalidTerm(term)})`,
        error.kind,
      );
    }
    return legacy(term);
  }

  return {
    enforcement,
    iriTerm(term, position, site) {
      try {
        return formatSparqlTerm(term, { position });
      } catch (error) {
        return onInvalidTerm(error, term, position, site, legacyStrippedIri);
      }
    },
    rdfTerm(term, position, site, blankNodes) {
      try {
        return formatSparqlTerm(term, { position, blankNodes });
      } catch (error) {
        return onInvalidTerm(error, term, position, site, legacyRdfTerm);
      }
    },
    iriPrefix(prefix, site) {
      try {
        return formatIriPrefix(prefix);
      } catch (error) {
        return onInvalidTerm(error, prefix, 'subject-prefix', site, legacyStringLiteral);
      }
    },
    checkBlankNodeLabel(label, position, site) {
      try {
        formatSparqlTerm(label, { position, blankNodes: 'allow' });
      } catch (error) {
        onInvalidTerm(error, label, position, site, (term) => term);
      }
    },
  };
}

/**
 * The policy every adapter uses.
 *
 * TODO(sparql-term-hard-reject): once a release shows
 * `dkg.store.sparql_invalid_terms_total` staying at zero, make this
 * `createSparqlTermPolicy('reject')` and delete the legacy renderers. Before
 * flipping, audit callers that pass `<…>`-wrapped graph names: the graph
 * position accepts only a bare IRI.
 */
export const ADAPTER_SPARQL_TERM_POLICY = createSparqlTermPolicy('observe');

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

function describeInvalidTerm(term: string): string {
  return `${term.length} chars, fingerprint ${invalidTermFingerprint(term)}`;
}

/**
 * Count every invalid term under its enforcement mode; warn at most once a
 * minute per site, label and mode, with the term's length and fingerprint but
 * never the term itself.
 */
function recordInvalidTerm(
  term: string,
  position: ObservedTermPosition,
  kind: SparqlTermKind,
  site: SparqlTermSite,
  enforcement: SparqlTermEnforcement,
): void {
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
    : 'Sent it in the pre-validation form (observe mode); a later release will reject it. ';
  console.warn(
    `[storage] ${site.adapter}.${site.operation}: invalid ${kind} in SPARQL ${position} ` +
      `position (${describeInvalidTerm(term)}; the value is not logged). ${outcome}` +
      'Further occurrences are counted in dkg.store.sparql_invalid_terms_total ' +
      'and warned at most once a minute.',
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
