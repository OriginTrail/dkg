/**
 * The OKF v0.2 family vocabulary as data (SPEC §5, §7, §10).
 *
 * For every frontmatter family this declares, once: its shape, its ordered
 * field → predicate table, how each field's value becomes a term, and the
 * wording its diagnostics use. The encoder (`encode.ts`), the decoder
 * (`decode.ts`), the shape diagnostics (`diagnostics.ts`) and the
 * verification parser (`../trust.ts`) all read these definitions, so a field
 * is never declared in more than one place. Field order is also the key order
 * export writes.
 *
 * Producer-defined keys inside a family are not listed here: anything that is
 * not a field (or a nested family) is an extension, carried under
 * `okf:<familyKey>.<key>` (`../extensions.ts`).
 */

import {
  SCHEMA_DATE_MODIFIED,
  SCHEMA_IDENTIFIER,
  SCHEMA_NAME,
  OKF_GENERATED_BY,
  OKF_VERIFICATION,
  OKF_VERIFIED_BY,
  OKF_VERIFIED_AT,
  OKF_STATUS,
  OKF_STALE_AFTER,
  OKF_SOURCE,
  OKF_RESOURCE,
  OKF_AUTHOR,
  OKF_USAGE_COUNT,
  OKF_USAGE_WINDOW_FROM,
  OKF_USAGE_WINDOW_TO,
  OKF_RUNTIME,
  OKF_PARAMETER,
  OKF_PARAMETER_TYPE,
  OKF_REQUIRED,
  OKF_COMPUTATION,
  OKF_EXECUTOR_RESOURCE,
  OKF_EXECUTOR_RECEIPT,
  OKF_ATTESTER_RESOURCE,
  OKF_CLASS_VERIFICATION,
  OKF_CLASS_SOURCE,
  OKF_CLASS_PARAMETER,
  GENID_TAGS,
} from '../constants.js';

/** How a field's value becomes an RDF object term, and back. */
export type FieldKind =
  /** `String(value)` as a plain literal, verbatim. */
  | 'text'
  /** `String(value).trim()` as a plain literal (`status`, `runtime`). */
  | 'token'
  /** The §7 actor convention: a trimmed plain literal, never an IRI. */
  | 'actor'
  /** `xsd:dateTime` / `xsd:date` when the value is valid, else a plain literal. */
  | 'date'
  /** `xsd:integer` for an integer, else the generic term for the value. */
  | 'integer'
  /** `xsd:boolean` for a boolean, else the generic term for the value. */
  | 'boolean'
  /** A §6.2 path-valued field: a bundle concept's IRI, an absolute IRI, or a literal. */
  | 'path'
  /** One plain literal per element; set semantics, so it decodes sorted. */
  | 'text-list';

export interface FieldSpec {
  /** Key inside the family's mapping or entry. */
  readonly key: string;
  /** Predicate the field maps to, on the family's subject. */
  readonly predicate: string;
  readonly kind: FieldKind;
  /** When set, an absent or blank value is reported with this wording. */
  readonly requiredNote?: string;
  /** A blank value is not encoded at all (`generated.by: ''`). */
  readonly omitWhenBlank?: boolean;
  /** An entry whose value is blank cannot become a node and is skipped (`verified[].by`). */
  readonly skipEntryWhenBlank?: boolean;
  /** The concept also `prov:wasDerivedFrom` this field's resource whenever it has an IRI (§5.1 lineage). */
  readonly derivesLineage?: boolean;
}

interface FamilyBase {
  /** Frontmatter key. */
  readonly key: string;
  /** SPEC section cited by diagnostics. */
  readonly section: string;
}

/** One value flat on the concept: `status`, `stale_after`, `runtime`, `computation`. */
export interface ScalarFamilySpec extends FamilyBase {
  readonly shape: 'scalar';
  readonly field: FieldSpec;
}

