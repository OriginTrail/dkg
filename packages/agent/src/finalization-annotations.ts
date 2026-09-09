const DKG = 'http://dkg.io/ontology/';

/** Agent-local cache annotations; they are not publisher protocol metadata. */
export const SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE = `${DKG}snapshotMerkleRoot`;
export const SWM_SNAPSHOT_CONTENT_DIGEST_PREDICATE = `${DKG}snapshotContentDigest`;

export const SWM_FINALIZATION_ANNOTATION_PREDICATES: ReadonlySet<string> =
  new Set([
    SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE,
    SWM_SNAPSHOT_CONTENT_DIGEST_PREDICATE,
  ]);
