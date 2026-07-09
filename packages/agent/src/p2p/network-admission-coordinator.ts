import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_NETWORK_IDENTITY,
  type DkgNetworkIdentity,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  NetworkAdmissionService,
  canonicalTargetPeerIdFromMultiaddr,
  targetPeerIdFromMultiaddr,
} from './network-admission.js';
import {
  makeNetworkIdentityRequest,
  parseNetworkIdentityRequest,
  signNetworkIdentityResponse,
  verifyNetworkIdentityResponse,
} from './network-identity-proof.js';
import { canonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';

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

export class NetworkAdmissionInvalidPeerIdError extends Error {
  readonly code = 'INVALID_PEER_ID';

  constructor(peerId: string, reason: string) {
    super(`Invalid peer id ${peerId}: ${reason}`);
    this.name = 'NetworkAdmissionInvalidPeerIdError';
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
    this.selfPeerId = options.identity?.networkId ? canonicalAdmissionPeerId(options.selfPeerId) : options.selfPeerId.trim();
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
    const canonicalPeerId = tryCanonicalAdmissionPeerId(peerId);
    return canonicalPeerId ? this.admission.isAcceptedPeerCanonical(canonicalPeerId) : false;
  }

  isRejectedPeer(peerId: string): boolean {
    if (!this.identity?.networkId) return false;
    const canonicalPeerId = tryCanonicalAdmissionPeerId(peerId);
    return canonicalPeerId ? this.admission.isRejectedPeerCanonical(canonicalPeerId) : true;
  }

  verifiedSameNetworkPeerIds(): ReadonlySet<string> {
    return this.admission.verifiedSameNetworkPeerIds();
  }

  targetPeerIdForExplicitConnect(multiaddress: string): string | undefined {
    if (!this.enabled) return targetPeerIdFromMultiaddr(multiaddress);
    let target;
    try {
      target = canonicalTargetPeerIdFromMultiaddr(multiaddress);
    } catch (err) {
      throw new NetworkAdmissionInvalidPeerIdError(
        targetPeerIdFromMultiaddr(multiaddress) ?? '<missing>',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!target) {
      throw new NetworkAdmissionInvalidPeerIdError(
        '<missing>',
        'connect multiaddr must include a target /p2p/<peerId> for network admission',
      );
    }
    return target.canonical;
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
    const remotePeerId = canonicalAdmissionPeerId(remotePeer);
    if (this.admission.isAcceptedPeerCanonical(remotePeerId)) return true;

    const existing = this.inFlight.get(remotePeerId);
    if (existing) return this.raceAdmissionSignal(existing, options.signal);

    const promise = this.probePeer(remotePeerId, ctx, options)
      .finally(() => {
        this.inFlight.delete(remotePeerId);
      });
    this.inFlight.set(remotePeerId, promise);
    return this.raceAdmissionSignal(promise, options.signal);
  }

  private async probePeer(
    remotePeer: CanonicalPeerId,
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
      this.admission.markVerifiedSameNetworkCanonical(remotePeer);
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

  private async rejectPeer(remotePeer: CanonicalPeerId, ctx: OperationContext, reason: string): Promise<void> {
    this.admission.quarantinePeerCanonical(remotePeer);
    this.cleanupRejectedPeerState?.(remotePeer);
    await this.disconnectAndForgetPeer(remotePeer, ctx);
    this.log?.warn(ctx, `Rejected peer ${remotePeer.slice(-8)}: ${reason}`);
  }

  private async disconnectAndForgetPeer(remotePeer: CanonicalPeerId, ctx: OperationContext): Promise<void> {
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

function canonicalAdmissionPeerId(peerId: string): CanonicalPeerId {
  try {
    return canonicalPeerIdString(peerId);
  } catch (err) {
    throw new NetworkAdmissionInvalidPeerIdError(peerId, err instanceof Error ? err.message : String(err));
  }
}

function tryCanonicalAdmissionPeerId(peerId: string): CanonicalPeerId | null {
  try {
    return canonicalAdmissionPeerId(peerId);
  } catch {
    return null;
  }
}
