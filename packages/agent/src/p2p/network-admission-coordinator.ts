import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_NETWORK_IDENTITY,
  type DkgNetworkIdentity,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { NetworkAdmissionService } from './network-admission.js';
import {
  makeNetworkIdentityRequest,
  parseNetworkIdentityRequest,
  signNetworkIdentityResponse,
  verifyNetworkIdentityResponse,
} from './network-identity-proof.js';

export interface NetworkAdmissionConnection {
  remotePeer: { toString(): string };
  close(): Promise<void> | void;
  abort(error?: Error): void;
}

export interface NetworkAdmissionCoordinatorOptions {
  admission: NetworkAdmissionService;
  identity?: DkgNetworkIdentity;
  selfPeerId: string;
  sign: (payload: Uint8Array) => Promise<Uint8Array>;
  sendIdentityProbe: (
    peerId: string,
    data: Uint8Array,
    options: { timeoutMs: number },
  ) => Promise<Uint8Array>;
  getConnections: () => Iterable<NetworkAdmissionConnection>;
  deletePeerFromPeerStore: (peerId: string) => Promise<void>;
  cleanupRejectedPeerState?: (peerId: string) => void;
  log?: {
    info(ctx: OperationContext, message: string): void;
    warn(ctx: OperationContext, message: string): void;
  };
  probeTimeoutMs?: number;
}

export interface NetworkIdentityProtocolRegistrar {
  register(protocolId: string, handler: (data: Uint8Array) => Promise<Uint8Array>): void;
}

export class NetworkAdmissionCoordinator {
  private readonly admission: NetworkAdmissionService;
  private readonly identity?: DkgNetworkIdentity;
  private readonly selfPeerId: string;
  private readonly sign: (payload: Uint8Array) => Promise<Uint8Array>;
  private readonly sendIdentityProbe: NetworkAdmissionCoordinatorOptions['sendIdentityProbe'];
  private readonly getConnections: () => Iterable<NetworkAdmissionConnection>;
  private readonly deletePeerFromPeerStore: (peerId: string) => Promise<void>;
  private readonly cleanupRejectedPeerState?: (peerId: string) => void;
  private readonly log?: NetworkAdmissionCoordinatorOptions['log'];
  private readonly probeTimeoutMs: number;
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(options: NetworkAdmissionCoordinatorOptions) {
    this.admission = options.admission;
    this.identity = options.identity;
    this.selfPeerId = options.selfPeerId;
    this.sign = options.sign;
    this.sendIdentityProbe = options.sendIdentityProbe;
    this.getConnections = options.getConnections;
    this.deletePeerFromPeerStore = options.deletePeerFromPeerStore;
    this.cleanupRejectedPeerState = options.cleanupRejectedPeerState;
    this.log = options.log;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
  }

  get enabled(): boolean {
    return Boolean(this.identity?.networkId);
  }

  isAcceptedPeer(peerId: string): boolean {
    return this.admission.isAcceptedPeer(peerId);
  }

  verifiedSameNetworkPeerIds(): ReadonlySet<string> {
    return this.admission.verifiedSameNetworkPeerIds();
  }

  filterAcceptedPeerIds(peerIds: Iterable<string>): string[] {
    return [...peerIds].filter((peerId) => this.isAcceptedPeer(peerId));
  }

  filterAcceptedPeers<T extends { toString(): string }>(peers: Iterable<T>): T[] {
    return [...peers].filter((peer) => this.isAcceptedPeer(peer.toString()));
  }

  registerIdentityProtocol(router: NetworkIdentityProtocolRegistrar): void {
    router.register(PROTOCOL_NETWORK_IDENTITY, async (data) => {
      if (!this.identity?.networkId) {
        throw new Error('network identity is not configured');
      }
      const request = parseNetworkIdentityRequest(data);
      const response = await signNetworkIdentityResponse({
        request,
        identity: this.identity,
        responderPeerId: this.selfPeerId,
        sign: this.sign,
      });
      return new TextEncoder().encode(JSON.stringify(response));
    });
  }

  async ensureAdmitted(remotePeer: string, ctx: OperationContext): Promise<boolean> {
    if (!this.identity?.networkId) return true;
    if (this.admission.isAcceptedPeer(remotePeer)) return true;

    const existing = this.inFlight.get(remotePeer);
    if (existing) return existing;

    const promise = this.probePeer(remotePeer, ctx)
      .finally(() => {
        this.inFlight.delete(remotePeer);
      });
    this.inFlight.set(remotePeer, promise);
    return promise;
  }

  private async probePeer(remotePeer: string, ctx: OperationContext): Promise<boolean> {
    const identity = this.identity;
    if (!identity?.networkId) return true;

    try {
      const nonce = randomUUID();
      const request = makeNetworkIdentityRequest({
        nonce,
        requesterPeerId: this.selfPeerId,
        identity,
      });
      const response = await this.sendIdentityProbe(
        remotePeer,
        new TextEncoder().encode(JSON.stringify(request)),
        { timeoutMs: this.probeTimeoutMs },
      );
      const raw = new TextDecoder().decode(response);
      const claimed = JSON.parse(raw) as unknown;
      const verdict = await verifyNetworkIdentityResponse({
        response: claimed,
        remotePeerId: remotePeer,
        localIdentity: identity,
        nonce,
        requesterPeerId: this.selfPeerId,
      });
      if (verdict.ok) {
        this.admission.markVerifiedSameNetwork(remotePeer);
        return true;
      }
      await this.rejectPeer(remotePeer, ctx, `network identity proof rejected: ${verdict.reason ?? 'unknown reason'}`);
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.rejectPeer(remotePeer, ctx, `network identity probe failed: ${message}`);
      return false;
    }
  }

  private async rejectPeer(remotePeer: string, ctx: OperationContext, reason: string): Promise<void> {
    this.admission.quarantinePeer(remotePeer);
    this.cleanupRejectedPeerState?.(remotePeer);
    await this.disconnectAndForgetPeer(remotePeer, ctx);
    this.log?.warn(ctx, `Rejected peer ${remotePeer.slice(-8)}: ${reason}`);
  }

  private async disconnectAndForgetPeer(remotePeer: string, ctx: OperationContext): Promise<void> {
    const shortPeer = remotePeer.slice(-8);
    const connections = [...this.getConnections()]
      .filter((conn) => conn.remotePeer.toString() === remotePeer);
    await Promise.all(connections.map(async (conn) => {
      try {
        await conn.close();
      } catch (err) {
        try {
          conn.abort(err instanceof Error ? err : new Error(String(err)));
        } catch {
          // Best-effort cleanup only; the admission registry already blocks app work.
        }
      }
    }));

    try {
      await this.deletePeerFromPeerStore(remotePeer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log?.info(ctx, `Rejected peer ${shortPeer}: peerstore cleanup skipped/failed: ${message}`);
    }
  }
}
