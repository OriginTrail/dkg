import type { ProtocolRouter, PeerResolver } from '@origintrail-official/dkg-core';

export interface MessengerDeps {
  resolver: PeerResolver;
  router: ProtocolRouter;
}

export interface SendOpts {
  timeoutMs?: number;
}

/**
 * Single outbound P2P sending primitive.
 *
 * Two responsibilities:
 *  1. Best-effort consult `PeerResolver` to populate the libp2p
 *     peerStore with whatever multiaddrs the resolution order finds
 *     (live conn, DHT, RFC 04 registry, agents-CG, bootstrap seeds).
 *     The patch is the resolver's side effect; this code just
 *     triggers the lookup before dialing.
 *  2. Forward the bytes via `ProtocolRouter.send` (which itself owns
 *     transport-level retry on recoverable errors — see
 *     protocol-router.ts).
 *
 * Centralising this in one place removes a class of "this code path
 * forgot to ensure an address was known" defects (the latent bug
 * behind PR #448's Laptop B invite failure).
 *
 * After RFC 07 PR-2: resolution is delegated to `PeerResolver` rather
 * than inlined. PR-3 of the RFC 07 rollout migrates `ProtocolRouter`
 * itself, after which the resolver is consulted on every dial path
 * (chat / sync / skill invoke / `/api/connect`) — not just chat.
 *
 * See `dkgv10-spec/production_mainnet/07_IN_PROCESS_PEER_RESOLVER.md`.
 */
export class Messenger {
  private readonly resolver: PeerResolver;
  private readonly router: ProtocolRouter;

  constructor(deps: MessengerDeps) {
    this.resolver = deps.resolver;
    this.router = deps.router;
  }

  async sendToPeer(
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    opts: SendOpts = {},
  ): Promise<Uint8Array> {
    // Best-effort: fire the resolver to populate peerStore. Failures
    // are swallowed deliberately — the router's send() will surface
    // a real transport error from dialProtocol if the peer is
    // unreachable, and the resolver itself never throws on resolution
    // failure (it returns an empty array).
    //
    // Codex review feedback on PR #496:
    //   round 1 — "pass timeoutMs through so the resolver doesn't run
    //              unbounded"
    //   round 3 — "but then timeoutMs is double-spent: once by the
    //              resolver, once by router.send()"
    // Both correct. The RIGHT fix is to share a single deadline /
    // AbortSignal across resolver + router.send, but ProtocolRouter
    // doesn't accept an external signal today (it builds its own
    // internally from `timeoutMs`). Plumbing a shared signal through
    // the router is its own refactor.
    //
    // For PR #496 in isolation: this entire code path is transient.
    // PR-3 of the RFC 07 stack moves resolution into ProtocolRouter
    // (where the budget can be shared without leaking through public
    // surfaces) and reduces Messenger to a pass-through. Reverting
    // the round-1 timeoutMs passthrough avoids the double-spend
    // regression Codex flagged in round 3 without needing a router
    // refactor that PR-3 supersedes anyway. The pre-PR behaviour
    // (resolver runs with default budget, router runs with caller
    // budget) is what Messenger users (chat / sync) had before this
    // PR; both use generous timeouts (≥30s) so the resolver's 5s
    // default doesn't push them over.
    await this.resolver.resolve(peerId).catch(() => undefined);
    return this.router.send(peerId, protocolId, data, opts.timeoutMs);
  }
}
