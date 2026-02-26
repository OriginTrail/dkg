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
  /** GossipSub paranet topics to subscribe to at startup. */
  paranetSubscriptions?: string[];
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
}

export interface StreamHandler {
  (data: Uint8Array, peerId: PeerId): Promise<Uint8Array>;
}
