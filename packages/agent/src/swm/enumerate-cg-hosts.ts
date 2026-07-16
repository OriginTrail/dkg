/**
 * OT-RFC-38 LU-6 (minimal) — CG hosting-peer enumeration.
 *
 * Distinct from `enumerate-cg-members` (which returns peers eligible
 * to *decrypt* the CG content):
 *
 *   - **members** receive a copy of the chain key and can decrypt
 *     curated CG payloads. Resolved via the CG allowlist or topic
 *     subscribers.
 *   - **hosts** receive the ciphertext (curated) or plaintext (public)
 *     bytes and store them on behalf of the network, without the
 *     ability to decrypt. Per SPEC_CG_HOSTING_MEMBERSHIP §3, hosting
 *     and membership are orthogonal node roles.
 *
 * Phase A simplification (per RFC §4.6): the sharding table is single-
 * shard — every sharding-table member hosts every CG. The on-chain
 * `nodeId` field is a random 32-byte token, not a libp2p PeerID, so the
 * Phase A enumerator does NOT consult chain state directly. It instead
 * returns the currently-connected libp2p peers — they are the dialable
 * candidates the LU-7 catchup protocol will try in turn, with each peer
 * able to decline if it doesn't actually hold the CG (e.g. because it's
 * an edge node, not a core).
 *
 * Future shard-aware enumeration (Phase B) will:
 *   1. Maintain a local (identityId → peerId) map from observed peer
 *      announcements (libp2p identify protocol carries peer addrs, and
 *      `getPeerDiagnostics()` already surfaces a peer's identityId).
 *   2. Cross-reference against `ShardingTable.getShardingTable()` to
 *      filter to actual sharding-table members.
 *   3. Apply the per-CG sharding function once shards >1 ship.
 *
 * Cache-free by design: callers (LU-7 catchup) invoke this on each
 * SWMCatchupRequest send, so the result must reflect the current
 * connection state. `getConnectedPeers()` is already an in-memory
 * libp2p lookup; no I/O budget to amortise.
 */

export interface CGHostEnumeratorDeps {
  /**
   * Returns the currently-connected libp2p peer IDs (strings in the
   * canonical base58/base32 multiaddr form). Self is included or not
   * depending on the caller's wiring; this enumerator strips self
   * regardless.
   */
  getConnectedPeers: () => string[];
  /** Lazy accessor for our own peer ID (excluded from results). */
  getSelfPeerId: () => string;
}

export interface CGHostEnumerator {
  /**
   * Resolve the candidate hosting-peer set for {@link cgId}. Returns
   * all currently-connected peers (minus self) in Phase A; Phase B
   * will filter to the sharding-table-eligible subset for the CG.
   *
   * Non-async because the underlying source (libp2p connections list)
   * is in-memory; kept as a Promise-returning signature anyway so
   * Phase B can layer a chain query in without breaking callers.
   */
  enumerate(cgId: string): Promise<string[]>;
}

export function createCGHostEnumerator(deps: CGHostEnumeratorDeps): CGHostEnumerator {
  return {
    async enumerate(_cgId: string): Promise<string[]> {
      const self = deps.getSelfPeerId();
      const seen = new Set<string>();
      const out: string[] = [];
      for (const peer of deps.getConnectedPeers()) {
        if (peer === self) continue;
        if (seen.has(peer)) continue;
        seen.add(peer);
        out.push(peer);
      }
      return out;
    },
  };
}
