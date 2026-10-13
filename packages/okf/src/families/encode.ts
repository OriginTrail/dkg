/**
 * OKF v0.2 families → RDF, driven by the definitions in `specs.ts`.
 *
 *   - a scalar family is one predicate on the concept;
 *   - a mapping family puts its fields flat on its subject;
 *   - a list family mints one skolemized node per usable entry
 *     (`<concept>/.well-known/genid/<tag><id>_<n>`, typed with the family's
 *     class and linked from the concept), with the entry index `n` in the IRI
 *     so export restores the order;
 *   - every key a family does not define is an extension, kept under
 *     `okf:<familyKey>.<key>` on the same subject;
 *   - a value of the wrong shape is kept verbatim as a producer key
 *     (`schema:<camelKey>`) and reported by `diagnostics.ts`.
 *
 * Two operations are not field mappings and stay explicit here: a
 * `derivesLineage` path field adds `prov:wasDerivedFrom` on the concept (§5.1),
 * and a `derivesTrustTier` list (`verified`) materialises the §5.3 tier.
 */

import {
  PROV_WAS_DERIVED_FROM,
  OKF_TRUST_TIER,
  RDF_TYPE,
  SECTION_GENID_INFIX,
  XSD_BOOLEAN,
  XSD_INTEGER,
} from '../constants.js';
import { okfExtensionPredicate } from '../extensions.js';
import { genericQuads, dateTerm, pathFieldTerm, toArray, valueToTerms, type PathContext, type PathFieldTerm } from '../terms.js';
import { deriveTrustTier } from '../trust.js';
import { isBlank, isMapping, literalTerm, sanitizeForBlank, typedLiteralTerm } from '../utils.js';
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

interface Encoding {
  iri: string;
  ctx: PathContext;
  result: FamilyResult;
}

function nodeIri(iri: string, tag: string, conceptId: string, index: number): string {
  return `${iri}${SECTION_GENID_INFIX}${tag}${sanitizeForBlank(conceptId)}_${index}`;
}

/** A field value's object terms, per its kind (see `FieldKind`). */
function fieldTerms(field: FieldSpec, value: unknown, ctx: PathContext): { terms: string[]; path?: PathFieldTerm } {
  switch (field.kind) {
    case 'text':
      return { terms: [literalTerm(String(value))] };
    case 'token':
    case 'actor':
      return { terms: [literalTerm(String(value).trim())] };
    case 'date': {
      const term = dateTerm(value);
      return { terms: term ? [term] : [] };
    }
    case 'integer':
      return {
        terms:
          typeof value === 'number' && Number.isInteger(value)
            ? [typedLiteralTerm(String(value), XSD_INTEGER)]
            : valueToTerms(value).slice(0, 1),
      };
    case 'boolean':
      return {
        terms: typeof value === 'boolean' ? [typedLiteralTerm(String(value), XSD_BOOLEAN)] : valueToTerms(value).slice(0, 1),
      };
    case 'path': {
      const path = pathFieldTerm(value, ctx);
      return { terms: [path.term], path };
    }
    case 'text-list':
      return { terms: toArray(value).map((item) => literalTerm(String(item))) };
  }
}

/** One field on `subject`. `label` names it in warnings (`computation`, `sources[3].resource`). */
function encodeField(enc: Encoding, field: FieldSpec, subject: string, value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (field.omitWhenBlank && isBlank(value)) return;
  const { terms, path } = fieldTerms(field, value, enc.ctx);
  for (const object of terms) enc.result.quads.push({ subject, predicate: field.predicate, object });
  if (!path) return;
  if (field.derivesLineage) {
    // §5.1 lineage: the concept derives from any source with an IRI.
    if (path.conceptId) enc.result.derivedFromConcepts.push(path.conceptId);
    if (!path.term.startsWith('"')) {
      enc.result.quads.push({ subject: enc.iri, predicate: PROV_WAS_DERIVED_FROM, object: path.term });
    }
  }
  if (path.unresolvedConceptPath) {
    enc.result.warnings.push({
      conceptId: enc.ctx.conceptId,
      code: 'broken-link',
      message: `${label} "${String(value).trim()}" does not resolve to a concept in the bundle (not an error, SPEC §6.1/§11)`,
    });
  }
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
    for (const object of valueToTerms(value)) enc.result.quads.push({ subject, predicate, object });
  }
}

function encodeMapping(enc: Encoding, spec: MappingFamilySpec, subject: string, value: unknown, label: string): void {
  if (!isMapping(value)) {
    enc.result.quads.push(...genericQuads(subject, spec.key, value));
    return;
  }
  encodeFields(enc, spec, subject, value, label);
}

function encodeList(enc: Encoding, spec: ListFamilySpec, value: unknown): void {
  const parsed = parseList(spec, value);
  if (parsed.shape === 'invalid') {
    enc.result.quads.push(...genericQuads(enc.iri, spec.key, value));
    return;
  }
  let nodes = 0;
  for (const entry of parsed.entries) {
    if (!entry.usable || entry.mapping === null) continue;
    nodes += 1;
    const node = nodeIri(enc.iri, spec.tag, enc.ctx.conceptId, entry.index);
    enc.result.quads.push({ subject: enc.iri, predicate: spec.link, object: node });
    enc.result.quads.push({ subject: node, predicate: RDF_TYPE, object: spec.nodeClass });
    encodeFields(enc, spec, node, entry.mapping, `${spec.key}[${entry.index}]`);
  }
  // §5.3: the trust tier is derived from the same parse and materialised once a verifier exists.
  if (spec.derivesTrustTier && nodes > 0) {
    enc.result.quads.push({ subject: enc.iri, predicate: OKF_TRUST_TIER, object: literalTerm(deriveTrustTier(value)) });
  }
}

/** Map one v0.2 family's frontmatter value onto the concept `iri`. */
export function encodeFamily(iri: string, spec: FamilySpec, value: unknown, ctx: PathContext): FamilyResult {
  const enc: Encoding = { iri, ctx, result: { quads: [], derivedFromConcepts: [], warnings: [] } };
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
  return enc.result;
}
