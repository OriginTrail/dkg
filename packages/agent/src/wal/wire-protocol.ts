import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  WalWireProtocolServer,
  type WalRawProtocolRouter,
} from '@origintrail-official/dkg-wal/protocol';

/** Adapt libp2p's PeerId shape to the byte-explicit WAL transport boundary. */
export function asWalRawProtocolRouter(router: ProtocolRouter): WalRawProtocolRouter {
  return {
    register(protocolId, handler, options) {
      router.register(
        protocolId,
        (data, peerId, handlerOptions) => handler(data, {
          toString: () => peerId.toString(),
          toBytes: () => peerIdFromString(peerId.toString()).toMultihash().bytes,
        }, handlerOptions),
        options,
      );
    },
    unregister: protocolId => router.unregister(protocolId),
    send: (peerId, protocolId, data, options) => router.send(peerId, protocolId, data, options),
  };
}

/** Register WAL v1 directly on raw ProtocolRouter, never on Messenger/outbox. */
export function registerWalWireProtocols(
  router: ProtocolRouter,
  server: WalWireProtocolServer,
): () => void {
  return server.register(asWalRawProtocolRouter(router));
}
