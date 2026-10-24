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
 *
 * On top of core's grammar, storage requires every IRI, a literal's datatype
 * included, to be an absolute RFC 3987 IRI (see {@link absoluteIriFailure}).
 * Such a term passes the grammar, so observe mode sends its rendering as is.
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
import {
  isAbsoluteRfc3987IriV1,
  parseRdfLiteralLexicalTerm,
} from '@origintrail-official/dkg-rdf-utils';
import type { StoreOperation } from '../store-operation-outcome.js';

/**
 * Metric position label: a term position, a typed literal's `datatype`, or a
 * `deleteBySubjectPrefix` prefix.
 */
export type ObservedTermPosition = SparqlTermPosition | 'datatype' | 'subject-prefix';

/**
 * Metric kind label: the kind of term core's grammar rejected, or the storage
 * absolute-IRI rule broken by a term the grammar accepted: `relative-iri` (no
 * scheme) or `rfc3987-iri` (a scheme, but not RFC 3987). See
 * {@link absoluteIriFailure}.
 */
export type ObservedTermKind = SparqlTermKind | 'relative-iri' | 'rfc3987-iri';

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
  readonly kind: ObservedTermKind;
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
   * that escapes only `\` and `"`. A prefix is not a whole IRI, so the
   * absolute-IRI rule does not apply to it.
   */
  prefix(prefix: string): string;
  /**
   * Only the absolute-IRI rule, for a term written without this renderer: by
   * a builder that checks the rest of its syntax itself (atomic replace,
   * RFC-64 commit) or by an N-Quads load. Renders nothing, so the write is
   * unchanged.
   */
  checkIri(term: string, position: SparqlTermPosition): void;
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
       * Tell the observer about an invalid term and, in reject mode, throw.
       * The error keeps core's term kinds: `termKind` is the kind of term that
       * failed, which for an absolute-IRI failure is the IRI, or the literal
       * whose datatype it is.
       */
      function invalid(
        kind: ObservedTermKind,
        termKind: SparqlTermKind,
        term: string,
        position: ObservedTermPosition,
      ): void {
        const invalidTerm: InvalidSparqlTerm = {
          site,
          position,
          kind,
          enforcement,
          length: term.length,
          fingerprint: invalidTermFingerprint(term),
        };
        onInvalidTerm(invalidTerm);
        if (enforcement === 'reject') {
          // A fresh error, without `cause`: the validator's message quotes the term.
          throw new SparqlTermValidationError(
            `${site.adapter}.${site.operation}: invalid ${kind} in SPARQL ${position} ` +
              `position (${describeInvalidTerm(invalidTerm)})`,
            termKind,
          );
        }
      }

      /**
       * A term failed core's grammar: report it, then render its
       * pre-validation form. Any error other than a
       * {@link SparqlTermValidationError} is a bug, not a bad term, and
       * propagates.
       */
      function failed(
        error: unknown,
        term: string,
        position: ObservedTermPosition,
        legacy: (term: string) => string,
      ): string {
        if (!(error instanceof SparqlTermValidationError)) throw error;
        invalid(error.kind, error.kind, term, position);
        return legacy(term);
      }

      /** Report the IRI a term names if it breaks {@link absoluteIriFailure}'s rule. */
      function checkIri(term: string, position: SparqlTermPosition): void {
        const named = namedIri(term, position);
        if (named === null) return;
        const kind = absoluteIriFailure(named.iri);
        if (kind !== null) invalid(kind, named.termKind, term, named.position);
      }

      return {
        iri(term, position) {
          let rendered: string;
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
            rendered = formatSparqlTerm(term, { position });
          } catch (error) {
            return failed(error, term, position, legacyStrippedIri);
          }
          checkIri(term, position);
          return rendered;
        },
        rdf(term, position, blankNodes) {
          let rendered: string;
          try {
            rendered = formatSparqlTerm(term, { position, blankNodes });
          } catch (error) {
            return failed(error, term, position, legacyRdfTerm);
          }
          checkIri(term, position);
          return rendered;
        },
        prefix(prefix) {
          try {
            return formatIriPrefix(prefix);
          } catch (error) {
            return failed(error, prefix, 'subject-prefix', legacyStringLiteral);
          }
        },
        checkIri,
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
 * position accepts only a bare IRI. The flip also makes the atomic-replace,
 * RFC-64 and N-Quads writes reject a relative or RFC 3987-invalid IRI before
 * sending it (`checkIris` in `sparql-statements.ts`).
 */
export const ADAPTER_SPARQL_TERM_POLICY = createSparqlTermPolicy('observe');

// RFC 3986 §3.1: a letter, then letters, digits, `+`, `-` or `.`, then `:`.
const IRI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The storage rule on top of core's grammar: an IRI must be an absolute RFC
 * 3987 IRI. Returns the kind an IRI fails as, or null.
 * - `relative-iri`: no scheme. SPARQL accepts it, and the endpoint resolves
 *   it against its own URL: oxigraph-server stores `"42"^^<integer>` as
 *   `"42"^^<http://127.0.0.1:7920/integer>`, so every node stores different
 *   data. N-Quads loads reject it.
 * - `rfc3987-iri`: a scheme, but RFC 3987 rejects the rest (`…/%zz`). Oxigraph
 *   fails the write; Blazegraph stores it verbatim.
 */
function absoluteIriFailure(iri: string): 'relative-iri' | 'rfc3987-iri' | null {
  if (isAbsoluteRfc3987IriV1(iri)) return null;
  return IRI_SCHEME.test(iri) ? 'rfc3987-iri' : 'relative-iri';
}

/**
 * The IRI a term names, where, and the kind of term holding it: the term
 * itself, bare or bracketed, or a typed literal's datatype. A blank node, or
 * any other literal, names none.
 */
function namedIri(
  term: string,
  position: SparqlTermPosition,
): { iri: string; position: ObservedTermPosition; termKind: SparqlTermKind } | null {
  if (term.startsWith('_:')) return null;
  if (term.startsWith('"')) {
    const suffix = parseRdfLiteralLexicalTerm(term)?.suffix;
    return suffix?.kind === 'datatype'
      ? { iri: suffix.datatype, position: 'datatype', termKind: 'literal' }
      : null;
  }
  return { iri: unwrapIri(term), position, termKind: 'iri' };
}

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
