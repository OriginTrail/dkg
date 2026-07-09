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
  probeBackoff?: Partial<NetworkAdmissionProbeBackoffOptions>;
  quarantineCooldownMs?: number;
  now?: () => number;
}

export interface NetworkAdmissionAttemptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface NetworkAdmissionProbeBackoffOptions {
  transientBaseMs: number;
  transientMaxMs: number;
  unreadableResponseMs: number;
}

type NetworkAdmissionProbeBackoffKind = 'transient' | 'unreadable-response';

interface NetworkAdmissionProbeBackoffEntry {
  failures: number;
  kind: NetworkAdmissionProbeBackoffKind;
  reason: string;
  untilMs: number;
}

export interface NetworkIdentityProtocolRegistrar {
  register(protocolId: string, handler: (data: Uint8Array) => Promise<Uint8Array>): void;
}

class InFlightAdmissionAttempt {
  private readonly controller = new AbortController();
  private readonly promise: Promise<boolean>;
  private waiters = 0;
  private settled = false;

  constructor(
    private readonly defaultTimeoutMs: number,
    work: (signal: AbortSignal) => Promise<boolean>,
    onSettled: (attempt: InFlightAdmissionAttempt) => void,
  ) {
    this.promise = Promise.resolve().then(() => work(this.controller.signal)).finally(() => {
      this.settled = true;
      onSettled(this);
    });
  }

