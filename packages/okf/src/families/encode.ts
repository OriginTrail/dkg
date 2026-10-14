/**
 * OKF v0.2 families → RDF, driven by the definitions in `specs.ts`.
 *
 *   - a scalar family is one predicate on the concept;
 *   - a mapping family puts its fields flat on its subject;
 *   - a list family mints one skolemized node per usable entry
 *     (`<concept>/.well-known/genid/<tag><id>_<n>`, typed with the family's
 *     class and linked from the concept), `n` numbering the usable entries in
 *     order: export restores the order from it, and a skipped entry takes no
 *     number, so re-importing an export mints the same IRIs;
 *   - every key a family does not define is an extension, kept under
 *     `okf:<familyKey>.<key>` on the same subject;
 *   - a value of the wrong shape is kept verbatim under the family key's
 *     generic predicate (`schema:<camelKey>`), whole, and reported by
 *     `diagnostics.ts`.
 *
 * Two operations are not field mappings and stay explicit here: a
 * `derivesLineage` path field adds `prov:wasDerivedFrom` on the concept (§5.1),
 * and a `derivesTrustTier` list (`verified`) materialises the §5.3 tier.
 *
 * Encoding is two steps, so a bundle can settle which concepts it holds
 * before any reference is read: `prepareFamily` turns every value into terms
 * (the one place a value can fail to encode) and leaves each path-valued field
 * as a `PathReference`; `resolveReferences` then reads those against the
 * bundle, in place, adding the lineage edges and unresolved-path warnings.
 */

import {
  PROV_WAS_DERIVED_FROM,
  OKF_TRUST_TIER,
  RDF_TYPE,
  SECTION_GENID_INFIX,
  XSD_BOOLEAN,
  XSD_INTEGER,
} from '../constants.js';
import { keptVerbatimPredicate, okfExtensionPredicate } from '../extensions.js';
import { genericPredicate, genericQuads, dateTerm, jsonTerm, pathFieldTerm, toArray, valueToTerms, type PathContext } from '../terms.js';
import { deriveTrustTier } from '../trust.js';
import { isBlank, isMapping, isScalar, literalTerm, safeString, sanitizeForBlank, typedLiteralTerm } from '../utils.js';
import type { OkfWarning, Quad } from '../types.js';
import { parseList } from './parse.js';
import {
  definedKeys,
  type FamilySpec,
  type FieldSpec,
  type ListFamilySpec,
  type MappingFamilySpec,
} from './specs.js';

export interface FamilyResult {
  quads: Quad[];
  /** Bundle concepts named by a lineage field (`sources[].resource`). */
  derivedFromConcepts: string[];
  /** Context-dependent diagnostics only (unresolved bundle paths); shape issues come from `familyDiagnostics`. */
  warnings: OkfWarning[];
}

/**
 * A path-valued field (§6.2) before the bundle is known: whether it names a
 * concept, and so its object term, its lineage edge and any warning, depends
 * on which concepts the bundle holds.
 */
export interface PathReference {
  readonly kind: 'path';
  readonly subject: string;
  readonly predicate: string;
  /** The field's value as written (a single value). */
  readonly value: unknown;
  /** Names the field in a warning (`computation`, `sources[3].resource`). */
  readonly label: string;
  /** `sources[].resource`: the concept derives from what the value names (§5.1). */
  readonly derivesLineage: boolean;
}

/** An encoded quad, or a path-valued field still to be resolved in its place. */
export type PreparedQuad = Quad | PathReference;

interface Encoding {
  iri: string;
  conceptId: string;
  out: PreparedQuad[];
}

function nodeIri(iri: string, tag: string, conceptId: string, index: number): string {
  return `${iri}${SECTION_GENID_INFIX}${tag}${sanitizeForBlank(conceptId)}_${index}`;
}

