/**
 * RDF term syntax for SPARQL built by string interpolation, next to the
 * injection-safety primitives in `sparql-safe.ts`.
 *
 * {@link formatSparqlTerm} is the one serializer. It validates a term against
 * the SPARQL grammar for its {@link SparqlTermContext} and renders it
 * unchanged, or throws a {@link SparqlTermValidationError}. It never repairs a
 * term: deleting characters from an IRI would retarget the triple at a
 * different resource. Storage's atomic-replace and RFC-64 commit builders call
 * it directly; storage adapters reach it through their rollout policy, which
 * decides what happens to a term that fails and how that is observed.
 *
 * This module owns position rules and rendering only. RDF lexical recognition
 * comes from shared validators: the literal split and blank-node labels from
 * `@origintrail-official/dkg-rdf-utils`, IRI and literal safety from
 * `sparql-safe.ts`.
 */
import {
  assertSafeIri,
  assertSafeRdfTerm,
  sparqlIri,
  sparqlString,
} from './sparql-safe.js';
import {
  isRdfBlankNodeLabel,
  parseRdfLiteralLexicalTerm,
} from '@origintrail-official/dkg-rdf-utils';

export type SparqlTermPosition = 'graph' | 'subject' | 'predicate' | 'object';

export type SparqlTermKind = 'iri' | 'literal' | 'blank-node';

/**
 * Where a term goes. Only an object can be a literal. Only a subject or object
 * can be a blank node, and only where the statement allows one
 * (`blankNodes: 'allow'`, as in INSERT DATA; DELETE DATA and match patterns
 * cannot hold one). A graph name must be a bare IRI, because adapters key write
 * bookkeeping on the raw string; the other positions may be angle-bracketed.
 */
export interface SparqlTermContext {
  readonly position: SparqlTermPosition;
  /** Defaults to `'reject'`. */
  readonly blankNodes?: 'allow' | 'reject';
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

/**
 * Render `term` for `context`: `<iri>` for a bare or angle-bracketed IRI, the
 * label for an allowed blank node, and the literal for an object literal, with
 * a legacy bare datatype (`"v"^^http://…`) bracketed. Throws a
 * {@link SparqlTermValidationError} for anything the position cannot hold.
 */
export function formatSparqlTerm(term: string, context: SparqlTermContext): string {
  const { position } = context;
  if (term.startsWith('_:')) {
    const allowed = context.blankNodes === 'allow' && (position === 'subject' || position === 'object');
    if (!allowed) {
      throw new SparqlTermValidationError(
        `SPARQL ${position} cannot be a blank node here`,
        'blank-node',
      );
    }
    if (!isRdfBlankNodeLabel(term.slice(2))) {
      throw new SparqlTermValidationError(
        `Invalid blank node label in SPARQL ${position}`,
        'blank-node',
      );
    }
    return term;
  }
  if (term.startsWith('"')) {
    if (position !== 'object') {
      throw new SparqlTermValidationError(`SPARQL ${position} must be an IRI`, 'literal');
    }
    const literal = normalizeLiteralDatatype(term);
    validated('literal', () => assertSafeRdfTerm(literal));
    return literal;
  }
  const iri = position === 'graph' ? term : unwrapIri(term);
  return validated('iri', () => sparqlIri(iri));
}

/** Bracket a legacy bare datatype (`"v"^^http://…`), as N-Quads and SPARQL require. */
function normalizeLiteralDatatype(term: string): string {
  const lexical = parseRdfLiteralLexicalTerm(term);
  if (lexical?.suffix.kind !== 'datatype' || lexical.suffix.syntax !== 'bare') return term;
  const { datatype } = lexical.suffix;
  return `"${lexical.body}"^^${validated('literal', () => sparqlIri(datatype))}`;
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
