import type {
  Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';

declare const RFC64_CANONICAL_PROJECTION_LINE_BRAND_V1: unique symbol;

/**
 * One canonical V10 triple line including its single terminal LF. Certified
 * adapters mint this only after exact-graph validation and canonicalization.
 */
export type Rfc64CanonicalProjectionLineV1 = Uint8Array & {
  readonly [RFC64_CANONICAL_PROJECTION_LINE_BRAND_V1]: true;
};

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
  ): Promise<AsyncIterable<Rfc64CanonicalProjectionLineV1>>;
}

export function isRfc64SharedProjectionStreamCapabilityV1(
  candidate: unknown,
): candidate is Rfc64SharedProjectionStreamCapabilityV1 {
  return candidate !== null
    && typeof candidate === 'object'
    && typeof (candidate as Partial<Rfc64SharedProjectionStreamCapabilityV1>)
      .rfc64SharedProjectionStreamV1 === 'function';
}
