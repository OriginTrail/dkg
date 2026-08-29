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
 * clause reads one named graph. A certified adapter MUST accept only graphless
 * output or output already tagged with `operation.graphIri`, reject every
 * other named graph, and attach the internally derived `operation.graphIri`
 * before yielding. The gateway therefore never trusts a response-supplied
 * graph identity and can still enforce the exact authenticated graph contract.
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
