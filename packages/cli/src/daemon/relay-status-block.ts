/**
 * Build the `relay` block of the `/api/status` response.
 *
 * Extracted to its own pure function so the response shape can be unit-tested
 * without standing up a full daemon. Same shape for edge and core: consumers
 * (Datadog, Prometheus, the node-ui dashboard) parse one schema and switch on
 * `isCore` rather than on the presence/absence of fields.
 *
 * Inputs are deliberately structural rather than `agent`/`config` references
 * so the function has no transitive imports — the test file pulls in nothing
 * heavier than this module.
 */

/** Shape from `DKGNode.getRelayStats()` (subset we surface in /api/status). */
export interface RelayStatsSubset {
  capacity: number;
  reservationCount: number;
  activeCircuits: number;
  bytesIn: bigint;
  bytesOut: bigint;
}

export interface BuildRelayStatusBlockOpts {
  /** `nodeRole === 'core'`. Determines whether `relayStats` is non-null + which fields populate. */
  isCore: boolean;
  /**
   * Result of `agent.node.getRelayStats()`. Null on edge nodes (no relay
   * server running) and also null if the relay server hasn't fully
   * initialised yet (race during the first few hundred ms of boot).
   */
  relayStats: RelayStatsSubset | null;
  /**
   * Best-known NAT status from `daemonState.natStatus`. Defaults to
   * `'unknown'` until a future AutoNAT-driven boot self-probe populates it
   * with `'public'` or `'private'`. Operators alerting on
   * `isCore && natStatus === 'private'` get a true-positive signal once
   * that hook lands; today it's a defensive default.
   */
  natStatus: 'public' | 'private' | 'unknown';
  /**
   * Runtime-advertised multiaddrs from `libp2p.getMultiaddrs()`. This can
   * include relay circuit and announced addresses, so it is intentionally not
   * exposed as the bound listen socket set.
   */
  advertisedAddresses: string[];
  /**
   * Operator-configured `announceAddresses` (from DkgConfig). Multiaddrs the
   * daemon advertises to peers when its local interface IP isn't the
   * public-routable one (VPS / cloud / NAT64 cases).
   */
  configuredAnnounceAddresses: string[];
}

/**
 * Response-block shape. Documented here so consumers can import the type
 * directly rather than redeclaring it on the client side.
 */
export interface RelayStatusBlock {
  isCore: boolean;
  /**
   * Reservations currently held by this Core's relay server. Edge nodes
   * don't run a relay server → always `0`. Cap is `reservationCapacity`.
   */
  reservationsHeld: number;
  /**
   * Operator-configured `maxReservations`. Null on edge. Alert when
   * `reservationsHeld === reservationCapacity` (Core at saturation).
   */
  reservationCapacity: number | null;
  /**
   * Currently-active forwarded circuits (one per open STOP stream). Null on
   * edge. Counts circuits in flight RIGHT NOW; not a lifetime total.
   */
  activeCircuits: number | null;
  /**
   * Total bytes received on HOP+STOP relay-server streams since the relay
   * started. Stringified BigInt — `JSON.stringify` throws on raw bigint and
   * `Number(b)` silently truncates past 2^53, which a busy long-uptime
   * Core can reach in a few weeks. Null on edge.
   */
  bytesIn: string | null;
  /** Counterpart to `bytesIn` for departing bytes. */
  bytesOut: string | null;
  natStatus: 'public' | 'private' | 'unknown';
  advertisedAddresses: string[];
  configuredAnnounceAddresses: string[];
}

export function buildRelayStatusBlock(opts: BuildRelayStatusBlockOpts): RelayStatusBlock {
  const { isCore, relayStats, natStatus, advertisedAddresses, configuredAnnounceAddresses } = opts;
  return {
    isCore,
    reservationsHeld: relayStats?.reservationCount ?? 0,
    reservationCapacity: relayStats?.capacity ?? null,
    activeCircuits: relayStats?.activeCircuits ?? null,
    bytesIn: relayStats ? relayStats.bytesIn.toString() : null,
    bytesOut: relayStats ? relayStats.bytesOut.toString() : null,
    natStatus,
    advertisedAddresses,
    configuredAnnounceAddresses,
  };
}
