// SPDX-License-Identifier: Apache-2.0

/**
 * Curator snapshots this node refused for the registration they name.
 *
 * A curator metadata refresh answers every caller that shares its fetch with
 * one boolean, so a fetch that failed and a snapshot the node refused on
 * purpose look the same. A caller that retries failed refreshes watches its
 * own attempt here: a refusal counted while the attempt ran is not worth
 * fetching again, and a failure with no refusal counted was the transport.
 */

/** Refusals so far, per agent, by graph and curator peer. A count only grows. */
const refusalCountsByAgent = new WeakMap<object, Map<string, number>>();

const refusalKey = (contextGraphId: string, curatorPeerId: string): string => (
  `${contextGraphId}\u0000${curatorPeerId}`
);

const refusalCount = (agent: object, key: string): number => (
  refusalCountsByAgent.get(agent)?.get(key) ?? 0
);

/**
 * Count a snapshot served by `curatorPeerId` that was refused because it
 * names another registration than the one the local row owns.
 */
export function noteCuratorRegistrationRefusal(
  agent: object,
  contextGraphId: string,
  curatorPeerId: string,
): void {
  const key = refusalKey(contextGraphId, curatorPeerId);
  let counts = refusalCountsByAgent.get(agent);
  if (!counts) refusalCountsByAgent.set(agent, counts = new Map());
  counts.set(key, refusalCount(agent, key) + 1);
}

/**
 * Start watching one attempt. The returned check answers whether a snapshot
 * of this curator was refused for its registration since the watch began; an
 * earlier refusal, or a fetch that failed, never makes it true.
 */
export function watchCuratorRegistrationRefusal(
  agent: object,
  contextGraphId: string,
  curatorPeerId: string,
): () => boolean {
  const key = refusalKey(contextGraphId, curatorPeerId);
  const before = refusalCount(agent, key);
  return () => refusalCount(agent, key) > before;
}