  wait(options: NetworkAdmissionAttemptOptions): Promise<boolean> {
    const signal = options.signal;
    const timeoutMs = options.timeoutMs;
    if (signal?.aborted) return Promise.reject(abortErrorFromSignal(signal.reason));
    this.waiters += 1;

    return new Promise<boolean>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let released = false;
      const cleanup = () => {
        if (released) return;
        released = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        this.waiters = Math.max(0, this.waiters - 1);
        if (this.waiters === 0 && !this.settled) {
          this.controller.abort(admissionTimeoutError(timeoutMs ?? this.defaultTimeoutMs));
        }
      };
      const onAbort = () => {
        cleanup();
        reject(abortErrorFromSignal(signal?.reason));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
        timeout = setTimeout(() => {
          cleanup();
          reject(admissionTimeoutError(timeoutMs));
        }, Math.max(0, timeoutMs));
      }
      this.promise.then(
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
  private static readonly MAX_PROBE_BACKOFF_ENTRIES = 10_000;
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
  private readonly probeBackoff: NetworkAdmissionProbeBackoffOptions;
  private readonly quarantineCooldownMs: number;
  private readonly now: () => number;
  private readonly inFlight = new Map<CanonicalPeerId, InFlightAdmissionAttempt>();
  private readonly retryableProbeBackoff = new Map<CanonicalPeerId, NetworkAdmissionProbeBackoffEntry>();

  constructor(options: NetworkAdmissionCoordinatorOptions) {
    this.admission = options.admission;
    this.identity = options.identity;
    this.selfPeerId = options.identity?.networkId
      ? canonicalAdmissionPeerId(options.selfPeerId)
      : options.selfPeerId.trim();
    this.sign = options.sign;
    this.sendIdentityProbe = options.sendIdentityProbe;
    this.getConnections = options.getConnections;
    this.deletePeerFromPeerStore = options.deletePeerFromPeerStore;
    this.cleanupRejectedPeerState = options.cleanupRejectedPeerState;
    this.log = options.log;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
    this.probeBackoff = {
      transientBaseMs: options.probeBackoff?.transientBaseMs ?? 15_000,
      transientMaxMs: options.probeBackoff?.transientMaxMs ?? 120_000,
      unreadableResponseMs: options.probeBackoff?.unreadableResponseMs ?? 60_000,
    };
    this.quarantineCooldownMs = options.quarantineCooldownMs ?? 300_000;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return Boolean(this.identity?.networkId);
  }

  isAcceptedPeer(peerId: string): boolean {
    if (!this.enabled) return true;
    return this.admission.isAcceptedPeer(peerId);
  }

  isRejectedPeer(peerId: string): boolean {
    if (!this.enabled) return false;
    return this.admission.isRejectedPeer(peerId);
  }

  verifiedSameNetworkPeerIds(): ReadonlySet<string> {
    if (!this.enabled) return new Set();
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
      if (!this.enabled || !this.identity?.networkId) {
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
    if (!this.enabled) return true;
    const remotePeerId = canonicalAdmissionPeerId(remotePeer);
    if (this.admission.isAcceptedPeer(remotePeerId)) return true;
    if (this.admission.isRejectedPeer(remotePeerId)) return false;
    const backoff = this.probeBackoffEntry(remotePeerId);
    if (backoff) {
      const retryAfterMs = Math.max(0, backoff.untilMs - this.now());
      throw new NetworkAdmissionProbeError(
        remotePeerId,
        `retryable probe backed off for ${retryAfterMs}ms after ${backoff.reason}`,
      );
    }
    if (options.signal?.aborted) return Promise.reject(abortErrorFromSignal(options.signal.reason));

    const existing = this.inFlight.get(remotePeerId);
    if (existing) return existing.wait(options);

    const attempt = new InFlightAdmissionAttempt(
      this.probeTimeoutMs,
      (signal) => this.probePeer(remotePeerId, ctx, signal),
      (settledAttempt) => {
        if (this.inFlight.get(remotePeerId) === settledAttempt) this.inFlight.delete(remotePeerId);
      },
    );
    this.inFlight.set(remotePeerId, attempt);
    return attempt.wait(options);
  }

  private async probePeer(
    remotePeer: CanonicalPeerId,
    ctx: OperationContext,
    signal: AbortSignal,
  ): Promise<boolean> {
    const identity = this.identity;
    if (!this.enabled) return true;
    if (!identity?.networkId) {
      throw new Error('network identity is required when network admission is enabled');
    }

    const nonce = randomUUID();
    const request = makeNetworkIdentityRequest({
      nonce,
      requesterPeerId: this.selfPeerId,
      identity,
    });

    let response: Uint8Array;
    if (signal.aborted) throw abortErrorFromSignal(signal.reason);
    try {
      response = await this.sendIdentityProbe(
        remotePeer,
        new TextEncoder().encode(JSON.stringify(request)),
        { timeoutMs: this.probeTimeoutMs, signal },
      );
    } catch (err) {
      if (signal.aborted) throw abortErrorFromSignal(signal.reason);
      const message = err instanceof Error ? err.message : String(err);
      // Every transport probe failure is retryable-transient — including a
      // multistream "could not negotiate"/`na`. That `na` is ambiguous: a
      // same-network peer that is still booting answers it during the window
      // between `libp2p.start()` and `registerIdentityProtocol()`, and it is
      // indistinguishable by message from a peer that will never support the
      // protocol. Treating it as a long "unsupported-protocol" blackhole would
      // reject a healthy restarting peer across *every* protocol for minutes
      // (the admission gate is protocol-agnostic). The exponential transient
      // backoff lets a booting peer recover on its next probe instead.
      this.rememberRetryableProbeFailure(remotePeer, message, 'transient');
      this.log?.warn(ctx, `Network identity probe for ${remotePeer.slice(-8)} failed retryably: ${message}`);
      throw new NetworkAdmissionProbeError(remotePeer, message);
    }
    if (signal.aborted) throw abortErrorFromSignal(signal.reason);

    let claimed: unknown;
    try {
      claimed = JSON.parse(new TextDecoder().decode(response)) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Store a fixed reason: the SyntaxError message echoes remote-controlled
      // bytes, and the backoff reason is re-interpolated into later thrown
      // errors and logs. The raw message is still logged once, below.
      this.rememberRetryableProbeFailure(remotePeer, 'unreadable response', 'unreadable-response');
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
      this.retryableProbeBackoff.delete(remotePeer);
      return true;
    }
    await this.rejectPeer(remotePeer, ctx, `network identity proof rejected: ${verdict.reason ?? 'unknown reason'}`);
    return false;
  }

  private async rejectPeer(remotePeer: CanonicalPeerId, ctx: OperationContext, reason: string): Promise<void> {
    this.retryableProbeBackoff.delete(remotePeer);
    // Quarantine is a bounded cooldown, not a permanent blackhole: after it
    // elapses the peer is re-probed, so an operator who corrects a mismatched
    // networkId and restarts the peer re-admits without every observer node
    // restarting.
    this.admission.quarantinePeer(remotePeer, this.now() + this.quarantineCooldownMs);
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

  private probeBackoffEntry(remotePeer: CanonicalPeerId): NetworkAdmissionProbeBackoffEntry | undefined {
    const entry = this.retryableProbeBackoff.get(remotePeer);
    if (!entry) return undefined;
    // An expired entry is retained (not deleted) so its `failures` counter can
    // still grow the next backoff exponentially; abandoned entries are reclaimed
    // by the size-triggered sweep in rememberRetryableProbeFailure.
    if (entry.untilMs <= this.now()) return undefined;
    return entry;
  }

  private rememberRetryableProbeFailure(
    remotePeer: CanonicalPeerId,
    reason: string,
    kind: NetworkAdmissionProbeBackoffKind,
  ): void {
    const previous = this.retryableProbeBackoff.get(remotePeer);
    const failures = (previous?.failures ?? 0) + 1;
    const delayMs = this.probeBackoffDelayMs(failures, kind);
    // Bound memory: when tracking a *new* peer would push the map past its cap,
    // reclaim entries that have already expired (peers that failed once and
    // never returned). Active back-offs and the peer being recorded now are
    // untouched, so exponential growth for a persistently-failing peer is kept.
    if (!previous && this.retryableProbeBackoff.size >= NetworkAdmissionCoordinator.MAX_PROBE_BACKOFF_ENTRIES) {
      this.pruneExpiredProbeBackoff();
    }
    this.retryableProbeBackoff.set(remotePeer, {
      failures,
      kind,
      reason,
      untilMs: this.now() + delayMs,
    });
  }

  private pruneExpiredProbeBackoff(): void {
    const now = this.now();
    for (const [peerId, entry] of this.retryableProbeBackoff) {
      if (entry.untilMs <= now) this.retryableProbeBackoff.delete(peerId);
    }
  }

  private probeBackoffDelayMs(failures: number, kind: NetworkAdmissionProbeBackoffKind): number {
    if (kind === 'unreadable-response') return this.probeBackoff.unreadableResponseMs;

    const exponent = Math.min(Math.max(failures - 1, 0), 8);
    return Math.min(
      this.probeBackoff.transientMaxMs,
      this.probeBackoff.transientBaseMs * (2 ** exponent),
    );
  }
}

function abortErrorFromSignal(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Network admission aborted');
  error.name = 'AbortError';
  return error;
}
function admissionTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Network admission timed out after ${timeoutMs}ms`);
  error.name = 'AbortError';
  (error as { code?: string }).code = 'CONNECT_TIMEOUT';
  return error;
}

function canonicalAdmissionPeerId(peerId: string): CanonicalPeerId {
  try {
    return canonicalPeerIdString(peerId);
  } catch (err) {
    throw new NetworkAdmissionInvalidPeerIdError(peerId, err instanceof Error ? err.message : String(err));
  }
}

