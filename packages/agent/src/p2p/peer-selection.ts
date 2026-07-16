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

  const tierOf = (peer: { toString(): string }): number => {
    const id = peer.toString();
    if (preferredPeerId && id === preferredPeerId) return 0;
    if (hasCores && corePeerIds!.has(id)) return 1;
    return 2;
  };

  return peers
    .map((peer, index) => ({ peer, index, tier: tierOf(peer) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.peer);
}
