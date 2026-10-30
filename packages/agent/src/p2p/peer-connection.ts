import type { DKGNode } from '@origintrail-official/dkg-core';

/**
 * libp2p's `Connection`. The agent takes libp2p's types through dkg-core, so
 * the shape is inferred from `getConnections()` rather than a dependency.
 */
export type Libp2pConnection = ReturnType<DKGNode['libp2p']['getConnections']>[number];

/**
 * Minimal libp2p connection shape consumed by peer-store and sync workflows.
 * `limits` is present on a limited (relayed) connection.
 */
export interface PeerSyncConnection extends Pick<Libp2pConnection, 'id' | 'status' | 'limits'> {
  direction: 'inbound' | 'outbound';
  remoteAddr?: { toString(): string };
  remotePeer: { toString(): string };
}
