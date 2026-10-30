// SPDX-License-Identifier: Apache-2.0

import type { PreparedPublicationContent, PublicationPreparationPorts } from './prepared-publication.js';
import type { V10ACKMode } from './publisher.js';

type PublicationACKPlan = {
  networkVisibleByteSize: bigint;
} & (
  | { ackMode: Extract<V10ACKMode, { kind: 'curated-catalog' }>; stagingQuads: Uint8Array }
  | { ackMode: Extract<V10ACKMode, { kind: 'folded-private' }>; stagingQuads: Uint8Array | undefined }
  | { ackMode: Extract<V10ACKMode, { kind: 'public' }>; stagingQuads: Uint8Array | undefined }
);

/** Select wire content and its commitment once, independently of member encryption. */
export function planPublicationACK(
  input: PreparedPublicationContent,
  useEncryptedInline: boolean,
  selectPublicStagingQuads: PublicationPreparationPorts['selectPublicStagingQuads'],
): PublicationACKPlan {
  const payload = input.payload;
  if (useEncryptedInline && payload.catalogCommitment !== undefined) {
    return {
      networkVisibleByteSize: payload.catalogByteSize,
      stagingQuads: new TextEncoder().encode(payload.catalogNquadsStr),
      ackMode: {
        kind: 'curated-catalog',
        catalogCommitment: {
          catalogRoot: payload.catalogCommitment.root,
          catalogLeafCount: payload.catalogCommitment.leafCount,
        },
      },
    };
  }
  const wireContent = {
    networkVisibleByteSize: payload.payloadMeasurement.publicByteSize,
    stagingQuads: useEncryptedInline ? undefined
      : selectPublicStagingQuads(input.publicStagingMode, payload.payloadMeasurement.publicBytes),
  };
  if (payload.privateRoots.length > 0) {
    return { ...wireContent, ackMode: { kind: 'folded-private', privateMerkleRoots: payload.privateRoots } };
  }
  return { ...wireContent, ackMode: { kind: 'public' } };
}
