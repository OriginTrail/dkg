// SPDX-License-Identifier: Apache-2.0

import type { ApprovedMemberProof } from '../../context-graph-member-proof.js';
import type { SwmTransportAuthority } from './swm-transport-authority.js';

/**
 * The authenticated access policy an approved member is judged under, when it
 * accepts the curator's snapshot and when it completes its join. Each admits
 * exactly one definition carrying the member proof: `public` only the public
 * definition, `unproven` only the complete private one. A peer can then
 * neither downgrade a private graph by serving a public definition nor leave a
 * public graph stored as private, where the member's receiver would refuse
 * the plaintext its peers send.
 */
export type ApprovedMemberAccessPolicy = 'public' | 'unproven';

const constructionKey = Symbol('ApprovedMemberAcceptance');

/**
 * One approved member's proof together with the authenticated policy it is
 * judged under (#2827, #2831 review). A public acceptance is built only by
 * {@link resolveApprovedMemberAcceptanceDecision}, from the graph's SWM
 * transport authority; the constructor needs a key no other module holds.
 * The curator refresh and join completion both consume the same value, and
 * both ask {@link ApprovedMemberAcceptance.stillHolds} at their commit
 * boundaries: registration or catalog authority can change during the network
 * work between resolving an acceptance and installing or confirming metadata.
 */
export class ApprovedMemberAcceptance {
  readonly proof: Readonly<ApprovedMemberProof>;

  readonly accessPolicy: ApprovedMemberAccessPolicy;

  readonly #holds: () => Promise<boolean>;

  constructor(
    key: typeof constructionKey,
    proof: ApprovedMemberProof,
    accessPolicy: ApprovedMemberAccessPolicy,
    holds: () => Promise<boolean>,
  ) {
    if (key !== constructionKey) {
      throw new TypeError('ApprovedMemberAcceptance is built only by its authority resolver');
    }
    this.proof = Object.freeze({ ...proof });
    this.accessPolicy = accessPolicy;
    this.#holds = holds;
    Object.freeze(this);
  }

  /** Whether the authority behind this acceptance still holds right now. */
  stillHolds(): Promise<boolean> {
    return this.#holds();
  }
}

/**
 * An acceptance that admits only the complete private definition. It grants
 * nothing beyond that, so it always holds.
 */
export function unprovenApprovedMemberAcceptance(
  proof: ApprovedMemberProof,
): ApprovedMemberAcceptance {
  return new ApprovedMemberAcceptance(constructionKey, proof, 'unproven', async () => true);
}

/**
 * Resolve the acceptance for `proof`. It is public exactly while the graph's
 * SWM transport authority is plaintext: registered public, or unregistered
 * under an active accepted owner-signed public policy. A retained snapshot
 * therefore never outvotes a registration the index shows. Anything else,
 * including an unreadable authority, is unproven. A public acceptance reads
 * the same authority again whenever it is asked whether it still holds.
 */
export async function resolveApprovedMemberAcceptanceDecision(
  proof: ApprovedMemberProof,
  readTransportAuthority: () => Promise<SwmTransportAuthority>,
): Promise<ApprovedMemberAcceptance> {
  const isPublicNow = async (): Promise<boolean> => {
    try {
      return (await readTransportAuthority()).kind === 'plaintext';
    } catch {
      return false;
    }
  };
  return await isPublicNow()
    ? new ApprovedMemberAcceptance(constructionKey, proof, 'public', isPublicNow)
    : unprovenApprovedMemberAcceptance(proof);
}
