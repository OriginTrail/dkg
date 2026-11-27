// SPDX-License-Identifier: Apache-2.0

/**
 * Curator snapshots this node refused for the registration they name.
 *
 * A curator metadata refresh answers every caller that shares its fetch with
 * one boolean, so a fetch that failed and a snapshot the node refused on
 * purpose look the same. A caller that retries failed refreshes watches its
 * own attempt here: a refusal by a refresh that started while the attempt ran
 * is not worth fetching again, and a failure with no such refusal was the
 * transport. A refresh that was already running when the attempt began is an
 * earlier one, even when it ends while the attempt's own refresh waits for it.
 */

/** Refreshes of one graph from one curator peer. Both numbers only grow. */
interface CuratorRefreshes {
  /** Refreshes started so far; each is numbered by this count as it starts. */
  started: number;
  /** Number of the latest refresh whose snapshot was refused; 0 for none. */
  refused: number;
}

/** Refreshes per agent, by graph and curator peer. */
const refreshesByAgent = new WeakMap<object, Map<string, CuratorRefreshes>>();

const refusalKey = (contextGraphId: string, curatorPeerId: string): string => (
  `${contextGraphId}\u0000${curatorPeerId}`
);

function refreshesOf(agent: object, key: string): CuratorRefreshes {
  let byKey = refreshesByAgent.get(agent);
  if (!byKey) refreshesByAgent.set(agent, byKey = new Map());
  let refreshes = byKey.get(key);
  if (!refreshes) byKey.set(key, refreshes = { started: 0, refused: 0 });
  return refreshes;
}

/** Number a refresh of the snapshot `curatorPeerId` serves as it starts. */
export function noteCuratorMetaRefreshStarted(
  agent: object,
  contextGraphId: string,
  curatorPeerId: string,
): number {
  const refreshes = refreshesOf(agent, refusalKey(contextGraphId, curatorPeerId));
  refreshes.started += 1;
  return refreshes.started;
}

/**
 * Count a snapshot served by `curatorPeerId` to refresh number `refresh` that
 * was refused because it names another registration than the one the local
 * row owns.
 */
export function noteCuratorRegistrationRefusal(
  agent: object,
  contextGraphId: string,
  curatorPeerId: string,
  refresh: number,
): void {
  const refreshes = refreshesOf(agent, refusalKey(contextGraphId, curatorPeerId));
  refreshes.refused = Math.max(refreshes.refused, refresh);
}

/**
 * Start watching one attempt. The returned check answers whether a refresh of
 * this curator that started since the watch began had its snapshot refused
 * for its registration. Refreshes of a graph run one at a time, so the
 * attempt's own refresh starts after any that was running when it asked; a
 * refusal by such an earlier refresh, or a fetch that failed, never makes it
 * true.
 */
export function watchCuratorRegistrationRefusal(
  agent: object,
  contextGraphId: string,
  curatorPeerId: string,
): () => boolean {
  const refreshes = refreshesOf(agent, refusalKey(contextGraphId, curatorPeerId));
  const startedBefore = refreshes.started;
  return () => refreshes.refused > startedBefore;
}
