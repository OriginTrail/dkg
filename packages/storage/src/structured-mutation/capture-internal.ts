import {
  absoluteIri,
  boundedString,
} from './primitives.js';

export interface StructuredMutationSemantics {
  readonly guardedGraphs: readonly string[];
  readonly touchedGraphs: readonly string[];
  readonly mightMutate: boolean;
}

export function captureInputRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function captureUniqueIris(
  value: unknown,
  label: string,
  max: number,
  allowEmpty: boolean,
): readonly string[] {
  const seen = new Set<string>();
  return captureArray(value, label, allowEmpty ? 0 : 1, max, (candidate, index) => {
    const iri = absoluteIri(candidate as string, `${label}[${index}]`);
    if (seen.has(iri)) throw new Error(`${label} contains duplicate IRI ${iri}`);
    seen.add(iri);
    return iri;
  });
}

export function captureUniqueStrings(
  value: unknown,
  label: string,
  max: number,
): readonly string[] {
  const seen = new Set<string>();
  return captureArray(value, label, 1, max, (candidate, index) => {
    const captured = boundedString(candidate as string, `${label}[${index}]`);
    if (seen.has(captured)) throw new Error(`${label} contains duplicate value ${captured}`);
    seen.add(captured);
    return captured;
  });
}

export function captureArray<T>(
  value: unknown,
  label: string,
  min: number,
  max: number,
  capture: (candidate: unknown, index: number) => T,
): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const length = value.length;
  if (length < min || length > max) {
    throw new Error(`${label} must contain ${min}..${max} values`);
  }
  const result = new Array<T>(length);
  for (let index = 0; index < length; index += 1) {
    if (!(index in value)) throw new Error(`${label} must be a dense array`);
    result[index] = capture(value[index], index);
  }
  return Object.freeze(result);
}
