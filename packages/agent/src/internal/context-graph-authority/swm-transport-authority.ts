// SPDX-License-Identifier: Apache-2.0

import type {
  RegisteredContextGraphAuthority,
  RegisteredContextGraphAuthorityUnavailable,
} from '../../registered-context-graph-authority.js';

/**
 * How SWM on one graph may travel. The sender's recipient selection and the
 * receiver's plaintext oracle both project their answer from this one
 * classification (#2827), so the two ends of the wire cannot disagree.
 *
 * - `plaintext`: public-readable SWM. The graph is registered public, or it is
 *   unregistered and its active accepted owner-signed policy is public.
 *   Approving a join writes an allowlist, but on a public graph that governs
 *   publish authority, not reads.
 * - `legacy-unregistered`: unregistered without such a policy. The local store
 *   roster decides, as it always has for local-only graphs.
 * - `private-roster`: registered private; encrypt to its current roster.
 * - `unavailable`: no authoritative answer, so fail closed.
 */
export type SwmTransportAuthority =
  | { readonly kind: 'plaintext' }
  | { readonly kind: 'legacy-unregistered' }
  | { readonly kind: 'private-roster'; readonly participantAgents: readonly string[] }
  | RegisteredContextGraphAuthorityUnavailable;

/**
 * Classify one registered-authority read. `activeAcceptedPublicPolicy` must be
 * the flag that granted that read its accepted-absence allowance, so an
 * `unregistered` answer is either exact finalized absence under an active
 * owner-signed public policy or the registry's own local-first answer for a
 * graph this node created. A registration the index shows always wins.
 */
export function classifySwmTransportAuthority(
  registered: RegisteredContextGraphAuthority,
  activeAcceptedPublicPolicy: boolean,
): SwmTransportAuthority {
  switch (registered.kind) {
    case 'public':
      return { kind: 'plaintext' };
    case 'unregistered':
      return activeAcceptedPublicPolicy ? { kind: 'plaintext' } : { kind: 'legacy-unregistered' };
    case 'private':
      return { kind: 'private-roster', participantAgents: registered.participantAgents };
    case 'unavailable':
      return registered;
  }
}
