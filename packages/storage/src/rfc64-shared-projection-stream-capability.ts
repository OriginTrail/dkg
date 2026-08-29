import type {
  Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';

export interface Rfc64SharedProjectionStreamCapabilityOptionsV1 {
  /** Gateway-derived minimum of signed, operator, and protocol ceilings. */
  readonly byteCeiling: number;
  readonly signal?: AbortSignal;
}

/**
 * Callable adapter contract for one exact, non-materialized KA projection.
 *
 * The capability owns exact-graph response validation and canonicalizes each
 * accepted triple exactly once. It yields owned, LF-terminated canonical line
 * bytes; the public gateway independently validates those same bytes against
 * the authenticated seal before exposing them.
 */
export interface Rfc64SharedProjectionStreamCapabilityV1 {
  rfc64SharedProjectionStreamV1(
    operation: Rfc64SharedProjectionStreamOperationV1,
    options: Rfc64SharedProjectionStreamCapabilityOptionsV1,
  ): Promise<AsyncIterable<Uint8Array>>;
}

export function isRfc64SharedProjectionStreamCapabilityV1(
  candidate: unknown,
): candidate is Rfc64SharedProjectionStreamCapabilityV1 {
  return candidate !== null
    && typeof candidate === 'object'
    && typeof (candidate as Partial<Rfc64SharedProjectionStreamCapabilityV1>)
      .rfc64SharedProjectionStreamV1 === 'function';
}
