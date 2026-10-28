// SPDX-License-Identifier: Apache-2.0
import { MintAdoptionRefusedError, type MintOrAdoptOutcome } from './adopt-existing-mint.js';
import type { PublicationAcquisition } from './prepared-publication-acquisition.js';
import type { PreparedLocalPublication, PreparedPublicationContent, PreparedSealedGraphPublicationContent } from './prepared-publication.js';

export function requireSealedGraphRecording(content: PreparedPublicationContent): PreparedSealedGraphPublicationContent {
  const { target, seal } = content;
  const { graphPublish, publisherContextGraphId } = target;
  if (!graphPublish || !seal || publisherContextGraphId === undefined)
    throw new Error('Recording an existing mint requires a sealed graph-scoped publish');
  if (seal.reservedKaId !== graphPublish.expectedPackedKaId)
    throw new Error('Recording an existing mint requires the sealed reserved KA id');
  return { ...content, seal, reservedKaId: seal.reservedKaId,
    target: { ...target, graphPublish, publisherContextGraphId } };
}
export type ConfirmedPublicationRecording =
  | { kind: 'sealed-graph'; content: PreparedSealedGraphPublicationContent; acquisition: PublicationAcquisition }
  | { kind: 'live'; content: PreparedPublicationContent;
      acquisition: PublicationAcquisition & { outcome: MintOrAdoptOutcome & { adopted: false } } };
export type PublicationRecording = ConfirmedPublicationRecording
  | { kind: 'local'; content: PreparedPublicationContent; acquisition: PreparedLocalPublication };

/** Pair the receipt with its required reservation before handing it to the recorder. */
export function bindConfirmedPublication(content: PreparedPublicationContent, acquisition: PublicationAcquisition): ConfirmedPublicationRecording {
  if (content.target.graphPublish && content.seal) {
    return bindSealedGraphPublication(requireSealedGraphRecording(content), acquisition);
  }
  if (acquisition.outcome.adopted) throw new Error('Adopted mint recording requires a graph-scoped reservation');
  return { kind: 'live', content, acquisition: { ...acquisition, outcome: { ...acquisition.outcome, adopted: false } } };
}

export function bindSealedGraphPublication(content: PreparedSealedGraphPublicationContent,
  acquisition: PublicationAcquisition): Extract<ConfirmedPublicationRecording, { kind: 'sealed-graph' }> {
  if (acquisition.outcome.adopted && BigInt(content.target.graphPublish.scope.assertionVersion) !== 1n)
    throw new MintAdoptionRefusedError('assertion-version-mismatch', content.reservedKaId, 'A mint receipt proves only initial assertion version 1');
  return { kind: 'sealed-graph', content, acquisition };
}
