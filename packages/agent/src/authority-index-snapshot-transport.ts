// SPDX-License-Identifier: Apache-2.0

import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { DKGNode, ProtocolRouter } from '@origintrail-official/dkg-core';
import {
  PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT,
  type AuthorityIndexSnapshotClientOptions,
} from './authority-index-snapshot-service.js';

interface SnapshotTransportContext {
  readonly started: boolean;
  readonly node: DKGNode;
  readonly router: ProtocolRouter | undefined;
}

/** Direct authenticated bootstrap; never resolve the authority-dependent phonebook. */
export function createAuthorityIndexSnapshotTransport(
  current: () => SnapshotTransportContext | undefined,
): AuthorityIndexSnapshotClientOptions['request'] {
  return async (peer, bytes, options) => {
    const context = current();
    if (context === undefined || !context.started || context.router === undefined) {
      throw new Error('Authority index snapshot transport is not started');
    }
    options.signal.throwIfAborted();
    const peerId = peerIdFromString(peer.peerId);
    if (peer.multiaddr === undefined) {
      // A discovered core carries no dial address: it is only trusted over the
      // authenticated connection that already exists, never a phonebook dial.
      if (context.node.libp2p.getConnections(peerId).length === 0) {
        throw new Error(`Authority index core ${peer.peerId} is not connected`);
      }
    } else {
      const address = multiaddr(peer.multiaddr);
      await context.node.libp2p.peerStore.merge(peerId, { multiaddrs: [address] });
      options.signal.throwIfAborted();
      // Establish the connection first so ProtocolRouter can perform ordinary
      // network admission without a cold PeerResolver lookup through the index.
      await context.node.libp2p.dial(address, { signal: options.signal });
      options.signal.throwIfAborted();
    }
    return context.router.send(
      peer.peerId, PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT, bytes, options,
    );
  };
}
