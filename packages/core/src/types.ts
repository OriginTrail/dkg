export interface PeerId {
  toString(): string;
  toBytes(): Uint8Array;
}

export interface ProtocolMessage {
  protocolId: string;
  data: Uint8Array;
}

export interface EventBus {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
}

export interface DKGNodeConfig {
  /** Multiaddr strings to listen on. Defaults to TCP + WS on random ports. */
  listenAddresses?: string[];
  /** Multiaddr strings to announce to the network (for nodes behind NAT/VPS with a public IP not bound to the interface). */
  announceAddresses?: string[];
  /** DKG bootstrap peer multiaddrs (NOT public IPFS nodes). */
  bootstrapPeers?: string[];
  /** Enable mDNS for local peer discovery. Default: true. */
  enableMdns?: boolean;
  /** GossipSub context graph topics to subscribe to at startup. */
  contextGraphSubscriptions?: string[];
  /** Ed25519 private key bytes. Generated if absent. */
  privateKey?: Uint8Array;
  /** Data directory for persistent state. */
  dataDir?: string;
  /** Multiaddrs of relay nodes to connect to for NAT traversal. */
  relayPeers?: string[];
  /** Enable circuit relay server on this node (for nodes with public IPs). */
  enableRelayServer?: boolean;
  /**
   * Enable autoNAT service for automatic NAT status detection.
   * Default: true, but auto-disabled when relayPeers or enableRelayServer is
   * set (nodes that already know their NAT status don't need probing).
   */
  enableAutoNAT?: boolean;
  /**
   * Node deployment tier. Core nodes act as relays and GossipSub backbone.
   * Edge nodes are the typical deployment for personal agents behind NATs.
   * Default: 'edge'.
   */
  nodeRole?: 'core' | 'edge';
  /**
   * Single-knob capacity tuning for the Core Node relay server. Sets the
   * maximum number of simultaneous circuit-relay v2 reservations this
   * node will hold; HOP/STOP stream caps and the libp2p
   * connectionManager.maxConnections ceiling are derived from this value
   * at a 1:2 ratio (so capacity=1024 → 2048 streams + 2048 max conns).
   *
   * Default: 1024 (replaces the prior hardcoded 256 cap that bottlenecked
   * a Core Node at ~256 concurrent edge agents — too low for the
   * hundreds-to-thousands-of-agents trajectory). Operators can dial down
   * for resource-constrained hosts (e.g. a Raspberry Pi runs comfortably
   * at 256-512) or up for big iron.
   *
   * IGNORED when this node is not running a relay server (i.e. role !==
   * 'core' and enableRelayServer is false). The knob will log a warning
   * if set on an edge node so the misconfig is visible.
   *
   * IMPORTANT: bumping this above the host's `ulimit -n` will cause
   * silent peer rejections (EMFILE on socket()) once the connection
   * count grows. Recommended host fd limit: `max(4096, capacity × 4)`
   * (equivalently `max(4096, maxConnections × 2)` since
   * `maxConnections = capacity × 2`). The daemon emits a startup
   * warning if the soft limit is below this.
   *
   * Invalid values (0, negative, NaN, fractional, non-numeric) are
   * rejected at startup and the daemon falls back to the default with
   * an operator-facing warning.
   */
  relayServerCapacity?: number;
  /**
   * Number of relay reservations to hold in parallel when behind NAT.
   * The previous behavior (1) was a single point of failure: if the
   * sole reserved relay went unreachable, the edge dropped off the
   * network until the watchdog noticed and re-reserved. Holding 3 in
   * parallel gives N-2 tolerance — two relays can blink concurrently
   * and incoming dialers can still find a working circuit.
   *
   * Implementation: each `/p2p-circuit` listen address triggers a
   * separate reservation slot in libp2p's transport reservation store,
   * so this value translates to N duplicate `/p2p-circuit` entries in
   * `addresses.listen` paired with `reservationConcurrency: N` on the
   * circuit-relay transport so all slots are attempted in parallel
   * at startup. libp2p auto-renews each reservation 5 minutes before
   * expiry so no application-level renewal is needed.
   *
   * Default: 3. Capped at 16 (above which the failure-tolerance
   * benefit is marginal but the per-relay cost is real).
   *
   * IGNORED in two cases (with a startup warning when set explicitly):
   *   - No relayPeers configured (the node isn't behind NAT — nothing
   *     to multi-reserve against).
   *   - Node is itself a relay server (`enableRelayServer: true` or
   *     `nodeRole: 'core'`) — relay servers don't multi-reserve
   *     through other relays; that path falls back to the legacy
   *     single `/p2p-circuit` listener.
   *
   * Invalid values (0, negative, NaN, fractional, non-numeric, > 16)
   * fall back to the default with a warning.
   */
  relayReservationCount?: number;
  /**
   * DKG node-release identifier broadcast to peers via libp2p's
   * `identify` (`/ipfs/id/1.0.0`) handshake. When set, every peer that
   * dials or accepts a connection from this node learns the value.
   *
   * Wire mapping: this is forwarded into `createLibp2p({ nodeInfo:
   * { userAgent } })`, which libp2p's identify protocol then ships as
   * the `agentVersion` PB field and remote peers store under
   * `Peer.metadata.AgentVersion` (note: libp2p's chosen names — they're
   * unfortunately collision-prone with the DKG "agent" concept, hence
   * the rename to `nodeVersion` at every layer we control).
   *
   * Without this, libp2p falls back to its own default
   * (`js-libp2p/<version>`), which discriminates the libp2p toolkit
   * version but tells a remote operator nothing about which DKG node
   * release is running — leaving "what version is each peer running?"
   * unanswerable from the wire.
   *
   * Convention (set by `packages/cli/src/daemon/lifecycle.ts`):
   * `dkg/<semver>` — e.g. `dkg/10.0.0-rc.11`. Surfaced back to operators
   * via `/api/peer-info` and MCP `dkg_peer_info` under
   * `peerStore.nodeVersion`.
   */
  nodeVersion?: string;
}

export type ConnectionTransport = 'direct' | 'relayed';

export interface ConnectionInfo {
  peerId: string;
  remoteAddr: string;
  transport: ConnectionTransport;
  direction: 'inbound' | 'outbound';
  openedAt: number;
}

export interface StreamHandler {
  (data: Uint8Array, peerId: PeerId): Promise<Uint8Array>;
}
