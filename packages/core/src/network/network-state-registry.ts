/**
 * NetworkStateRegistry — RFC 04 §3.3 / RFC 07 §3.1 step 3.
 *
 * In-memory index of multiaddrs keyed on peerId, populated by
 * PROTOCOL_SYNC delivery of `system-dkg-network` attestation KCs.
 * `PeerResolver` consults it as step 3 of the resolution order.
 *
 * **v1 stub.** Returns empty arrays from `lookup()` until RFC 04
 * Phase 2 (submitProofV2 + per-round attestation KCs) lands. The
 * interface is fixed so the future PR-4 of the RFC 07 rollout can
 * wire the real implementation in without touching consumers.
 *
 * Codex review feedback on PR #496 (round 4): `lookup` returns
 * `Promise<Address[]>` — not `Address[]`. The v1 stub is in-memory
 * and could be sync, but the real RFC 04 Phase 2 implementation may
 * consult a database, an SWM channel, or another async source.
 * Freezing the contract as sync now would either force the real
 * impl to block the event loop or require a public-API breaking
 * change in `@origintrail-official/dkg-core` later. Async from day
 * one keeps the upgrade path open without observable cost (the v1
 * stub returns a resolved promise instantly).
 */
import type { NodeIdentity, Address } from './network.js';

export interface NetworkStateRegistry {
  /**
   * Return the multiaddrs the network registry knows for `peerId`.
   * Empty array means "no record" — which is the entire population
   * today, because no attestation KCs are minted before RFC 04
   * Phase 2 lands.
   */
  lookup(peerId: NodeIdentity): Promise<Address[]>;
}

/**
 * Stub implementation. Always returns `[]`. Used during RFC 07
 * PRs 1-4; replaced by the real registry in the PR that wires
 * `system-dkg-network` syncs to in-memory state.
 */
export class StubNetworkStateRegistry implements NetworkStateRegistry {
  async lookup(_peerId: NodeIdentity): Promise<Address[]> {
    return [];
  }
}