/** A mapping flat on its subject: `generated`, `usage_window`, `executor`, `attester`. */
export interface MappingFamilySpec extends FamilyBase {
  readonly shape: 'mapping';
  readonly fields: readonly FieldSpec[];
  /** Diagnostic wording when the value is not a mapping (it is then kept verbatim). */
  readonly shapeNote: string;
  /**
   * When set, a decoded family exists only if one of these fields, or an
   * extension, is present. `generated` needs its `by` (§5.2): a bare
   * last-modified time exports as the legacy `timestamp` instead.
   */
  readonly presentWith?: readonly string[];
}

/** A list of entries, one skolemized node each: `verified`, `sources`, `parameters`. */
export interface ListFamilySpec extends FamilyBase {
  readonly shape: 'list';
  /** A bare mapping counts as a one-element list. */
  readonly acceptsBareMapping: boolean;
  /** Concept → entry-node predicate. */
  readonly link: string;
  /** `rdf:type` of an entry node. */
  readonly nodeClass: string;
  /** Tag inside an entry node's genid IRI. */
  readonly tag: string;
  readonly fields: readonly FieldSpec[];
  /** Mapping families nested in an entry (`sources[].usage_window`). */
  readonly nested?: readonly MappingFamilySpec[];
  /** Diagnostic wording when the value has the wrong shape (it is then kept verbatim). */
  readonly shapeNote: string;
  /** Diagnostic wording for an entry that is not a mapping (it is skipped). */
  readonly entryNote: string;
}

export type FamilySpec = ScalarFamilySpec | MappingFamilySpec | ListFamilySpec;

export const GENERATED: MappingFamilySpec = {
  key: 'generated',
  section: '§5.2',
  shape: 'mapping',
  shapeNote: 'must be a `{ by, at }` mapping (§5.2); preserved verbatim',
  presentWith: ['by'],
  fields: [
    { key: 'by', predicate: OKF_GENERATED_BY, kind: 'actor', requiredNote: 'is required within `generated` (§5.2)', omitWhenBlank: true },
    { key: 'at', predicate: SCHEMA_DATE_MODIFIED, kind: 'date' },
  ],
};

export const VERIFIED: ListFamilySpec = {
  key: 'verified',
  section: '§5.2',
  shape: 'list',
  acceptsBareMapping: true,
  link: OKF_VERIFICATION,
  nodeClass: OKF_CLASS_VERIFICATION,
  tag: GENID_TAGS.verification,
  shapeNote: 'must be a `{ by, at }` mapping or a list of them (§5.2); preserved verbatim',
  entryNote: 'is not a `{ by, at }` mapping (§5.2); skipped',
  fields: [
    {
      key: 'by',
      predicate: OKF_VERIFIED_BY,
      kind: 'actor',
      requiredNote: 'is missing (§5.2); the event cannot name a verifier and is skipped',
      skipEntryWhenBlank: true,
    },
    { key: 'at', predicate: OKF_VERIFIED_AT, kind: 'date' },
  ],
};

export const STATUS: ScalarFamilySpec = {
  key: 'status',
  section: '§5.4',
  shape: 'scalar',
  field: { key: 'status', predicate: OKF_STATUS, kind: 'token' },
};

export const STALE_AFTER: ScalarFamilySpec = {
  key: 'stale_after',
  section: '§5.5',
  shape: 'scalar',
  field: { key: 'stale_after', predicate: OKF_STALE_AFTER, kind: 'date' },
};

export const USAGE_WINDOW: MappingFamilySpec = {
  key: 'usage_window',
  section: '§5.1',
  shape: 'mapping',
  shapeNote: 'must be a `{ from, to }` mapping (§5.1); preserved verbatim',
  fields: [
    { key: 'from', predicate: OKF_USAGE_WINDOW_FROM, kind: 'date' },
    { key: 'to', predicate: OKF_USAGE_WINDOW_TO, kind: 'date' },
  ],
};

