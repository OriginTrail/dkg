import { assertValidMaxResponseBytes, StoreResponseTooLargeError } from './http-response-limit.js';

/** Bound the complete catalog before a prefix filter can hide a large read. */
export function assertGraphCatalogWithinResponseLimit(
  graphs: readonly string[],
  maxBytes: number | undefined,
): void {
  if (maxBytes === undefined) return;
  assertValidMaxResponseBytes(maxBytes);
  let bytes = 2; // JSON array brackets, including for an empty catalog.
  for (let index = 0; index < graphs.length; index += 1) {
    bytes += (index === 0 ? 0 : 1) + Buffer.byteLength(JSON.stringify(graphs[index]), 'utf8');
    if (bytes > maxBytes) throw new StoreResponseTooLargeError(maxBytes, bytes);
  }
  if (bytes > maxBytes) throw new StoreResponseTooLargeError(maxBytes, bytes);
}
