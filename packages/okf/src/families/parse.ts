/**
 * The one place a list-valued family's entries are classified (SPEC §5.1,
 * §5.2, §10.2). Encoding, decoding, diagnostics, trust tiers and summary
 * counts all read a `ParsedList`, so "which entries become nodes" and "at
 * which index" are decided once.
 */

import { isBlank, isMapping } from '../utils.js';
import type { ListFamilySpec } from './specs.js';

export interface ParsedEntry {
  /** Position in the frontmatter list (0 for a bare mapping); the node IRI carries it. */
  readonly index: number;
  /** The entry when it is a mapping, else `null`. */
  readonly mapping: Record<string, unknown> | null;
  /** Whether the entry becomes a node: a mapping with every `skipEntryWhenBlank` field present. */
  readonly usable: boolean;
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
  const entries = raw.map((entry, index): ParsedEntry => {
    const mapping = isMapping(entry) ? entry : null;
    const usable = mapping !== null && spec.fields.every((f) => !f.skipEntryWhenBlank || !isBlank(mapping[f.key]));
    return { index, mapping, usable };
  });
  return { shape: Array.isArray(value) ? 'list' : 'mapping', entries };
}
