// SPDX-License-Identifier: Apache-2.0

/**
 * Tells a catalog policy decision that was answered from one that could not be made (GH#3081).
 *
 * The access-policy registry answers `null` for every denial, and has to: a transport fails
 * closed whatever the reason. Whoever reports on denials needs the reason all the same. A peer
 * that is not a member is an answer. A decision this node could not make, because it could not
 * establish its own principal for the graph or because a lookup failed, is not an answer, and a
 * node in that state would otherwise deliver to nobody without a word.
 *
 * A probe is an async-context side channel around one piece of work. It changes nothing any
 * lookup returns, and it exists only while {@link withRfc64CatalogPolicyProbeV1} runs: outside
 * one, the notes below do nothing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Rfc64CatalogAccessPolicyRegistryOptionsV1 } from './catalog-access-policy-v1.js';

/** What a probe learned about the policy decisions made while it ran. */
export interface Rfc64CatalogPolicyProbeV1 {
  /** A decision could not be made: a lookup it needed failed or came back empty-handed. */
  undecided: boolean;
}

const ACTIVE_PROBE_V1 = new AsyncLocalStorage<Rfc64CatalogPolicyProbeV1>();

/** Run `work` with `probe` observing the policy decisions made inside it. */
export function withRfc64CatalogPolicyProbeV1<T>(
  probe: Rfc64CatalogPolicyProbeV1,
  work: () => Promise<T>,
): Promise<T> {
  return ACTIVE_PROBE_V1.run(probe, work);
}

/** Record that the decision in progress could not be made. Does nothing outside a probe. */
export function noteRfc64CatalogPolicyUndecidedV1(): void {
  const probe = ACTIVE_PROBE_V1.getStore();
  if (probe !== undefined) probe.undecided = true;
}

/**
 * A `.catch` handler for a lookup whose failure its caller reads as "unknown": note that the
 * decision in progress could not be made, then answer `fallback` as before.
 */
export function rfc64CatalogLookupFailedAsV1<T>(fallback: T): () => T {
  return () => {
    noteRfc64CatalogPolicyUndecidedV1();
    return fallback;
  };
}

/** Run `decide`; a failure is noted as a decision that could not be made, and passed on. */
export async function notingRfc64CatalogPolicyFailureV1<T>(decide: () => T | Promise<T>): Promise<T> {
  try {
    return await decide();
  } catch (cause) {
    noteRfc64CatalogPolicyUndecidedV1();
    throw cause;
  }
}

/**
 * `authority` with its two identity lookups observed. This node's own principal coming back
 * unresolved, or either lookup failing, notes the decision in progress as one that could not be
 * made. What a lookup returns or fails with is passed through unchanged, and so is an authority
 * that is not well-formed: rejecting that stays the registry's job.
 */
export function observedRfc64CatalogAccessAuthorityV1(
  authority: Rfc64CatalogAccessPolicyRegistryOptionsV1 | undefined,
): Rfc64CatalogAccessPolicyRegistryOptionsV1 | undefined {
  if (authority === undefined || authority === null) return authority;
  const { resolveLocalAgentAddress, resolveRemoteAgentAddress } = authority;
  return {
    ...authority,
    ...(typeof resolveLocalAgentAddress === 'function' ? {
      resolveLocalAgentAddress: async (
        ...lookup: Parameters<typeof resolveLocalAgentAddress>
      ) => {
        const resolved = await notingRfc64CatalogPolicyFailureV1(
          () => resolveLocalAgentAddress(...lookup),
        );
        if (resolved === null) noteRfc64CatalogPolicyUndecidedV1();
        return resolved;
      },
    } : {}),
    ...(typeof resolveRemoteAgentAddress === 'function' ? {
      resolveRemoteAgentAddress: (
        ...lookup: Parameters<typeof resolveRemoteAgentAddress>
      ) => notingRfc64CatalogPolicyFailureV1(() => resolveRemoteAgentAddress(...lookup)),
    } : {}),
  } as Rfc64CatalogAccessPolicyRegistryOptionsV1;
}
