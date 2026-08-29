import type {
  Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';

import type { Quad } from './triple-store.js';

export interface Rfc64SharedProjectionStreamCapabilityOptionsV1 {
  /** Gateway-derived minimum of signed, operator, and protocol ceilings. */
  readonly byteCeiling: number;
  readonly signal?: AbortSignal;
}

/**
 * Callable adapter contract for one exact, non-materialized KA projection.
 *
 * SPARQL CONSTRUCT normally returns graphless triples even when its WHERE
 * clause reads one named graph. Capabilities may therefore yield graphless
 * quads or quads tagged with `operation.graphIri`. The public gateway owns the
 * one canonical normalization rule: it attaches the authenticated graph to
 * graphless results and rejects every foreign named graph.
 */
export interface Rfc64SharedProjectionStreamCapabilityV1 {
  rfc64SharedProjectionStreamV1(
    operation: Rfc64SharedProjectionStreamOperationV1,
    options: Rfc64SharedProjectionStreamCapabilityOptionsV1,
  ): Promise<AsyncIterable<Quad>>;
}

export function isRfc64SharedProjectionStreamCapabilityV1(
  candidate: unknown,
): candidate is Rfc64SharedProjectionStreamCapabilityV1 {
  return candidate !== null
    && typeof candidate === 'object'
    && typeof (candidate as Partial<Rfc64SharedProjectionStreamCapabilityV1>)
      .rfc64SharedProjectionStreamV1 === 'function';
}
