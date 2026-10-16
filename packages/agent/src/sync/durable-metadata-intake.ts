import type { Quad } from '@origintrail-official/dkg-storage';
import { isIriMetaSubject } from './iri-term.js';

/** Local routing attestations are receiver-owned, never peer-admissible. */
const RECEIVER_OWNED_META_PREDICATES: ReadonlySet<string> = new Set([
  'http://dkg.io/ontology/authenticatedSubGraphName',
]);

/**
 * One intake boundary for peer-supplied durable metadata.
 *
 * Verification consumes only IRI-subject rows. Admission retains indexes into
 * the caller's original array so selected rows can be persisted without a
 * positional remap, while the rejected-row count advances the wire cursor.
 */
export interface PreparedDurableMeta {
  readonly originalMetaQuads: readonly Quad[];
  readonly verificationView: readonly Quad[];
  readonly admissibleOriginalIndexes: readonly number[];
  readonly droppedNonIriSubjectTriples: number;
  readonly droppedReceiverOwnedTriples: number;
}

export function prepareDurableMeta(metaQuads: readonly Quad[]): PreparedDurableMeta {
  const verificationView: Quad[] = [];
  const admissibleOriginalIndexes: number[] = [];
  let droppedNonIriSubjectTriples = 0;
  let droppedReceiverOwnedTriples = 0;
  for (let index = 0; index < metaQuads.length; index++) {
    const quad = metaQuads[index]!;
    if (!isIriMetaSubject(quad.subject)) {
      droppedNonIriSubjectTriples += 1;
      continue;
    }
    if (RECEIVER_OWNED_META_PREDICATES.has(quad.predicate)) {
      droppedReceiverOwnedTriples += 1;
      continue;
    }
    verificationView.push(quad);
    admissibleOriginalIndexes.push(index);
  }
  return {
    originalMetaQuads: metaQuads,
    verificationView,
    admissibleOriginalIndexes,
    droppedNonIriSubjectTriples,
    droppedReceiverOwnedTriples,
  };
}

