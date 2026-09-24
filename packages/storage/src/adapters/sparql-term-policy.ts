/**
 * The storage adapters' rollout policy for SPARQL terms: what a statement
 * renders for a term that fails {@link formatSparqlTerm}. The term syntax
 * itself is core's (`@origintrail-official/dkg-core`, `sparql-terms.ts`).
 *
 * Rendering has no side effects. A term that fails validation becomes an
 * {@link InvalidSparqlTerm} on the statement being built. The adapter reports
 * it (`sparql-term-observer.ts`) when it runs the operation, through
 * `reportedPlan` in `sparql-statements.ts`. The adapters use
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
 * - `reject`: throw a {@link SparqlTermRejectedError}, so the statement is
 *   never built.
 */
export type SparqlTermEnforcement = 'observe' | 'reject';

/**
 * A term that failed validation, carried by the statement plan until the
 * adapter reports it. It never holds the term itself, which is untrusted data
 * that may be private content or a secret: only its length and a keyed
 * fingerprint.
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

/**
 * What reject mode throws. Its message carries only the diagnostic's metadata,
 * and it has no `cause`, because the validator's own message quotes the term.
 */
export class SparqlTermRejectedError extends SparqlTermValidationError {
  readonly invalidTerm: InvalidSparqlTerm;

  constructor(invalidTerm: InvalidSparqlTerm) {
    super(
      `${invalidTerm.site.adapter}.${invalidTerm.site.operation}: invalid ${invalidTerm.kind} ` +
        `in SPARQL ${invalidTerm.position} position (${describeInvalidTerm(invalidTerm)})`,
      invalidTerm.kind,
    );
    this.name = 'SparqlTermRejectedError';
    this.invalidTerm = invalidTerm;
  }
}

/**
 * Renders the terms of one statement built at one site, and collects those
 * that fail validation. It never reports them itself.
 */
export interface SparqlTermRenderer {
  /**
   * A graph name, predicate or match-pattern subject: an IRI, never a blank
   * node. Pre-validation form: `<iri>` with IRI-breaking characters deleted.
   */
  iri(term: string, position: SparqlTermPosition): string;
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
  /**
   * A blank-node label that the caller rewrites to a query variable instead of
   * sending. It is checked like any rendered term.
   */
  checkBlankNodeLabel(label: string, position: 'subject' | 'object'): void;
  /** The terms that failed validation so far, in rendering order. */
  readonly invalidTerms: readonly InvalidSparqlTerm[];
}

export interface SparqlTermPolicy {
  readonly enforcement: SparqlTermEnforcement;
  /** A renderer for one statement built at `site`. */
  renderer(site: SparqlTermSite): SparqlTermRenderer;
}

export function createSparqlTermPolicy(enforcement: SparqlTermEnforcement): SparqlTermPolicy {
  return {
    enforcement,
    renderer(site) {
      const invalidTerms: InvalidSparqlTerm[] = [];

      /**
       * A term failed validation. Any error other than a
       * {@link SparqlTermValidationError} is a bug, not a bad term, and
       * propagates.
       */
      function onInvalidTerm(
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
        if (enforcement === 'reject') throw new SparqlTermRejectedError(invalidTerm);
        invalidTerms.push(invalidTerm);
        return legacy(term);
      }

      return {
        iri(term, position) {
          try {
            // Adapters key write scopes and revisions on the raw graph string,
            // so a graph name must be bare here, although the grammar allows `<…>`.
            if (position === 'graph' && unwrapIri(term) !== term) {
              throw new SparqlTermValidationError('A storage graph name must be a bare IRI', 'iri');
            }
            return formatSparqlTerm(term, { position });
          } catch (error) {
            return onInvalidTerm(error, term, position, legacyStrippedIri);
          }
        },
        rdf(term, position, blankNodes) {
          try {
            return formatSparqlTerm(term, { position, blankNodes });
          } catch (error) {
            return onInvalidTerm(error, term, position, legacyRdfTerm);
          }
        },
        prefix(prefix) {
          try {
            return formatIriPrefix(prefix);
          } catch (error) {
            return onInvalidTerm(error, prefix, 'subject-prefix', legacyStringLiteral);
          }
        },
        checkBlankNodeLabel(label, position) {
          try {
            formatSparqlTerm(label, { position, blankNodes: 'allow' });
          } catch (error) {
            onInvalidTerm(error, label, position, (term) => term);
          }
        },
        get invalidTerms() {
          return [...invalidTerms];
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
