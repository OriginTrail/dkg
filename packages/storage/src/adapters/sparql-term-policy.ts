/**
 * The storage adapters' rollout policy for SPARQL terms: what a statement
 * renders for a term that fails {@link formatSparqlTerm}. The term syntax
 * itself is core's (`@origintrail-official/dkg-core`, `sparql-terms.ts`).
 *
 * A renderer tells the observer it was created with about every term that
 * fails validation, as an {@link InvalidSparqlTerm}, the moment it renders
 * one. The adapters' statement factory (`sparqlStatements` in
 * `sparql-statements.ts`) passes the reporter in `sparql-term-observer.ts`; the
 * deprecated compatibility helpers pass none. The adapters use
 * {@link ADAPTER_SPARQL_TERM_POLICY}, currently in observe mode: a failing
 * term is rendered exactly as before validation existed. Until the
 * hard-reject flip, that still means stripping characters from a malformed
 * IRI.
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  formatIriPrefix,
  formatSparqlTerm,
  SparqlTermValidationError,
  unwrapIri,
  type SparqlTermKind,
  type SparqlTermPosition,
} from '@origintrail-official/dkg-core';
import type { StoreOperation } from '../store-operation-outcome.js';

/** Metric position label: a term position, or a `deleteBySubjectPrefix` prefix. */
export type ObservedTermPosition = SparqlTermPosition | 'subject-prefix';

/** The positions an adapter statement fills only with an IRI. */
export type IriTermPosition = 'graph' | 'subject' | 'predicate';

/** Where a term entered SPARQL; both fields are bounded metric labels. */
export interface SparqlTermSite {
  readonly adapter: 'oxigraph' | 'sparql-http' | 'blazegraph';
  readonly operation: StoreOperation;
}

/**
 * What a statement does with a term that fails validation. Either way the
 * term is reported, under this value as the metric's `enforcement` label,
 * when the adapter runs the operation.
 * - `observe`: render the term in its pre-validation form, so the statement
 *   is built exactly as before validation existed, and a release can confirm
 *   that no well-formed write trips the validators before they start
 *   rejecting. Whether the statement is then sent is up to the adapter: an
 *   aborted or refused operation never dispatches it.
 * - `reject`: throw a {@link SparqlTermValidationError} whose message gives only
 *   the term's metadata, so the statement is never built.
 */
export type SparqlTermEnforcement = 'observe' | 'reject';

/**
 * A term that failed validation, as a renderer hands it to its observer. It
 * never holds the term itself, which is untrusted data that may be private
 * content or a secret: only its length and a keyed fingerprint.
 */
export interface InvalidSparqlTerm {
  readonly site: SparqlTermSite;
  readonly position: ObservedTermPosition;
  readonly kind: SparqlTermKind;
  readonly enforcement: SparqlTermEnforcement;
  readonly length: number;
  readonly fingerprint: string;
}

/** `<length> chars, fingerprint <hex>`, for logs and errors. */
export function describeInvalidTerm(invalidTerm: InvalidSparqlTerm): string {
  return `${invalidTerm.length} chars, fingerprint ${invalidTerm.fingerprint}`;
}

/** Receives each term that fails validation, the moment a renderer renders it. */
export type InvalidSparqlTermObserver = (invalidTerm: InvalidSparqlTerm) => void;

/**
 * Renders the terms of one statement built at one site, telling its observer
 * about every term that fails validation.
 */
export interface SparqlTermRenderer {
  /**
   * A graph name, predicate or match-pattern subject: an IRI, never a blank
   * node. Pre-validation form: `<iri>` with IRI-breaking characters deleted.
   */
  iri(term: string, position: IriTermPosition): string;
  /**
   * A statement subject or object, or a match-pattern object. Pre-validation
   * form: the term as given, `<…>`-wrapped when it is a bare IRI.
   */
  rdf(term: string, position: 'subject' | 'object', blankNodes: 'allow' | 'reject'): string;
  /**
   * A `deleteBySubjectPrefix` prefix. Pre-validation form: a string literal
   * that escapes only `\` and `"`.
   */
  prefix(prefix: string): string;
}

export interface SparqlTermPolicy {
  readonly enforcement: SparqlTermEnforcement;
  /** A renderer for one statement built at `site`, reporting invalid terms to `onInvalidTerm`. */
  renderer(site: SparqlTermSite, onInvalidTerm: InvalidSparqlTermObserver): SparqlTermRenderer;
}

export function createSparqlTermPolicy(enforcement: SparqlTermEnforcement): SparqlTermPolicy {
  return {
    enforcement,
    renderer(site, onInvalidTerm) {
      /**
       * A term failed validation: tell the observer, then render its
       * pre-validation form or, in reject mode, throw. Any error other than a
       * {@link SparqlTermValidationError} is a bug, not a bad term, and
       * propagates.
       */
      function invalid(
        error: unknown,
        term: string,
        position: ObservedTermPosition,
        legacy: (term: string) => string,
      ): string {
        if (!(error instanceof SparqlTermValidationError)) throw error;
        const invalidTerm: InvalidSparqlTerm = {
          site,
          position,
          kind: error.kind,
          enforcement,
          length: term.length,
          fingerprint: invalidTermFingerprint(term),
        };
        onInvalidTerm(invalidTerm);
        if (enforcement === 'reject') {
          // A fresh error, without `cause`: the validator's message quotes the term.
          throw new SparqlTermValidationError(
            `${site.adapter}.${site.operation}: invalid ${invalidTerm.kind} in SPARQL ${position} ` +
              `position (${describeInvalidTerm(invalidTerm)})`,
            invalidTerm.kind,
          );
        }
        return legacy(term);
      }

      return {
        iri(term, position) {
          try {
            // Never a literal, even if an untyped caller passes the object position.
            if (term.startsWith('"')) {
              throw new SparqlTermValidationError(`SPARQL ${position} must be an IRI`, 'literal');
            }
            // Adapters key write scopes and revisions on the raw graph string,
            // so a graph name must be bare here, although the grammar allows `<…>`.
            if (position === 'graph' && unwrapIri(term) !== term) {
              throw new SparqlTermValidationError('A storage graph name must be a bare IRI', 'iri');
            }
            return formatSparqlTerm(term, { position });
          } catch (error) {
            return invalid(error, term, position, legacyStrippedIri);
          }
        },
        rdf(term, position, blankNodes) {
          try {
            return formatSparqlTerm(term, { position, blankNodes });
          } catch (error) {
            return invalid(error, term, position, legacyRdfTerm);
          }
        },
        prefix(prefix) {
          try {
            return formatIriPrefix(prefix);
          } catch (error) {
            return invalid(error, prefix, 'subject-prefix', legacyStringLiteral);
          }
        },
      };
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

// A fingerprint keyed per process lets an operator match repeats in one
// node's logs, but it cannot be checked against guessed values or correlated
// across nodes and restarts.
const INVALID_TERM_FINGERPRINT_KEY = randomBytes(32);

function invalidTermFingerprint(term: string): string {
  return createHmac('sha256', INVALID_TERM_FINGERPRINT_KEY).update(term).digest('hex').slice(0, 12);
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
