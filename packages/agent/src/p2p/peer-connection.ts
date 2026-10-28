/** Minimal libp2p connection shape consumed by peer-store and sync workflows. */
export interface PeerSyncConnection {
  direction: 'inbound' | 'outbound';
  remoteAddr?: { toString(): string };
  remotePeer: { toString(): string };
  id?: string;
  status?: string;
  /** Present on a limited (relayed) connection. */
  limits?: unknown;
}
