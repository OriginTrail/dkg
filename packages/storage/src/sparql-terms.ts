/**
 * RDF term formatting for SPARQL that the storage layer builds by string
 * interpolation.
 *
 * A term is validated against the SPARQL grammar for its position and emitted
 * unchanged, or it is rejected. It is never repaired: deleting characters from
 * an IRI silently retargets the triple at a different resource. Plain string
 * values (not RDF terms) are escaped instead.
 *
 * The `format*` functions are strict and throw. The atomic-replace and RFC-64
 * commit builders call them directly. The adapters call the `sparql*` entry
 * points, which currently run in observe mode (see `observeInvalidTerm`).
 */
import {
  assertSafeIri,
  assertSafeRdfTerm,
  getMetrics,
} from '@origintrail-official/dkg-core';
import type { StoreOperation } from './store-operation-outcome.js';

export type SparqlTermPosition = 'graph' | 'subject' | 'predicate' | 'object';

/** Where a term entered SPARQL; both fields are bounded metric labels. */
export interface SparqlTermSite {
  readonly adapter: 'oxigraph' | 'sparql-http' | 'blazegraph';
  readonly operation: StoreOperation;
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

// Exactly the characters STRING_LITERAL2 forbids unescaped.
const STRING_LITERAL_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
};

export function unwrapIri(term: string): string {
  return term.startsWith('<') && term.endsWith('>')
    ? term.slice(1, -1)
    : term;
}

/** `<iri>` for a bare or angle-bracketed IRI; a blank-node label is NOT rejected. */
export function formatResource(term: string, role: string): string {
  if (term.startsWith('"')) {
    throw new Error(`SPARQL ${role} must be an IRI`);
  }
  return `<${assertSafeIri(unwrapIri(term))}>`;
}

/** An IRI or literal object term; a blank-node label is NOT rejected. */
export function formatObject(term: string): string {
  if (term.startsWith('"')) {
    const normalized = normalizeLiteralDatatype(term);
    assertSafeRdfTerm(normalized);
    return normalized;
  }
  return formatResource(term, 'object');
}

function normalizeLiteralDatatype(term: string): string {
  const bareDatatype = term.match(BARE_DATATYPE_LITERAL);
  return bareDatatype
    ? `${bareDatatype[1]}^^<${assertSafeIri(unwrapIri(bareDatatype[2]))}>`
    : term;
}

/**
 * `<iri>` for a term in an IRI-only position. Graph names must be bare, because
 * adapters key write bookkeeping on the raw string; the other positions may be
 * angle-bracketed. A blank-node label is rejected rather than read as an IRI.
 */
export function formatIriTerm(term: string, position: SparqlTermPosition): string {
  if (term.startsWith('_:')) {
    throw new Error(`SPARQL ${position} must be an IRI, not a blank node`);
  }
  return `<${assertSafeIri(position === 'graph' ? term : unwrapIri(term))}>`;
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
      throw new Error(`SPARQL ${position} cannot be a blank node here`);
    }
    if (!BLANK_NODE_LABEL.test(term)) {
      throw new Error(`Invalid blank node label in SPARQL ${position}`);
    }
    return term;
  }
  return position === 'object' ? formatObject(term) : formatResource(term, position);
}

/** A SPARQL string literal (`"…"`) holding `value` verbatim. */
export function sparqlStringLiteral(value: string): string {
  return `"${value.replace(/[\\"\n\r]/g, (character) => STRING_LITERAL_ESCAPES[character]!)}"`;
}

/** {@link formatIriTerm} for adapters, in observe mode (see `observeInvalidTerm`). */
export function sparqlIriTerm(
  term: string,
  position: SparqlTermPosition,
  site: SparqlTermSite,
): string {
  try {
    return formatIriTerm(term, position);
  } catch {
    observeInvalidTerm(term, position, site);
    return legacyStrippedIri(term);
  }
}

/** {@link formatRdfTerm} for adapters, in observe mode (see `observeInvalidTerm`). */
export function sparqlRdfTerm(
  term: string,
  position: 'subject' | 'object',
  site: SparqlTermSite,
  blankNodes: 'allow' | 'reject',
): string {
  try {
    return formatRdfTerm(term, position, blankNodes);
  } catch {
    observeInvalidTerm(term, position, site);
    return legacyRdfTerm(term);
  }
}

const INVALID_TERM_WARN_INTERVAL_MS = 60_000;
const INVALID_TERM_SAMPLE_CHARS = 120;
const lastInvalidTermWarnAt = new Map<string, number>();

/**
 * Observe mode: count and log a term the validators rejected. The caller then
 * renders it the pre-validation way, so a release can confirm that no
 * well-formed write trips the validators before they start rejecting.
 *
 * TODO(sparql-term-hard-reject): once a release shows
 * `dkg.store.sparql_invalid_terms_total` staying at zero, count with
 * `enforcement: 'reject'` and make `sparqlIriTerm` / `sparqlRdfTerm` rethrow
 * the validation error, then delete `legacyStrippedIri` and `legacyRdfTerm`.
 */
function observeInvalidTerm(
  term: string,
  position: SparqlTermPosition,
  site: SparqlTermSite,
): void {
  const kind = term.startsWith('"') ? 'literal' : term.startsWith('_:') ? 'blank-node' : 'iri';
  try {
    getMetrics().storeSparqlInvalidTermsTotal.add(1, {
      adapter: site.adapter,
      operation: site.operation,
      position,
      kind,
      enforcement: 'observe',
    });
  } catch { /* metrics unavailable in some harnesses — never fail the write */ }

  const key = `${site.adapter}|${site.operation}|${position}|${kind}`;
  const now = Date.now();
  const lastWarnAt = lastInvalidTermWarnAt.get(key);
  if (lastWarnAt !== undefined && now - lastWarnAt < INVALID_TERM_WARN_INTERVAL_MS) return;
  lastInvalidTermWarnAt.set(key, now);
  const sample = JSON.stringify(term.slice(0, INVALID_TERM_SAMPLE_CHARS));
  const truncated = term.length > INVALID_TERM_SAMPLE_CHARS ? '…' : '';
  console.warn(
    `[storage] ${site.adapter}.${site.operation}: invalid ${kind} in SPARQL ${position} ` +
      `position ${sample}${truncated}. Sent it in the pre-validation form (observe mode); ` +
      'a later release will reject it. Further occurrences are counted in ' +
      'dkg.store.sparql_invalid_terms_total and warned at most once a minute.',
  );
}

// The pre-validation adapter formatters, byte for byte. Only a term that
// failed validation reaches them.

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
