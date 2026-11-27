/**
 * Order connected peers for a catch-up round.
 *
 * Tiered, stable ordering:
 *   1. the preferred peer (typically the CG curator), if present;
 *   2. known Core nodes (always-on, staked, advertise `PROTOCOL_STORAGE_ACK`)
 *      — reliable hosts we want to reach first;
 *   3. everyone else.
 *
 * The order is stable within each tier so callers keep deterministic
 * behaviour. Catch-up contacts every connected peer regardless of order,
 * so this changes which peers are *reached first* (faster time-to-first-
 * data, and reliable Cores ahead of flaky edges), not which are reached.
 *
 * `privateOnly` is retained for signature/back-compat with existing
 * callers. It does not act as a privacy gate (catch-up already contacts
 * all connected peers for every CG); it is kept so the curator-first
 * intent stays explicit at the call sites.
 */
export function orderCatchupPeers(
  peers: Array<{ toString(): string }>,
  preferredPeerId?: string,
  privateOnly = false,
  corePeerIds?: ReadonlySet<string>,
): Array<{ toString(): string }> {
  void privateOnly;
  const hasCores = !!corePeerIds && corePeerIds.size > 0;
  if (!preferredPeerId && !hasCores) return peers;

  const byRole = hasCores
    ? orderCoresFirst(peers, (peer) => corePeerIds!.has(peer.toString()))
    : peers;
  if (!preferredPeerId) return byRole;
  const isPreferred = (peer: { toString(): string }) => peer.toString() === preferredPeerId;
  return [...byRole.filter(isPreferred), ...byRole.filter((peer) => !isPreferred(peer))];
}

/**
 * Stable Cores-first order: the items `isCore` accepts, then the rest, each
 * group in input order. Every Cores-first choice uses this one rule. Callers
 * differ only in how they know a peer is a Core: `knownCorePeerIds` (from
 * identify) for a connected peer, the profile's `nodeRole` for one that is
 * not connected yet.
 */
export function orderCoresFirst<T>(items: readonly T[], isCore: (item: T) => boolean): T[] {
  const cores: T[] = [];
  const rest: T[] = [];
  for (const item of items) (isCore(item) ? cores : rest).push(item);
  return [...cores, ...rest];
}
