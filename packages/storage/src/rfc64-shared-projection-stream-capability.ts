import type {
  Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';

import type {
  Quad,
  Rfc64SharedProjectionStreamCapabilityOptionsV1,
  TripleStore,
} from './triple-store.js';

export type { Rfc64SharedProjectionStreamCapabilityOptionsV1 } from './triple-store.js';

/**
 * Callable adapter contract for one exact, non-materialized KA projection.
 *
 * SPARQL CONSTRUCT normally returns graphless triples even when its WHERE
 * clause reads one named graph. Capabilities may therefore yield graphless
 * quads or quads tagged with `operation.graphIri`. The public gateway owns the
 * one canonical normalization rule: it attaches the authenticated graph to
 * graphless results and rejects every foreign named graph.
 */
export interface Rfc64SharedProjectionStreamCapabilityV1
  extends Pick<TripleStore,
    'rfc64SharedProjectionStreamCertifiedV1' | 'rfc64SharedProjectionStreamV1'> {
  readonly rfc64SharedProjectionStreamCertifiedV1: true;
  rfc64SharedProjectionStreamV1(
    operation: Rfc64SharedProjectionStreamOperationV1,
    options: Rfc64SharedProjectionStreamCapabilityOptionsV1,
  ): Promise<AsyncIterable<Quad>>;
}

export function isRfc64SharedProjectionStreamCapabilityV1(
  candidate: unknown,
): candidate is Rfc64SharedProjectionStreamCapabilityV1 {
  return hasDataValue(candidate, 'rfc64SharedProjectionStreamCertifiedV1', true)
    && hasDataMethod(candidate, 'rfc64SharedProjectionStreamV1');
}

function hasDataValue(candidate: unknown, key: string, expected: unknown): boolean {
  const descriptor = findDataDescriptor(candidate, key);
  return descriptor !== null && descriptor.value === expected;
}

function hasDataMethod(candidate: unknown, key: string): boolean {
  const descriptor = findDataDescriptor(candidate, key);
  return descriptor !== null && typeof descriptor.value === 'function';
}

function findDataDescriptor(candidate: unknown, key: string): PropertyDescriptor | null {
  if (candidate === null || typeof candidate !== 'object') return null;
  let current: object | null = candidate;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor
        : null;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return null;
}
