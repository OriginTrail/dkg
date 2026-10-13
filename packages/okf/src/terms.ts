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
import { isSafeIri, literalTerm, typedLiteralTerm, pascalCase, camelCase } from './utils.js';
import { dateTimeLexical, isXsdDate, isXsdDateTime } from './trust.js';
import type { Quad } from './types.js';

/** A YAML mapping (not a list, not a Date). */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** OKF `type` value → an rdf:type object IRI (raw, no angle brackets). */
export function typeToIri(value: unknown): string | null {
  const s = String(value).trim();
  if (!s) return null;
  if (isSafeIri(s)) return s; // already a full IRI (e.g. `tag:…`, `https://…`)
  const pascal = pascalCase(s);
  return pascal ? SCHEMA_NS + pascal : null;
}

/**
 * True when a `type` value names the spec's Attested Computation concept (§10).
 * Tolerant of the PascalCased spelling the rdf:type IRI carries (and that an
 * export of a pre-fix graph may have written back), so detection survives a
 * round trip.
 */
export function isAttestedComputationType(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return pascalCase(String(value)) === pascalCase(OKF_ATTESTED_COMPUTATION_TYPE);
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
  return literalTerm(String(value).trim());
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
  return [typedLiteralTerm(JSON.stringify(value), RDF_JSON)];
}

/** The generic producer-defined-key mapping: `schema:<camelKey>` with typed terms (SPEC §4.1/§11). */
export function genericQuads(subject: string, key: string, value: unknown): Quad[] {
  const predicate = SCHEMA_NS + camelCase(key);
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
 *   - an absolute URL (scheme-prefixed) → IRI object;
 *   - a bundle path that names a concept → the concept's IRI (a typed graph
 *     edge). File-relative resolution (§6.2) is tried first, then the
 *     bundle-root-relative reading the reference bundles actually use
 *     (`policies/x.md` written from `metrics/y.md`), so both conventions resolve;
 *   - anything else (a non-concept artifact such as `attesters/x.py`, a
 *     `references/` file, or a scope descriptor) → the raw string as a literal.
 */
export function pathFieldTerm(value: unknown, ctx?: PathContext): PathFieldTerm {
  const s = String(value).trim();
  if (isSafeIri(s)) return { term: s };
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
