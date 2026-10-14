/**
 * Reading one family's fields back from RDF, shared by the family decoder
 * (`decode.ts`) and the `generated` / `timestamp` codec (`generated.ts`):
 * field predicates and `okf:<familyKey>.<key>` extensions on one subject, and
 * a value the encoder kept verbatim on the family key's generic predicate, by
 * its marker. Every reader reports the quads it read, and reads declared
 * ownership alone: `ownership.ts` names the owners of the dates a graph leaves
 * unnamed before any of them runs.
 */

import { keptVerbatimPredicate, okfExtensionKey } from '../extensions.js';
import { genericPredicate } from '../terms.js';
import { dict, last } from '../utils.js';
import { orderKeys, termValue, ValueBuckets, type ExportContext, type TermForm } from '../decode-terms.js';
import type { Quad } from '../types.js';
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
  const extras = new ValueBuckets();
  for (const q of quads) {
    const key = okfExtensionKey(familyKey, q.predicate);
    if (key === null) continue;
    extras.add(key, termValue(q.object, ctx));
    read.push(q);
  }
  return extras.toDict();
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

/**
 * A family's value kept verbatim (`encode.ts`), or `null`. The encoder marks
 * it (`keptVerbatimPredicate`, the same object term as its queryable copy on
 * the family key's generic predicate), so the marker names the family's
 * value even when a producer key of the same camelCase (`Sources`) shares the
 * predicate; both triples are the family's, and every other value on the
 * predicate is a producer value, which the exporter writes back under a
 * spelling of its own. A value is kept verbatim only by a mapper that marks
 * it: the v0.1 mapper kept none.
 */
export function keptVerbatim(spec: FamilySpec, quads: readonly Quad[], ctx: ExportContext): Read | null {
  const markers = quads.filter((q) => q.predicate === keptVerbatimPredicate(spec.key));
  const marked = last(markers);
  if (!marked) return null;
  const predicate = genericPredicate(spec.key);
  const copies = quads.filter((q) => q.predicate === predicate && q.object === marked.object);
  return { value: termValue(marked.object, ctx), quads: [...markers, ...copies] };
}
