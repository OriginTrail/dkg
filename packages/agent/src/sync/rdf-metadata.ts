import type { Quad } from '@origintrail-official/dkg-storage';
import { stripLiteral } from '../dkg-agent-utils.js';

/** Canonical low-level RDF metadata reads shared by sync descriptor parsers. */
export function distinctRdfObjects(
  rows: readonly Quad[],
  predicate: string,
  options?: { readonly stripLiterals?: boolean },
): string[] {
  const values = rows
    .filter((row) => row.predicate === predicate)
    .map((row) => options?.stripLiterals ? stripLiteral(row.object) : row.object);
  return [...new Set(values)];
}

export function requireRdfObject(
  rows: readonly Quad[],
  predicate: string,
  field: string,
): string {
  const values = distinctRdfObjects(rows, predicate);
  if (values.length !== 1) {
    throw new Error(`${values.length === 0 ? 'missing' : 'ambiguous'} ${field}`);
  }
  return values[0]!;
}

export function optionalRdfObject(
  rows: readonly Quad[],
  predicate: string,
  field: string,
): string | undefined {
  const values = distinctRdfObjects(rows, predicate);
  if (values.length > 1) throw new Error(`ambiguous ${field}`);
  return values[0];
}

export function requireRdfLiteral(
  rows: readonly Quad[],
  predicate: string,
  field: string,
): string {
  return stripLiteral(requireRdfObject(rows, predicate, field));
}

export function optionalRdfLiteral(
  rows: readonly Quad[],
  predicate: string,
  field: string,
): string | undefined {
  const value = optionalRdfObject(rows, predicate, field);
  return value === undefined ? undefined : stripLiteral(value);
}

export function requireRdfSafeInteger(
  rows: readonly Quad[],
  predicate: string,
  field: string,
): number {
  const raw = requireRdfLiteral(rows, predicate, field);
  if (!/^-?[0-9]+$/.test(raw)) throw new Error(`invalid ${field}`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`unsafe ${field}`);
  return parsed;
}

export function requireRdfPositiveIntegerString(
  rows: readonly Quad[],
  predicate: string,
  field: string,
): string {
  const raw = requireRdfLiteral(rows, predicate, field);
  if (!/^[0-9]+$/.test(raw)) throw new Error(`invalid ${field}`);
  const parsed = BigInt(raw);
  if (parsed < 1n) throw new Error(`${field} must be positive`);
  return parsed.toString();
}
