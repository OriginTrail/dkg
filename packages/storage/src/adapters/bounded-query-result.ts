import type { SelectResult, ConstructResult, Quad as DKGQuad } from '../triple-store.js';
import { StoreResponseTooLargeError } from '../http-response-limit.js';

export function assertJsonResponseWithinLimit(value: unknown, maxBytes: number | undefined): void {
  if (maxBytes === undefined) return;
  const actualBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (actualBytes > maxBytes) throw new StoreResponseTooLargeError(maxBytes, actualBytes);
}

/** Normalize only until the next row would exceed the fixed result envelope. */
function appendBoundedRows<T, U>(
  values: T[], map: (value: T) => U, mapped: U[],
  emptyEnvelopeBytes: number, maxBytes: number | undefined,
): void {
  let actualBytes = emptyEnvelopeBytes;
  if (maxBytes !== undefined && actualBytes > maxBytes) throw new StoreResponseTooLargeError(maxBytes, actualBytes);
  for (const value of values) {
    const next = map(value);
    if (maxBytes !== undefined) {
      actualBytes += (mapped.length === 0 ? 0 : 1) + Buffer.byteLength(JSON.stringify(next), 'utf8');
      if (actualBytes > maxBytes) throw new StoreResponseTooLargeError(maxBytes, actualBytes);
    }
    mapped.push(next);
  }
}

/** Own both the SELECT envelope and its one incrementally normalized array. */
export function mapBoundedSelectResult<T>(
  values: T[], map: (value: T) => Record<string, string>, maxBytes: number | undefined,
): SelectResult {
  const result: SelectResult = { type: 'bindings', bindings: [] };
  appendBoundedRows(values, map, result.bindings, Buffer.byteLength(JSON.stringify(result), 'utf8'), maxBytes);
  return result;
}

/** Own both the CONSTRUCT envelope and its one incrementally normalized array. */
export function mapBoundedConstructResult<T>(
  values: T[], map: (value: T) => DKGQuad, maxBytes: number | undefined,
): ConstructResult {
  const result: ConstructResult = { type: 'quads', quads: [] };
  appendBoundedRows(values, map, result.quads, Buffer.byteLength(JSON.stringify(result), 'utf8'), maxBytes);
  return result;
}
