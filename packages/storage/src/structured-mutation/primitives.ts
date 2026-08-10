import { isSafeIri } from '@origintrail-official/dkg-core';
import { formatRdfObjectTerm } from '../rdf-term-format.js';

export const BOUNDED_MUTATION_MAX_IRIS = 100_000;
export const BOUNDED_MUTATION_MAX_PRUNE_DELETE = 10_000;
export const BOUNDED_MUTATION_MAX_OPERAND_BYTES = 4 * 1024 * 1024;
export const BOUNDED_MUTATION_MAX_UPDATE_BYTES = 4 * 1024 * 1024;
export const BOUNDED_MUTATION_MAX_SOURCE_GRAPHS = 8;
export const BOUNDED_MUTATION_MAX_PREDICATES = 64;
export const BOUNDED_MUTATION_MAX_PREFIXES = 64;

const UTF8 = new TextEncoder();

export class BoundedMutationBudgetError extends Error {}

export function boundedInteger(value: number, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} must be an integer in 0..${max}`);
  }
  return value;
}

export function boundedString(value: string, label: string, maxBytes = 512): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (UTF8.encode(value).byteLength > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

export function absoluteIri(value: string, label: string): string {
  if (typeof value !== 'string' || !isSafeIri(value)) {
    throw new Error(`${label} must be an absolute IRI`);
  }
  return value;
}

export function normalizeStructuredRdfObject(value: string, label: string): string {
  try {
    return formatRdfObjectTerm(value, label, absoluteIri);
  } catch {
    throw new Error(`${label} must be a safe RDF literal or absolute IRI`);
  }
}

export function uniqueIris(
  values: readonly string[],
  label: string,
  max = BOUNDED_MUTATION_MAX_IRIS,
  allowEmpty = false,
): string[] {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || values.length > max) {
    throw new Error(`${label} must contain ${allowEmpty ? '0' : '1'}..${max} IRIs`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < values.length; index++) {
    if (!(index in values)) throw new Error(`${label} must be a dense array`);
    const iri = absoluteIri(values[index], `${label}[${index}]`);
    if (seen.has(iri)) throw new Error(`${label} contains duplicate IRI ${iri}`);
    seen.add(iri);
    result.push(iri);
  }
  return result;
}

export function boundedUniqueStrings(
  values: readonly string[],
  label: string,
  max: number,
): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > max) {
    throw new Error(`${label} must contain 1..${max} values`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < values.length; index++) {
    if (!(index in values)) throw new Error(`${label} must be a dense array`);
    const value = boundedString(values[index], `${label}[${index}]`);
    if (seen.has(value)) throw new Error(`${label} contains duplicate value ${value}`);
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function assertOperandBudget(label: string, values: Iterable<string>): void {
  let bytes = 0;
  for (const value of values) {
    bytes += UTF8.encode(value).byteLength;
    if (bytes > BOUNDED_MUTATION_MAX_OPERAND_BYTES) {
      throw new BoundedMutationBudgetError(
        `${label} exceeds ${BOUNDED_MUTATION_MAX_OPERAND_BYTES} operand bytes`,
      );
    }
  }
}

export function assertBoundedStructuredUpdate(label: string, update: string): string {
  const bytes = UTF8.encode(update).byteLength;
  if (bytes > BOUNDED_MUTATION_MAX_UPDATE_BYTES) {
    throw new BoundedMutationBudgetError(
      `${label} serialized update exceeds ${BOUNDED_MUTATION_MAX_UPDATE_BYTES} UTF-8 bytes`,
    );
  }
  return update;
}