/**
 * A field value's object terms, per its kind (see `FieldKind`), or `null` for
 * a path, whose term depends on the bundle. Every kind but `text-list` holds
 * one value; given a mapping or list instead, the field keeps it as one
 * `rdf:JSON` literal rather than coercing it — coercion would lose it, or
 * throw on a mapping that has its own `toString` key. For a `value` field a
 * list or mapping is a value like any other; for the rest it is the wrong
 * shape, kept verbatim and reported by the diagnostics.
 */
function fieldTerms(field: FieldSpec, value: unknown): string[] | null {
  if (field.kind !== 'text-list' && !isScalar(value)) return [jsonTerm(value)];
  switch (field.kind) {
    case 'text':
      return [literalTerm(safeString(value))];
    case 'token':
    case 'actor':
      return [literalTerm(safeString(value).trim())];
    case 'date': {
      const term = dateTerm(value);
      return term ? [term] : [];
    }
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? [typedLiteralTerm(String(value), XSD_INTEGER)]
        : valueToTerms(value).slice(0, 1);
    case 'boolean':
      return typeof value === 'boolean' ? [typedLiteralTerm(String(value), XSD_BOOLEAN)] : valueToTerms(value).slice(0, 1);
    case 'path':
      return null;
    case 'value':
      return valueToTerms(value);
    case 'text-list':
      return toArray(value).map((item) => (isScalar(item) ? literalTerm(safeString(item)) : jsonTerm(item)));
  }
}

/**
 * One field on `subject`. `label` names it in warnings (`computation`,
 * `sources[3].resource`). An absent field writes nothing, and so does a
 * `null`, except in a `value` field, where it is the value given (a
 * parameter `default: null` is no omitted default), kept as one `null`
 * (`rdf:JSON`).
 */
function encodeField(enc: Encoding, field: FieldSpec, subject: string, value: unknown, label: string): void {
  if (value === undefined || (value === null && field.kind !== 'value')) return;
  if (field.omitWhenBlank && isBlank(value)) return;
  const terms = fieldTerms(field, value);
  if (terms === null) {
    enc.out.push({ kind: 'path', subject, predicate: field.predicate, value, label, derivesLineage: field.derivesLineage === true });
    return;
  }
  for (const object of terms) enc.out.push({ subject, predicate: field.predicate, object });
}

/** A mapping's fields, nested families and extensions on `subject`. */
function encodeFields(
  enc: Encoding,
  spec: MappingFamilySpec | ListFamilySpec,
  subject: string,
  obj: Record<string, unknown>,
  label: string,
): void {
  for (const field of spec.fields) encodeField(enc, field, subject, obj[field.key], `${label}.${field.key}`);
  if (spec.shape === 'list') {
    for (const nested of spec.nested ?? []) {
      const value = obj[nested.key];
      if (value !== undefined && value !== null) encodeMapping(enc, nested, subject, value, `${label}.${nested.key}`);
    }
  }
  const defined = definedKeys(spec);
  for (const [key, value] of Object.entries(obj)) {
    if (defined.has(key) || value === null || value === undefined) continue;
    const predicate = okfExtensionPredicate(spec.key, key);
    for (const object of valueToTerms(value)) enc.out.push({ subject, predicate, object });
  }
}

/**
 * A family value of the wrong shape, kept verbatim under the family key's
 * generic predicate: a single value as its own term, anything else as one
 * `rdf:JSON` literal, never split into items. Each term is marked as the
 * family's (`keptVerbatimPredicate`), so ownership is read, not inferred. Export then restores the whole
 * value: a list stays a list, so `generated: [{ by: … }]` never comes back as
 * a valid `generated` mapping that would invent provenance.
 */
function keepVerbatim(enc: Encoding, subject: string, key: string, value: unknown): void {
  const terms = isScalar(value) ? genericQuads(subject, key, value).map((q) => q.object) : [jsonTerm(value)];
  for (const object of terms) {
    enc.out.push({ subject, predicate: genericPredicate(key), object });
    // The family owns this value, said explicitly: a producer key may share the predicate.
    enc.out.push({ subject, predicate: keptVerbatimPredicate(key), object });
  }
}

