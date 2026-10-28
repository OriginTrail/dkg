import type { QueryResult, SelectResult, ConstructResult, Quad as DKGQuad } from '../triple-store.js';
import { StoreResponseTooLargeError } from '../http-response-limit.js';

export function assertJsonResponseWithinLimit(value: unknown, maxBytes: number | undefined): void {
  if (maxBytes === undefined) return;
  const actualBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (actualBytes > maxBytes) throw new StoreResponseTooLargeError(maxBytes, actualBytes);
}

/**
 * Build one typed JSON-array result without retaining an unbounded second copy
 * of the native Oxigraph result. The same builder owns the returned envelope
 * and the fixed overhead used by exact byte accounting.
 */
export function mapBoundedQueryArray<T, U, R extends QueryResult>(
  values: T[],
  map: (value: T) => U,
  buildResult: (mapped: U[]) => R,
  maxBytes: number | undefined,
): R {
  if (maxBytes === undefined) return buildResult(values.map(map));
  const mapped: U[] = [];
  // The empty result contains the same array brackets as the final result.
  // Replacing [] with [row,...] adds only each row plus its separators.
  let actualBytes = Buffer.byteLength(JSON.stringify(buildResult(mapped)), 'utf8');
  if (actualBytes > maxBytes) throw new StoreResponseTooLargeError(maxBytes, actualBytes);
  for (const value of values) {
    const next = map(value);
    actualBytes += (mapped.length === 0 ? 0 : 1)
      + Buffer.byteLength(JSON.stringify(next), 'utf8');
    if (actualBytes > maxBytes) throw new StoreResponseTooLargeError(maxBytes, actualBytes);
    mapped.push(next);
  }
  return buildResult(mapped);
}

export function buildSelectResult(bindings: Array<Record<string, string>>): SelectResult {
  return { type: 'bindings', bindings };
}

export function buildConstructResult(quads: DKGQuad[]): ConstructResult {
  return { type: 'quads', quads };
}
