/**
 * Reading one family's fields back from RDF, shared by the family decoder
 * (`decode.ts`) and the `generated` / `timestamp` codec (`generated.ts`):
 * field predicates and `okf:<familyKey>.<key>` extensions on one subject, and
 * a value the encoder kept verbatim on the family key's generic predicate.
 * Every reader reports the quads it read.
 */

import { SCHEMA_NS } from '../constants.js';
import { okfExtensionKey } from '../extensions.js';
import { genericPredicate } from '../terms.js';
import { dict, isMapping } from '../utils.js';
import { accumulate, orderKeys, termValue, type ExportContext, type TermForm } from '../decode-terms.js';
import type { Quad } from '../types.js';
import { parseList } from './parse.js';
import type { FamilySpec, FieldSpec, ListFamilySpec, MappingFamilySpec } from './specs.js';

/** A value read back, and the quads it was read from. */
export interface Read {
  readonly value: unknown;
  readonly quads: readonly Quad[];
}

const FIELD_BY_PREDICATE = new Map<MappingFamilySpec | ListFamilySpec, ReadonlyMap<string, FieldSpec>>();

function fieldByPredicate(spec: MappingFamilySpec | ListFamilySpec): ReadonlyMap<string, FieldSpec> {
  let map = FIELD_BY_PREDICATE.get(spec);
  if (!map) {
    map = new Map(spec.fields.map((f) => [f.predicate, f]));
    FIELD_BY_PREDICATE.set(spec, map);
  }
  return map;
}

/** How a field's value is written back: a date field's import re-types its text, a path field's names a concept. */
export function formOf(field: FieldSpec): TermForm {
  return field.kind === 'date' || field.kind === 'path' ? field.kind : 'value';
}

/** Set-valued fields come back sorted: strings by value, a kept-verbatim structure by its JSON. */
function listKey(item: unknown): string {
  return typeof item === 'string' ? item : JSON.stringify(item);
}

export function byListKey(a: unknown, b: unknown): number {
  const x = listKey(a);
  const y = listKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A family's producer extensions on one subject (`okf:<familyKey>.<key>`), in quad order; adds the quads to `read`. */
function extensionsOf(quads: readonly Quad[], familyKey: string, ctx: ExportContext, read: Quad[]): Record<string, unknown> {
  const extras = dict();
  for (const q of quads) {
    const key = okfExtensionKey(familyKey, q.predicate);
    if (key === null) continue;
    accumulate(extras, key, termValue(q.object, ctx));
    read.push(q);
  }
  return extras;
}

/** The decoded fields and extensions of a mapping / entry on one subject, and the quads they were read from. */
export function decodeFields(
  spec: MappingFamilySpec | ListFamilySpec,
  quads: readonly Quad[],
  ctx: ExportContext,
): { value: Record<string, unknown>; fields: Record<string, unknown>; extensions: Record<string, unknown>; quads: Quad[] } {
  const byPredicate = fieldByPredicate(spec);
  const fields = dict();
  const lists = dict<unknown[]>();
  const read: Quad[] = [];
  for (const q of quads) {
    const field = byPredicate.get(q.predicate);
    if (!field) continue;
    read.push(q);
    const decoded = termValue(q.object, ctx, formOf(field));
    if (field.kind === 'text-list') (lists[field.key] ??= []).push(decoded);
    else fields[field.key] = decoded; // single-valued: last wins
  }
  for (const [key, items] of Object.entries(lists)) fields[key] = [...items].sort(byListKey);
  const extensions = extensionsOf(quads, spec.key, ctx, read);
  return { value: Object.assign(dict(), fields, extensions), fields, extensions, quads: read };
}

/** Whether a mapping family is there: any of its fields, or an extension. */
function isPresent(spec: MappingFamilySpec, decoded: { fields: Record<string, unknown>; extensions: Record<string, unknown> }): boolean {
  return spec.fields.some((f) => f.key in decoded.fields) || Object.keys(decoded.extensions).length > 0;
}

/** A mapping family on one subject, fields in definition order, or `null` when it is not there. */
export function decodeMapping(spec: MappingFamilySpec, quads: readonly Quad[], ctx: ExportContext): Read | null {
  const decoded = decodeFields(spec, quads, ctx);
  return isPresent(spec, decoded) ? { value: orderKeys(decoded.value, spec.fields.map((f) => f.key)), quads: decoded.quads } : null;
}

/** Whether the family keeps `value` verbatim: it is no value of the family's own shape. */
function keepsVerbatim(spec: FamilySpec, value: unknown): boolean {
  if (spec.shape === 'mapping') return !isMapping(value);
  if (spec.shape === 'list') return parseList(spec, value).shape === 'invalid';
  return false;
}

/**
 * A family's value kept verbatim (`encode.ts`): the triples on the family
 * key's generic predicate, read back the way a producer key's are, or `null`.
 * On an entry node they are all the family's, since a node carries no
 * producer keys. On the concept that predicate is also the one a producer key
 * of the same camelCase uses (`Sources`), so only an unambiguous value is the
 * family's: where the key reads back as the family key (`generated`), one
 * triple holding a value the family keeps verbatim (the encoder writes
 * exactly one); where it does not (`usage_window` → `usageWindow`), a list,
 * one `rdf:JSON` array, which no producer key yields (a producer key's list is
 * one triple per item). Anything else is a producer value, which the exporter
 * writes back under a spelling of its own.
 */
export function keptVerbatim(spec: FamilySpec, quads: readonly Quad[], ctx: ExportContext, on: 'node' | 'concept'): Read | null {
  const predicate = genericPredicate(spec.key);
  const onPredicate = quads.filter((q) => q.predicate === predicate);
  if (on === 'concept' && predicate === SCHEMA_NS + spec.key) {
    if (onPredicate.length !== 1) return null;
    const value = termValue(onPredicate[0].object, ctx);
    return keepsVerbatim(spec, value) ? { value, quads: onPredicate } : null;
  }
  const kept = dict();
  const read: Quad[] = [];
  for (const q of onPredicate) {
    const value = termValue(q.object, ctx);
    if (on === 'concept' && !Array.isArray(value)) continue;
    accumulate(kept, spec.key, value);
    read.push(q);
  }
  return read.length > 0 ? { value: kept[spec.key], quads: read } : null;
}
