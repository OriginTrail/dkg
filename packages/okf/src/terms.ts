/**
 * Frontmatter value → RDF object-term helpers shared by the base mapping and
 * the v0.2 family mapping. Pure and deterministic.
 */

import {
  OKF_ATTESTED_COMPUTATION_TYPE,
  RDF_JSON,
  SCHEMA_NS,
  XSD_BOOLEAN,
  XSD_DATE,
  XSD_DATE_TIME,
  XSD_DECIMAL,
  XSD_INTEGER,
} from './constants.js';
import { conceptIdToIri, resolveLinkTarget } from './paths.js';
import { isSafeIri, literalTerm, safeString, typedLiteralTerm, pascalCase, camelCase } from './utils.js';
import { dateTimeLexical, isXsdDate, isXsdDateTime } from './timestamps.js';
import type { Quad } from './types.js';

/**
 * A frontmatter value no RDF term can hold — a cyclic YAML alias
 * (`a: &x { self: *x }`) has no JSON form. The one recoverable mapping
 * failure: `importBundle` skips just the concept that carries it, while any
 * other exception is a defect and propagates with its stack.
 */
export class OkfValueError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OkfValueError';
  }
}

/** `JSON.stringify` for a frontmatter value, failing as an `OkfValueError`. */
function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    throw new OkfValueError(`value cannot be written as JSON: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'}`, { cause: err });
  }
}

export { isMapping } from './utils.js';

export function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** OKF `type` value → an rdf:type object IRI (raw, no angle brackets). */
export function typeToIri(value: unknown): string | null {
  const s = safeString(value).trim();
  if (!s) return null;
  if (isSafeIri(s)) return s; // already a full IRI (e.g. `tag:…`, `https://…`)
  const pascal = pascalCase(s);
  return pascal ? SCHEMA_NS + pascal : null;
}

/**
 * True when a `type` value names the spec's Attested Computation concept
 * (§10): the spec spelling, its PascalCased form, or the full
 * `http://schema.org/AttestedComputation` IRI, which all map to the same
 * rdf:type, so detection agrees with the mapper and survives a round trip.
 */
export function isAttestedComputationType(value: unknown): boolean {
  return isConceptType(value, OKF_ATTESTED_COMPUTATION_TYPE);
}

/**
 * True when a `type` value names `typeName`: both map to the same rdf:type
 * IRI (`typeToIri`), whichever supported spelling the value uses.
 */
export function isConceptType(value: unknown, typeName: string): boolean {
  if (value === undefined || value === null) return false;
  const iri = typeToIri(value);
  return iri !== null && iri === typeToIri(typeName);
}

/**
 * A timestamp-valued field → object term. Valid xsd:dateTime / xsd:date
 * lexicals are typed; anything else is kept as a plain literal (never a
 * bogus typed literal that would poison date comparisons downstream).
 */
export function dateTerm(value: unknown): string | null {
  const lexical = dateTimeLexical(value);
  if (lexical === null || lexical === '') return null;
  if (isXsdDateTime(lexical)) return typedLiteralTerm(lexical, XSD_DATE_TIME);
  if (isXsdDate(lexical)) return typedLiteralTerm(lexical, XSD_DATE);
  return literalTerm(lexical);
}

/** Actor-convention fields (§7) are a string convention, never IRIs — always a plain literal. */
export function actorTerm(value: unknown): string {
  return literalTerm(safeString(value).trim());
}

/**
 * Producer-defined scalar/array values → object terms (typed where possible).
 * Nested mappings become `rdf:JSON` literals so they round-trip as objects.
 */
export function valueToTerms(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(valueToTerms);
  if (value instanceof Date) {
    const t = dateTerm(value);
    return t ? [t] : [];
  }
  if (typeof value === 'boolean') return [typedLiteralTerm(String(value), XSD_BOOLEAN)];
  if (typeof value === 'number') {
    return [typedLiteralTerm(String(value), Number.isInteger(value) ? XSD_INTEGER : XSD_DECIMAL)];
  }
  if (typeof value === 'string') {
    return [isSafeIri(value) ? value : literalTerm(value)];
  }
  return [typedLiteralTerm(jsonOf(value), RDF_JSON)];
}

/** The generic producer-defined-key mapping: `schema:<camelKey>` with typed terms (SPEC §4.1/§11). */
/**
 * A whole value as one `rdf:JSON` literal — how a family field that holds a
 * single value keeps a mapping or list it was given instead (kept verbatim,
 * decoded back to the same structure on export).
 */
export function jsonTerm(value: unknown): string {
  return typedLiteralTerm(jsonOf(value), RDF_JSON);
}

/** The generic producer-key predicate for `key`: `schema:<camelKey>` (SPEC §4.1/§11). */
export function genericPredicate(key: string): string {
  return SCHEMA_NS + camelCase(key);
}

export function genericQuads(subject: string, key: string, value: unknown): Quad[] {
  const predicate = genericPredicate(key);
  return valueToTerms(value).map((object) => ({ subject, predicate, object }));
}

/** Context the path-valued field resolver needs to recognise bundle concepts (SPEC §6.2). */
export interface PathContext {
  conceptId: string;
  iriBase: string;
  conceptExists: (conceptId: string) => boolean;
}

export interface PathFieldTerm {
  /** The object term: a concept IRI, an absolute URL, or a plain literal (path / scope descriptor). */
  term: string;
  /** Set when the value resolved to a concept in the bundle. */
  conceptId?: string;
  /** Set when the value looked like a bundle `.md` path but no such concept exists. */
  unresolvedConceptPath?: boolean;
}

/**
 * Resolve a path-valued field (`resource`, `sources[].resource`, `computation`,
 * `executor.resource`, `attester.resource` — SPEC §6.2):
 *
 *   - an absolute URL (scheme-prefixed) → IRI object, as written; when it is
 *     a bundle concept's own IRI (`urn:okf:p`), it also names that concept, so
 *     its lineage counts it as the `/p.md` spelling would;
 *   - a bundle path that names a concept → the concept's IRI (a typed graph
 *     edge). File-relative resolution (§6.2) is tried first, then the
 *     bundle-root-relative reading the reference bundles actually use
 *     (`policies/x.md` written from `metrics/y.md`), so both conventions resolve;
 *   - anything else (a non-concept artifact such as `attesters/x.py`, a
 *     `references/` file, or a scope descriptor) → the raw string as a literal.
 */
export function pathFieldTerm(value: unknown, ctx?: PathContext): PathFieldTerm {
  const s = safeString(value).trim();
  if (isSafeIri(s)) {
    const id = ctx && s.startsWith(ctx.iriBase) ? s.slice(ctx.iriBase.length) : null;
    return ctx && id !== null && ctx.conceptExists(id) ? { term: s, conceptId: id } : { term: s };
  }
  if (!ctx) return { term: literalTerm(s) };
  const direct = resolveLinkTarget(s, ctx.conceptId);
  if (direct && ctx.conceptExists(direct)) {
    return { term: conceptIdToIri(direct, ctx.iriBase), conceptId: direct };
  }
  const rooted = s.startsWith('/') ? null : resolveLinkTarget(`/${s}`, ctx.conceptId);
  if (rooted && ctx.conceptExists(rooted)) {
    return { term: conceptIdToIri(rooted, ctx.iriBase), conceptId: rooted };
  }
  const looksLikeConcept = s.endsWith('.md') && (direct !== null || rooted !== null);
  return { term: literalTerm(s), ...(looksLikeConcept ? { unresolvedConceptPath: true } : {}) };
}
