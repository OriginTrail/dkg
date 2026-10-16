/**
 * Context-free shape checks for the OKF v0.2 families (SPEC §5, §10), driven
 * by the definitions in `specs.ts`. These are SHOULD-level producer rules: a
 * consumer MUST NOT reject for any of them (§11), so every finding is a
 * warning. Shared by `validateBundle` and the mapper so the two never disagree.
 *
 * Every rule is read from the definitions: a family of the wrong shape
 * (`shapeNote`), a list entry that is not a mapping (`entryNote`), a blank
 * required field (`requiredNote`), a value outside `allowedValues` (`status`,
 * §5.4), a family missing on a concept of its `requiredForType` (`runtime` on
 * an Attested Computation, §10.2), an invalid date, a non-integer integer.
 */

import { dateTimeLexical, hasExplicitOffset, isXsdDateTime } from '../timestamps.js';
import { isConceptType } from '../terms.js';
import { isBlank, isMapping, isScalar, safeString } from '../utils.js';
import type { OkfWarning } from '../types.js';
import { parseList } from './parse.js';
import {
  FAMILY_SPECS,
  SOURCES,
  type FamilySpec,
  type FieldSpec,
  type ListFamilySpec,
  type MappingFamilySpec,
} from './specs.js';

type Diagnostic = Pick<OkfWarning, 'code' | 'message'>;

function checkDateTime(field: string, value: unknown, out: Diagnostic[]): void {
  if (value === undefined || value === null) return;
  const lexical = dateTimeLexical(value);
  if (lexical === null || !isXsdDateTime(lexical)) {
    out.push({
      code: 'malformed-family',
      message: `${field} "${safeString(value)}" is not a valid ISO 8601 datetime (§5); kept as a plain literal`,
    });
    return;
  }
  if (!hasExplicitOffset(lexical)) {
    out.push({
      code: 'malformed-family',
      message: `${field} "${lexical}" has no explicit UTC offset (§5 requires one, e.g. 2026-06-30T14:00:00Z)`,
    });
  }
}

function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** The backticked name of a field in a message (`stale_after`, `sources[0].usage_window.from`). */
function fieldLabel(spec: FamilySpec, label: string, field: FieldSpec): string {
  return spec.shape === 'scalar' ? `\`${label}\`` : `\`${label}.${field.key}\``;
}

function checkField(spec: FamilySpec, field: FieldSpec, value: unknown, label: string, out: Diagnostic[]): void {
  if (value === undefined || value === null) return;
  const name = fieldLabel(spec, label, field);
  if (field.kind === 'text-list') {
    toList(value).forEach((item, i) => {
      if (!isScalar(item)) {
        out.push({ code: 'malformed-family', message: `${name.slice(0, -1)}[${i}]\` should be a single value, not a mapping or list (${spec.section}); kept verbatim` });
      }
    });
    return;
  }
  // A `value` field holds a value of any shape, a list or mapping included.
  if (field.kind === 'value') return;
  if (!isScalar(value)) {
    const outcome = field.skipEntryWhenBlank ? 'the entry is skipped' : 'kept verbatim';
    out.push({ code: 'malformed-family', message: `${name} should be a single value, not a mapping or list (${spec.section}); ${outcome}` });
    return;
  }
  if (field.allowedValues) {
    const s = safeString(value).trim();
    if (!field.allowedValues.includes(s)) {
      out.push({ code: 'malformed-family', message: `${name} "${s}" is not one of ${field.allowedValues.join(' | ')} (${spec.section}); kept verbatim` });
    }
  }
  if (field.kind === 'date') checkDateTime(name, value, out);
  else if (field.kind === 'integer' && !(typeof value === 'number' && Number.isInteger(value))) {
    out.push({ code: 'malformed-family', message: `${name} should be an integer (${spec.section})` });
  }
}

function checkEntry(
  spec: MappingFamilySpec | ListFamilySpec,
  obj: Record<string, unknown>,
  label: string,
  out: Diagnostic[],
): void {
  for (const field of spec.fields) {
    const value = obj[field.key];
    if (field.requiredNote && isBlank(value)) {
      out.push({ code: 'malformed-family', message: `\`${label}.${field.key}\` ${field.requiredNote}` });
    }
    checkField(spec, field, value, label, out);
  }
  if (spec.shape === 'list') {
    for (const nested of spec.nested ?? []) {
      const value = obj[nested.key];
      if (value !== undefined && value !== null) checkFamily(nested, value, `${label}.${nested.key}`, out);
    }
  }
}

function checkFamily(spec: FamilySpec, value: unknown, label: string, out: Diagnostic[]): void {
  switch (spec.shape) {
    case 'scalar':
      checkField(spec, spec.field, value, label, out);
      break;
    case 'mapping':
      if (!isMapping(value)) out.push({ code: 'malformed-family', message: `\`${label}\` ${spec.shapeNote}` });
      else checkEntry(spec, value, label, out);
      break;
    case 'list': {
      const parsed = parseList(spec, value);
      if (parsed.shape === 'invalid') {
        out.push({ code: 'malformed-family', message: `\`${label}\` ${spec.shapeNote}` });
        break;
      }
      for (const entry of parsed.entries) {
        const entryLabel = `${label}[${entry.index}]`;
        if (entry.mapping === null) out.push({ code: 'malformed-family', message: `\`${entryLabel}\` ${spec.entryNote}` });
        else checkEntry(spec, entry.mapping, entryLabel, out);
      }
      break;
    }
  }
}

/**
 * Shape diagnostics for every v0.2 family a concept carries, in the order of
 * `FAMILY_SPECS`. Never rejects (§11).
 */
export function familyDiagnostics(frontmatter: Record<string, unknown>): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const spec of FAMILY_SPECS) {
    const requirement = spec.requiredForType;
    if (requirement && isConceptType(frontmatter.type, requirement.type) && isBlank(frontmatter[spec.key])) {
      out.push({ code: 'malformed-family', message: `\`${spec.key}\` ${requirement.note}` });
    }
    const value = frontmatter[spec.key];
    if (value !== undefined && value !== null) checkFamily(spec, value, spec.key, out);
  }
  return out;
}

/** The `sources[].id` labels a body footnote may join against (§5.1). */
export function sourceIds(frontmatter: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const entry of parseList(SOURCES, frontmatter.sources).entries) {
    const id = entry.mapping?.id;
    if (id !== undefined && id !== null) ids.add(safeString(id));
  }
  return ids;
}

/** True when the document declares a `sources` family at all (footnote checks apply only then). */
export function declaresSources(frontmatter: Record<string, unknown>): boolean {
  return frontmatter.sources !== undefined && frontmatter.sources !== null;
}
