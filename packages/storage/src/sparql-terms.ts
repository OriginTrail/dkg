/**
 * RDF term formatting for SPARQL that the storage layer builds by string
 * interpolation.
 *
 * The strict `format*` functions validate a term against the SPARQL grammar for
 * its position and render it unchanged, or throw a
 * {@link SparqlTermValidationError}. They never repair a term: deleting
 * characters from an IRI would retarget the triple at a different resource.
 * The atomic-replace and RFC-64 commit builders call them directly.
 *
 * The adapters call the `sparql*` entry points, which currently run in observe
 * mode (see `renderInvalidTerm`): a term that fails validation is counted and
 * logged, then rendered exactly as before this module existed. Until the
 * hard-reject flip, that still means stripping characters from a malformed IRI.
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  assertSafeIri,
  assertSafeRdfTerm,
  getMetrics,
  sparqlIri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import type { StoreOperation } from './store-operation-outcome.js';

export type SparqlTermPosition = 'graph' | 'subject' | 'predicate' | 'object';

/** Metric position label: a term position, or a `deleteBySubjectPrefix` prefix. */
export type ObservedTermPosition = SparqlTermPosition | 'subject-prefix';

export type SparqlTermKind = 'iri' | 'literal' | 'blank-node';

/** Where a term entered SPARQL; both fields are bounded metric labels. */
export interface SparqlTermSite {
  readonly adapter: 'oxigraph' | 'sparql-http' | 'blazegraph';
  readonly operation: StoreOperation;
}

/** A term the SPARQL grammar does not accept in its position. */
export class SparqlTermValidationError extends Error {
  readonly kind: SparqlTermKind;

  constructor(message: string, kind: SparqlTermKind, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SparqlTermValidationError';
    this.kind = kind;
  }
}

const BARE_DATATYPE_LITERAL = /^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/;

// SPARQL 1.1 BLANK_NODE_LABEL, which N-Quads shares.
const PN_CHARS_BASE =
  'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF' +
  '\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF' +
  '\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const PN_CHARS_U = `${PN_CHARS_BASE}_`;
const PN_CHARS = `${PN_CHARS_U}\\-0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const BLANK_NODE_LABEL = new RegExp(
  `^_:[${PN_CHARS_U}0-9](?:[${PN_CHARS}.]*[${PN_CHARS}])?$`,
  'u',
);

/**
 * Run one core validator. A throw from it is a validation failure of `kind`
 * and keeps core's message; keep formatter logic outside `check`, so a bug
 * there is not mistaken for a bad term.
 */
function validated<T>(kind: SparqlTermKind, check: () => T): T {
  try {
    return check();
  } catch (cause) {
    throw new SparqlTermValidationError(
      cause instanceof Error ? cause.message : String(cause),
      kind,
      { cause },
    );
  }
}

export function unwrapIri(term: string): string {
  return term.startsWith('<') && term.endsWith('>')
    ? term.slice(1, -1)
    : term;
}

/** `<iri>` for a bare or angle-bracketed IRI; a blank-node label is NOT rejected. */
export function formatResource(term: string, role: string): string {
  if (term.startsWith('"')) {
    throw new SparqlTermValidationError(`SPARQL ${role} must be an IRI`, 'literal');
  }
  const iri = unwrapIri(term);
  return validated('iri', () => sparqlIri(iri));
}

/** An IRI or literal object term; a blank-node label is NOT rejected. */
export function formatObject(term: string): string {
  if (term.startsWith('"')) {
    const normalized = normalizeLiteralDatatype(term);
    validated('literal', () => assertSafeRdfTerm(normalized));
    return normalized;
  }
  return formatResource(term, 'object');
}

function normalizeLiteralDatatype(term: string): string {
  const bareDatatype = term.match(BARE_DATATYPE_LITERAL);
  if (!bareDatatype) return term;
  const datatype = unwrapIri(bareDatatype[2]);
  return `${bareDatatype[1]}^^${validated('literal', () => sparqlIri(datatype))}`;
}

/**
 * `<iri>` for a term in an IRI-only position. Graph names must be bare, because
 * adapters key write bookkeeping on the raw string; the other positions may be
 * angle-bracketed. A blank-node label is rejected rather than read as an IRI.
 */
export function formatIriTerm(term: string, position: SparqlTermPosition): string {
  if (term.startsWith('_:')) {
    throw new SparqlTermValidationError(
      `SPARQL ${position} must be an IRI, not a blank node`,
      'blank-node',
    );
  }
  const iri = position === 'graph' ? term : unwrapIri(term);
  return validated('iri', () => sparqlIri(iri));
}

/**
 * A subject or object term: an IRI, a blank node where the statement allows
 * one, or (object only) a literal.
 */
export function formatRdfTerm(
  term: string,
  position: 'subject' | 'object',
  blankNodes: 'allow' | 'reject',
): string {
  if (term.startsWith('_:')) {
    if (blankNodes === 'reject') {
      throw new SparqlTermValidationError(
        `SPARQL ${position} cannot be a blank node here`,
        'blank-node',
      );
    }
    if (!BLANK_NODE_LABEL.test(term)) {
      throw new SparqlTermValidationError(
        `Invalid blank node label in SPARQL ${position}`,
        'blank-node',
      );
    }
    return term;
  }
  return position === 'object' ? formatObject(term) : formatResource(term, position);
}

/**
 * The string literal for the subject-IRI prefix a `STRSTARTS` filter matches.
 * The prefix may contain only characters an IRI can (empty matches every IRI
 * subject). Anything else can never match, so it is rejected rather than
 * escaped into a filter that deletes nothing and reports success.
 */
export function formatIriPrefix(prefix: string): string {
  if (prefix !== '') validated('iri', () => assertSafeIri(prefix));
  return sparqlString(prefix);
}

/** {@link formatIriTerm} for adapters, under the policy in `renderInvalidTerm`. */
export function sparqlIriTerm(
  term: string,
  position: SparqlTermPosition,
  site: SparqlTermSite,
): string {
  try {
    return formatIriTerm(term, position);
  } catch (error) {
    return renderInvalidTerm(error, term, position, site, legacyStrippedIri);
  }
}

/** {@link formatRdfTerm} for adapters, under the policy in `renderInvalidTerm`. */
export function sparqlRdfTerm(
  term: string,
  position: 'subject' | 'object',
  site: SparqlTermSite,
  blankNodes: 'allow' | 'reject',
): string {
  try {
    return formatRdfTerm(term, position, blankNodes);
  } catch (error) {
    return renderInvalidTerm(error, term, position, site, legacyRdfTerm);
  }
}

/** {@link formatIriPrefix} for adapters, under the policy in `renderInvalidTerm`. */
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

/** Former `escapeUri`: deletes IRI-breaking characters, retargeting the IRI. */
function legacyStrippedIri(term: string): string {
  return `<${term.replace(/[<>"{}|\\^`]/g, '')}>`;
}

/** Former `formatTerm`: passes literals, blank nodes and `<…>` through unchecked. */
function legacyRdfTerm(term: string): string {
  if (term.startsWith('"')) {
    const bareDatatype = term.match(BARE_DATATYPE_LITERAL);
    return bareDatatype ? `${bareDatatype[1]}^^<${bareDatatype[2]}>` : term;
  }
  if (term.startsWith('_:') || term.startsWith('<')) return term;
  return `<${term}>`;
}

/** Former `escapeString`: escapes only `\` and `"`, so a line break still breaks the update. */
function legacyStringLiteral(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}