export const SOURCES: ListFamilySpec = {
  key: 'sources',
  section: '§5.1',
  shape: 'list',
  acceptsBareMapping: true,
  link: OKF_SOURCE,
  nodeClass: OKF_CLASS_SOURCE,
  tag: GENID_TAGS.source,
  shapeNote: 'must be a list of entries (§5.1); preserved verbatim',
  entryNote: 'is not a mapping (§5.1); skipped',
  fields: [
    { key: 'id', predicate: SCHEMA_IDENTIFIER, kind: 'text' },
    { key: 'resource', predicate: OKF_RESOURCE, kind: 'path', requiredNote: 'is required within an entry (§5.1)', derivesLineage: true },
    { key: 'title', predicate: SCHEMA_NAME, kind: 'text' },
    { key: 'author', predicate: OKF_AUTHOR, kind: 'actor' },
    { key: 'usage_count', predicate: OKF_USAGE_COUNT, kind: 'integer' },
    { key: 'last_modified', predicate: SCHEMA_DATE_MODIFIED, kind: 'date' },
  ],
  nested: [USAGE_WINDOW],
};

export const RUNTIME: ScalarFamilySpec = {
  key: 'runtime',
  section: '§10.2',
  shape: 'scalar',
  field: { key: 'runtime', predicate: OKF_RUNTIME, kind: 'token' },
};

export const PARAMETERS: ListFamilySpec = {
  key: 'parameters',
  section: '§10.2',
  shape: 'list',
  acceptsBareMapping: false,
  link: OKF_PARAMETER,
  nodeClass: OKF_CLASS_PARAMETER,
  tag: GENID_TAGS.parameter,
  shapeNote: 'must be a list of `{ name, type, required }` entries (§10.2); preserved verbatim',
  entryNote: 'is not a mapping (§10.2); skipped',
  fields: [
    { key: 'name', predicate: SCHEMA_NAME, kind: 'text', requiredNote: 'is missing (§10.2)' },
    { key: 'type', predicate: OKF_PARAMETER_TYPE, kind: 'text' },
    { key: 'required', predicate: OKF_REQUIRED, kind: 'boolean' },
  ],
};

export const COMPUTATION: ScalarFamilySpec = {
  key: 'computation',
  section: '§10.2',
  shape: 'scalar',
  field: { key: 'computation', predicate: OKF_COMPUTATION, kind: 'path' },
};

export const EXECUTOR: MappingFamilySpec = {
  key: 'executor',
  section: '§10.2',
  shape: 'mapping',
  shapeNote: 'must be a mapping with a `resource` (§10.2); preserved verbatim',
  fields: [
    { key: 'resource', predicate: OKF_EXECUTOR_RESOURCE, kind: 'path' },
    { key: 'receipt', predicate: OKF_EXECUTOR_RECEIPT, kind: 'text-list' },
  ],
};

export const ATTESTER: MappingFamilySpec = {
  key: 'attester',
  section: '§10.2',
  shape: 'mapping',
  shapeNote: 'must be a mapping with a `resource` (§10.2); preserved verbatim',
  fields: [{ key: 'resource', predicate: OKF_ATTESTER_RESOURCE, kind: 'path' }],
};

/** Every v0.2 family (SPEC §13.2), in the order diagnostics are reported. */
export const FAMILY_SPECS: readonly FamilySpec[] = [
  GENERATED,
  VERIFIED,
  STATUS,
  STALE_AFTER,
  SOURCES,
  USAGE_WINDOW,
  RUNTIME,
  PARAMETERS,
  COMPUTATION,
  EXECUTOR,
  ATTESTER,
];

export const FAMILY_BY_KEY: ReadonlyMap<string, FamilySpec> = new Map(FAMILY_SPECS.map((spec) => [spec.key, spec]));

/** Frontmatter keys owned by the v0.2 families. Everything else is a producer key. */
export const V02_FAMILY_KEYS: ReadonlySet<string> = new Set(FAMILY_SPECS.map((spec) => spec.key));

const DEFINED_KEYS = new Map<MappingFamilySpec | ListFamilySpec, ReadonlySet<string>>();

/** Keys a mapping / entry defines itself (its fields and nested families). Any other key is an extension. */
export function definedKeys(spec: MappingFamilySpec | ListFamilySpec): ReadonlySet<string> {
  let keys = DEFINED_KEYS.get(spec);
  if (!keys) {
    const nested = spec.shape === 'list' ? (spec.nested ?? []) : [];
    keys = new Set([...spec.fields.map((f) => f.key), ...nested.map((n) => n.key)]);
    DEFINED_KEYS.set(spec, keys);
  }
  return keys;
}
