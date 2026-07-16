/**
 * Network interface — RFC 07 §5.
 *
 * The transport-pluggable boundary in front of the in-process network
 * stack. Every component that needs to dial a peer or open a protocol
 * stream should depend on this interface, not on libp2p directly.
 *
 * v1 ships with `LibP2PNetwork` as the only implementation. Multi-stack
 * is enabled architecturally — extra transports plug in behind this
 * interface — but adding iroh / QUIC / any other stack is a separate,
 * gated effort. See RFC 07 §5.1 for the rationale.
 *
 * The companion `PeerResolver` (RFC 07 §3) is the only thing that
 * SHOULD call `dialProtocol` outside of the application protocols
 * themselves; PR-4 of the RFC 07 rollout adds a CI grep gate that
 * keeps this property honest as new protocols are added.
 *
 * See `dkgv10-spec/production_mainnet/07_IN_PROCESS_PEER_RESOLVER.md`.
 */
import type { Stream, Connection } from '@libp2p/interface';

/**
 * Transport-encoded peer identifier. For the v1 libp2p implementation
 * this is the canonical libp2p PeerId string form (e.g. "12D3KooW…").
 *
 * Future transports may use different encodings — iroh would use the
 * Ed25519 public key in z-base-32 form, etc. — but the contract is:
 * a transport produces and consumes its own canonical string identifier
 * end-to-end; consumers treat it as opaque.
 */
export type NodeIdentity = string;

/**
 * Multiaddr-shaped network address. v1 carries libp2p multiaddr strings
 * (e.g. `/ip4/1.2.3.4/tcp/9090/p2p/12D3KooW…`); future transports may
 * use different schemes (iroh node tickets, QUIC URIs, etc.).
 */
export type Address = string;

export interface DialOpts {
  /** Per-dial timeout (ms). Default: 10_000. */
  timeoutMs?: number;
  /** AbortSignal to cancel an in-flight dial. */
  signal?: AbortSignal;
}

/**
 * Handler invoked for every inbound stream on a registered protocol.
 * Implementations should fully consume `stream` (read + close) before
 * returning, or hand it off to a long-lived consumer.
 */
export type ProtocolHandler = (stream: Stream, remote: NodeIdentity) => void | Promise<void>;

/**
 * The minimum set of transport operations every consumer in the
 * application uses. Keeps the libp2p coupling out of dial-path code
 * (sync, chat, skill invoke, /api/connect, …) so the same code can run
 * over a non-libp2p transport in future without re-plumbing every
 * call site.
 */
export interface Network {
  /** This node's transport-encoded identity. Stable for the daemon's lifetime. */
  readonly localId: NodeIdentity;

  /** This node's currently-bound listen addresses, transport-encoded. */
  readonly localAddresses: Address[];

  /** True once `start()` has resolved and false again after `stop()`. */
  readonly isStarted: boolean;

  /**
   * Open a stream to `peerId` on `protocolId`. Implementations should
   * use whatever resolution / dial logic the underlying transport
   * provides — peer-routing, address book, NAT traversal, … The
   * application's `PeerResolver` (RFC 07 §3) is responsible for
   * populating the transport's address book before calling this.
   */
  dialProtocol(peerId: NodeIdentity, protocolId: string, opts?: DialOpts): Promise<Stream>;

  /**
   * Register `handler` for inbound streams on `protocolId`. Idempotent
   * with libp2p semantics: registering twice for the same protocol is
   * a runtime error (libp2p throws DuplicateProtocolHandlerError); call
   * `unhandle` first if replacing.
   */
  handle(protocolId: string, handler: ProtocolHandler): Promise<void>;

  /**
   * Unregister a previously-registered protocol handler. No-op if the
   * protocol was never registered.
   */
  unhandle(protocolId: string): Promise<void>;

  /**
   * Currently-open connections to `peerId`. Returns an empty array
   * when no live connection exists. Sub-millisecond; safe to call on
   * hot paths.
   */
  getConnections(peerId: NodeIdentity): Connection[];

  /**
   * Hint a known set of addresses for `peerId` to the transport's
   * address book. Implementations should store the addresses durably
   * enough that subsequent `dialProtocol(peerId)` calls can use them
   * without re-resolving — but are free to evict on their own policy
   * (LRU, TTL, dial-failure feedback, etc.).
   *
   * Used by `PeerResolver` to push freshly-resolved multiaddrs into
   * the transport's cache before dialing.
   */
  addKnownAddresses(peerId: NodeIdentity, addrs: Address[]): Promise<void>;

  /**
   * Optional: ask the transport's peer-routing layer to find addresses
   * for `peerId`. For libp2p this is a Kademlia DHT walk; for future
   * transports it may be a different mechanism (or absent entirely
   * for transports that have no peer-routing source).
   *
   * Implementations that don't support peer routing should leave this
   * undefined; callers should treat `findPeer === undefined` as
   * "transport has no peer-routing source", not as an error.
   */
  findPeer?(
    peerId: NodeIdentity,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Address[]>;

  /**
   * Lifecycle. Implementations are idempotent: calling `start()` on an
   * already-started instance, or `stop()` on a stopped one, is a no-op.
   */
  start(): Promise<void>;
  stop(): Promise<void>;
}
