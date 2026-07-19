import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import {
  WalWireProtocolServer,
  type WalRawProtocolRouter,
} from '@origintrail-official/dkg-wal/protocol';

/** Register WAL v1 directly on raw ProtocolRouter, never on Messenger/outbox. */
export function registerWalWireProtocols(
  router: ProtocolRouter,
  server: WalWireProtocolServer,
): () => void {
  return server.register(router as WalRawProtocolRouter);
}
