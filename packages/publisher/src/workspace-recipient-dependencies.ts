// SPDX-License-Identifier: Apache-2.0

import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';

/**
 * The facts read by workspace recipient resolution. Query construction and
 * mutation fences share this contract; a new lookup predicate must be added
 * here so its writes invalidate an in-flight recipient snapshot too.
 * Revocations are dependencies even when positive key evidence is scoped.
 */
export const WORKSPACE_RECIPIENT_DEPENDENCIES = Object.freeze({
  keyRoute: Object.freeze({
    publicKey: DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
    algorithm: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
    proof: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
    peerId: DKG_ONTOLOGY.DKG_PEER_ID,
    revokedAt: DKG_ONTOLOGY.DKG_REVOKED_AT,
    revokedBy: DKG_ONTOLOGY.DKG_REVOKED_BY,
    revocationProof: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF,
  }),
  access: Object.freeze({
    policy: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
    allowedAgent: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
    participantAgent: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
    revokedAgent: DKG_ONTOLOGY.DKG_REVOKED_AGENT,
  }),
});

export const WORKSPACE_RECIPIENT_KEY_ROUTE_PREDICATES: readonly string[] = Object.freeze(
  Object.values(WORKSPACE_RECIPIENT_DEPENDENCIES.keyRoute),
);

export const WORKSPACE_RECIPIENT_AUTHORITY_PREDICATES: readonly string[] = Object.freeze([
  ...Object.values(WORKSPACE_RECIPIENT_DEPENDENCIES.access),
  ...WORKSPACE_RECIPIENT_KEY_ROUTE_PREDICATES,
]);
