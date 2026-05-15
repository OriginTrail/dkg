/**
 * Libp2p implementation of the {@link Network} interface — RFC 07 §5.
 *
 * Thin facade over an existing {@link DKGNode}: every method delegates
 * directly to the libp2p instance the node already owns. No state is
 * duplicated; lifecycle is shared.
 *
 * v1 ships this as the only `Network` implementation. The interface
 * boundary is what RFC 07 commits to architecturally; the implementation
 * is libp2p because that's what the rest of V10 already runs on.
 */
import type { Stream, Connection } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { Network, NodeIdentity, Address, DialOpts, ProtocolHandler } from './network.js';
import type { DKGNode } from '../node.js';

const DEFAULT_DIAL_TIMEOUT_MS = 10_000;
const DEFAULT_FIND_PEER_TIMEOUT_MS = 5_000;

export class LibP2PNetwork implements Network {
  private readonly node: DKGNode;

  constructor(node: DKGNode) {
    this.node = node;
  }

  get localId(): NodeIdentity {
    return this.node.peerId;
  }

  get localAddresses(): Address[] {
    return this.node.multiaddrs;
  }

  get isStarted(): boolean {
    return this.node.isStarted;
  }

  async start(): Promise<void> {
    if (!this.node.isStarted) {
      await this.node.start();
    }
  }

  async stop(): Promise<void> {
    if (this.node.isStarted) {
      await this.node.stop();
    }
  }

  async dialProtocol(
    peerId: NodeIdentity,
    protocolId: string,
    opts?: DialOpts,
  ): Promise<Stream> {
    const pid = peerIdFromString(peerId);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
    // libp2p dialProtocol accepts an AbortSignal directly. If the
    // caller supplied one, honour it as-is; otherwise mint one off the
    // timeout so a runaway dial doesn't pin a stream slot indefinitely.
    const signal = opts?.signal ?? AbortSignal.timeout(timeoutMs);
    // V10 edge/core traffic regularly traverses circuit-relay limited
    // connections (RFC 04). The pre-RFC-07 dial path
    // (ProtocolRouter.send) sets runOnLimitedConnection: true for that
    // reason; preserve the same default here so that the first
    // consumer migrated to Network.dialProtocol() doesn't regress on
    // relay-only links. Codex PR #494 round 1.
    return this.node.libp2p.dialProtocol(pid, protocolId, {
      signal,
      runOnLimitedConnection: true,
    });
  }

  async handle(protocolId: string, handler: ProtocolHandler): Promise<void> {
    // Mirror ProtocolRouter.register semantics so the wrapper doesn't
    // silently regress two behaviours the existing dial path relies on:
    //  1. await the handler so an async rejection isn't swallowed as
    //     an unhandled promise — abort the stream on failure instead
    //     of leaving it half-open.
    //  2. pass runOnLimitedConnection: true so inbound protocols keep
    //     working when the only available connection is a relay-limited
    //     one (RFC 04 / V10 edge↔core via circuit-relay).
    // Codex PR #494 round 1.
    await this.node.libp2p.handle(
      protocolId,
      async (stream, connection) => {
        try {
          await handler(stream, connection.remotePeer.toString());
        } catch (err) {
          try {
            stream.abort(err instanceof Error ? err : new Error('handler error'));
          } catch {
            // stream already closed/aborted — nothing to do.
          }
        }
      },
      { runOnLimitedConnection: true },
    );
  }

  async unhandle(protocolId: string): Promise<void> {
    await this.node.libp2p.unhandle(protocolId);
  }

  getConnections(peerId: NodeIdentity): Connection[] {
    const pid = peerIdFromString(peerId);
    return this.node.libp2p.getConnections(pid);
  }

  async addKnownAddresses(peerId: NodeIdentity, addrs: Address[]): Promise<void> {
    if (addrs.length === 0) return;
    const pid = peerIdFromString(peerId);
    const ma = addrs.map((a) => multiaddr(a));
    await this.node.libp2p.peerStore.merge(pid, { multiaddrs: ma });
  }

  async findPeer(
    peerId: NodeIdentity,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Address[]> {
    const pid = peerIdFromString(peerId);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_FIND_PEER_TIMEOUT_MS;
    const signal = opts?.signal ?? AbortSignal.timeout(timeoutMs);
    const info = await this.node.libp2p.peerRouting.findPeer(pid, { signal });
    return (info?.multiaddrs ?? []).map((m) => m.toString());
  }
}
