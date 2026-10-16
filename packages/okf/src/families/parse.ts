/**
 * The one place a list-valued family's entries are classified (SPEC §5.1,
 * §5.2, §10.2). Encoding, decoding, diagnostics, trust tiers and summary
 * counts all read a `ParsedList`, so "which entries become nodes" and "at
 * which index" are decided once.
 */

import { isBlank, isMapping, isScalar } from '../utils.js';
import type { ListFamilySpec } from './specs.js';

/**
 * One entry of a list family, classified once: a usable entry (a mapping whose
 * every `skipEntryWhenBlank` field holds one non-blank value) becomes a node,
 * and only it carries a node number; a skipped one is any other mapping or
 * not a mapping at all. Narrowing on `usable` gives the mapping and the
 * number together.
 */
export type ParsedEntry = UsableEntry | SkippedEntry;

interface EntryPosition {
  /** Position in the frontmatter list (0 for a bare mapping); warnings name the entry by it. */
  readonly index: number;
}

export interface UsableEntry extends EntryPosition {
  readonly usable: true;
  readonly mapping: Record<string, unknown>;
  /**
   * The number its node IRI carries: its position among the usable entries.
   * A skipped entry takes no number, so the IRIs are the same after an
   * export, which writes only the usable entries, and a re-import.
   */
  readonly node: number;
}

export interface SkippedEntry extends EntryPosition {
  readonly usable: false;
  /** The entry when it is a mapping, else `null`. */
  readonly mapping: Record<string, unknown> | null;
  readonly node: null;
}

export interface ParsedList {
  /** `invalid`: neither a list nor, where accepted, a bare mapping. The value is then kept verbatim. */
  readonly shape: 'list' | 'mapping' | 'invalid';
  readonly entries: readonly ParsedEntry[];
}

export function parseList(spec: ListFamilySpec, value: unknown): ParsedList {
  const raw: unknown[] | null = Array.isArray(value)
    ? value
    : spec.acceptsBareMapping && isMapping(value)
      ? [value]
      : null;
  if (raw === null) return { shape: 'invalid', entries: [] };
  let nodes = 0;
  const entries = raw.map((entry, index): ParsedEntry => {
    const mapping = isMapping(entry) ? entry : null;
    if (mapping !== null && spec.fields.every((f) => !f.skipEntryWhenBlank || (isScalar(mapping[f.key]) && !isBlank(mapping[f.key])))) {
      return { index, mapping, usable: true, node: nodes++ };
    }
    return { index, mapping, usable: false, node: null };
  });
  return { shape: Array.isArray(value) ? 'list' : 'mapping', entries };
}
