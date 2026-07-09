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
    options: { timeoutMs: number; signal?: AbortSignal },
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

export interface NetworkAdmissionAttemptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface NetworkIdentityProtocolRegistrar {
  register(protocolId: string, handler: (data: Uint8Array) => Promise<Uint8Array>): void;
}

export class NetworkAdmissionProbeError extends Error {
  readonly code = 'NETWORK_ADMISSION_PROBE_FAILED';

  constructor(peerId: string, reason: string) {
    super(`Network identity probe failed for ${peerId}: ${reason}`);
    this.name = 'NetworkAdmissionProbeError';
  }
}

export class NetworkAdmissionRejectedError extends Error {
  readonly code = 'NETWORK_ADMISSION_REJECTED';

  constructor(peerId: string) {
    super(`Peer ${peerId} is not admitted for the active DKG network`);
    this.name = 'NetworkAdmissionRejectedError';
  }
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
    if (!this.identity?.networkId) return true;
    return this.admission.isAcceptedPeer(peerId);
  }

  isRejectedPeer(peerId: string): boolean {
    if (!this.identity?.networkId) return false;
    return this.admission.isRejectedPeer(peerId);
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

  async ensureAdmitted(
    remotePeer: string,
    ctx: OperationContext,
    options: NetworkAdmissionAttemptOptions = {},
  ): Promise<boolean> {
    if (!this.identity?.networkId) return true;
    if (this.admission.isAcceptedPeer(remotePeer)) return true;

    const existing = this.inFlight.get(remotePeer);
    if (existing) return this.raceAdmissionSignal(existing, options.signal);

    const promise = this.probePeer(remotePeer, ctx, options)
      .finally(() => {
        this.inFlight.delete(remotePeer);
      });
    this.inFlight.set(remotePeer, promise);
    return this.raceAdmissionSignal(promise, options.signal);
  }

  private async probePeer(
    remotePeer: string,
    ctx: OperationContext,
    options: NetworkAdmissionAttemptOptions,
  ): Promise<boolean> {
    const identity = this.identity;
    if (!identity?.networkId) return true;

    const nonce = randomUUID();
    const request = makeNetworkIdentityRequest({
      nonce,
      requesterPeerId: this.selfPeerId,
      identity,
    });

    let response: Uint8Array;
    const timeoutMs = Math.min(this.probeTimeoutMs, options.timeoutMs ?? this.probeTimeoutMs);
    if (options.signal?.aborted) {
      throw abortErrorFromSignal(options.signal.reason);
    }
    try {
      response = await this.sendIdentityProbe(
        remotePeer,
        new TextEncoder().encode(JSON.stringify(request)),
        { timeoutMs, signal: options.signal },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log?.warn(ctx, `Network identity probe for ${remotePeer.slice(-8)} failed retryably: ${message}`);
      throw new NetworkAdmissionProbeError(remotePeer, message);
    }

    let claimed: unknown;
    try {
      claimed = JSON.parse(new TextDecoder().decode(response)) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log?.warn(ctx, `Network identity probe for ${remotePeer.slice(-8)} returned unreadable response: ${message}`);
      throw new NetworkAdmissionProbeError(remotePeer, message);
    }

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
  }

  private raceAdmissionSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortErrorFromSignal(signal.reason));

    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        cleanup();
        reject(abortErrorFromSignal(signal.reason));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (err) => {
          cleanup();
          reject(err);
        },
      );
    });
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

function abortErrorFromSignal(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Network admission aborted');
  error.name = 'AbortError';
  return error;
}
