// SPDX-License-Identifier: Apache-2.0

import { quadsToNQuads, type Quad } from '@origintrail-official/dkg-storage';

const UTF8_ENCODER = new TextEncoder();

export interface CanonicalPublicationPayloadMeasurement {
  /** Canonical public document used by ACKs and storage. */
  readonly publicNQuads: string;
  /** Canonical public document encoded as UTF-8 for ACK transport. */
  readonly publicBytes: Uint8Array;
  /** UTF-8 size of the canonical public document. */
  readonly publicByteSize: bigint;
  /** UTF-8 size of the canonical public-plus-private document. */
  readonly fullContentByteSize: bigint;
}

function scopeGraphlessQuads(
  quads: readonly Quad[],
  fallbackGraph: string,
): Quad[] {
  return quads.map((quad) => (
    quad.graph ? quad : { ...quad, graph: fallbackGraph }
  ));
}

/**
 * Measure the publisher-owned canonical RDF payload once. This helper owns
 * graph scoping, canonical N-Quads serialization, and UTF-8 byte accounting;
 * pricing policy selection consumes only its precomputed quantities.
 */
export function measureCanonicalPublicationPayload(input: {
  readonly publicQuads: readonly Quad[];
  /** Supply only when full-content pricing needs private-byte measurement. */
  readonly privateQuads?: readonly Quad[];
  readonly fallbackGraph: string;
}): CanonicalPublicationPayloadMeasurement {
  const publicQuads = scopeGraphlessQuads(input.publicQuads, input.fallbackGraph);
  const publicNQuads = quadsToNQuads(publicQuads);
  const publicBytes = UTF8_ENCODER.encode(publicNQuads);
  const privateNQuads = input.privateQuads && input.privateQuads.length > 0
    ? quadsToNQuads(scopeGraphlessQuads(input.privateQuads, input.fallbackGraph))
    : '';
  const privateByteSize = privateNQuads.length > 0
    ? UTF8_ENCODER.encode(privateNQuads).length
    : 0;
  const separatorByteSize = publicBytes.length > 0 && privateByteSize > 0 ? 1 : 0;

  return {
    publicNQuads,
    publicBytes,
    publicByteSize: BigInt(publicBytes.length),
    fullContentByteSize: BigInt(
      publicBytes.length + separatorByteSize + privateByteSize,
    ),
  };
}
