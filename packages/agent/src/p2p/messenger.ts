import type { ProtocolRouter } from '@origintrail-official/dkg-core';

export interface MessengerDeps {
  router: ProtocolRouter;
}

export interface SendOpts {
  timeoutMs?: number;
}

/**
 * Single outbound P2P sending primitive.
 *
 * Forwards the bytes to `ProtocolRouter.send`, which (since RFC 07 PR-3)
 * consults `PeerResolver` before dialing — populating the libp2p
 * peerStore with whatever multiaddrs the resolution order finds
 * (live conn → DHT → RFC 04 registry → agents-CG). Centralising every
 * outbound send through one entry point removes the "this code path
 * forgot to prime the relay route" defect class behind PR #448's
 * Laptop B invite failure.
 *
 * Note: pre-PR-3 this class held its own `PeerResolver` ref and
 * resolved before delegating to the router. After PR-3 the router does
 * the same lookup, so doing it here too duplicated the DHT walk on
 * every cold send. Codex review on PR #497 caught the duplication;
 * the resolver dependency is now owned by `ProtocolRouter` alone.
 *
 * See `dkgv10-spec/production_mainnet/07_IN_PROCESS_PEER_RESOLVER.md`.
 */
export class Messenger {
  private readonly router: ProtocolRouter;

  constructor(deps: MessengerDeps) {
    this.router = deps.router;
  }

  async sendToPeer(
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    opts: SendOpts = {},
  ): Promise<Uint8Array> {
    return this.router.send(peerId, protocolId, data, opts.timeoutMs);
  }
}
