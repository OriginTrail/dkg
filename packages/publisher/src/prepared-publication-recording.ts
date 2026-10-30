// SPDX-License-Identifier: Apache-2.0
import { MintAdoptionRefusedError } from './adopt-existing-mint.js';
import type { PublicationAcquisition } from './prepared-publication-acquisition.js';
import type { PreparedLocalPublication, PreparedPublicationContent, PreparedSealedGraphPublicationContent } from './prepared-publication.js';

/** Adoption requires the reservation whose receipt will be revalidated under the write lock. */
export function requireSealedGraphRecording(content: PreparedPublicationContent): PreparedSealedGraphPublicationContent {
  const { target, seal } = content;
  const { graphPublish, publisherContextGraphId } = target;
  if (!graphPublish || !seal || publisherContextGraphId === undefined)
    throw new Error('Recording an existing mint requires a sealed graph-scoped publish');
  if (seal.reservedKaId !== graphPublish.expectedPackedKaId)
    throw new Error('Recording an existing mint requires the sealed reserved KA id');
  if (BigInt(graphPublish.scope.assertionVersion) !== 1n)
    throw new MintAdoptionRefusedError('assertion-version-mismatch', seal.reservedKaId, 'A mint receipt proves only initial assertion version 1');
  return { ...content, seal, reservedKaId: seal.reservedKaId,
    target: { ...target, graphPublish, publisherContextGraphId } };
}

/** Execution source is the only discriminant; content shape is a separate requirement. */
export type ConfirmedPublicationRecording =
  | (Extract<PublicationAcquisition, { kind: 'adopted' }> & { content: PreparedSealedGraphPublicationContent })
  | (Extract<PublicationAcquisition, { kind: 'live' }> & { content: PreparedPublicationContent });
export type PublicationRecording = ConfirmedPublicationRecording
  | (PreparedLocalPublication & { content: PreparedPublicationContent });