function encodeMapping(enc: Encoding, spec: MappingFamilySpec, subject: string, value: unknown, label: string): void {
  if (!isMapping(value)) {
    keepVerbatim(enc, subject, spec.key, value);
    return;
  }
  encodeFields(enc, spec, subject, value, label);
}

function encodeList(enc: Encoding, spec: ListFamilySpec, value: unknown): void {
  const parsed = parseList(spec, value);
  if (parsed.shape === 'invalid') {
    keepVerbatim(enc, enc.iri, spec.key, value);
    return;
  }
  let nodes = 0;
  for (const entry of parsed.entries) {
    if (!entry.usable) continue;
    nodes += 1;
    const node = nodeIri(enc.iri, spec.tag, enc.conceptId, entry.node);
    enc.out.push({ subject: enc.iri, predicate: spec.link, object: node });
    enc.out.push({ subject: node, predicate: RDF_TYPE, object: spec.nodeClass });
    encodeFields(enc, spec, node, entry.mapping, `${spec.key}[${entry.index}]`);
  }
  // §5.3: the trust tier is derived from the same parse and materialised once a verifier exists.
  if (spec.derivesTrustTier && nodes > 0) {
    enc.out.push({ subject: enc.iri, predicate: OKF_TRUST_TIER, object: literalTerm(deriveTrustTier(value)) });
  }
}

/**
 * One v0.2 family's frontmatter value as quads on the concept `iri`, its
 * path-valued fields left as references (`resolveReferences` reads them).
 * Throws `OkfValueError` for a value no RDF term can hold.
 */
export function prepareFamily(iri: string, conceptId: string, spec: FamilySpec, value: unknown): PreparedQuad[] {
  const enc: Encoding = { iri, conceptId, out: [] };
  switch (spec.shape) {
    case 'scalar':
      encodeField(enc, spec.field, iri, value, spec.key);
      break;
    case 'mapping':
      encodeMapping(enc, spec, iri, value, spec.key);
      break;
    case 'list':
      encodeList(enc, spec, value);
      break;
  }
  return enc.out;
}

/**
 * Resolve the path references among `prepared` against the bundle (`ctx`),
 * each in its place: a value that names a bundle concept becomes an edge to
 * it, a URL an IRI, anything else a literal (§6.2). A `derivesLineage` field
 * adds `prov:wasDerivedFrom` on the concept `iri` for every value with an IRI
 * (§5.1), and a `.md` path that names no concept is a warning, never an error,
 * as is a value shaped like an IRI that the write rule refuses (kept as a
 * literal, so it derives no lineage).
 */
export function resolveReferences(iri: string, prepared: readonly PreparedQuad[], ctx: PathContext): FamilyResult {
  const result: FamilyResult = { quads: [], derivedFromConcepts: [], warnings: [] };
  for (const item of prepared) {
    if (!('kind' in item)) {
      result.quads.push(item);
      continue;
    }
    const path = pathFieldTerm(item.value, ctx);
    result.quads.push({ subject: item.subject, predicate: item.predicate, object: path.term });
    if (item.derivesLineage) {
      if (path.conceptId) result.derivedFromConcepts.push(path.conceptId);
      if (!path.term.startsWith('"')) result.quads.push({ subject: iri, predicate: PROV_WAS_DERIVED_FROM, object: path.term });
    }
    if (path.malformedIri) {
      result.warnings.push({
        conceptId: ctx.conceptId,
        code: 'invalid-iri',
        message: `${item.label} "${safeString(item.value).trim()}" is not a valid IRI (RFC 3987); kept as a literal`,
      });
    }
    if (path.unresolvedConceptPath) {
      result.warnings.push({
        conceptId: ctx.conceptId,
        code: 'broken-link',
        message: `${item.label} "${safeString(item.value).trim()}" does not resolve to a concept in the bundle (not an error, SPEC §6.1/§11)`,
      });
    }
  }
  return result;
}
