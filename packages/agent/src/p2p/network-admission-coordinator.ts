import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_NETWORK_IDENTITY,
  createOperationContext,
  isTransportTimeoutError,
  type DkgNetworkIdentity,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  NetworkAdmissionService,
  type NetworkAdmissionProbeBackoff,
  type NetworkAdmissionVerdict,
} from './network-admission.js';
import {
  makeNetworkIdentityRequest,
  parseNetworkIdentityRequest,
  signNetworkIdentityResponse,
  verifyNetworkIdentityResponse,
} from './network-identity-proof.js';
import { canonicalPeerIdString, tryCanonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';
import { mapWithConcurrencySettled } from '../map-with-concurrency.js';

export interface NetworkAdmissionConnection {
  remotePeer: { toString(): string };
  close(): Promise<void> | void;
  abort(error?: Error): void;
}

export interface NetworkAdmissionCoordinatorOptions {
  admission: NetworkAdmissionService;
  identity?: DkgNetworkIdentity;
  cacheIdentities?: readonly DkgNetworkIdentity[];
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
  /**
   * The peer failed the identity proof and is quarantined for `quarantineMs`
   * (the admission service's effective cooldown, so transport refusal can use
   * the same window). Runs BEFORE its connections are closed so transport-level
   * dial refusal is already in place when libp2p's reconnect machinery reacts
   * to the disconnect. Best-effort: a throw is swallowed.
   */
  onPeerRejected?: (peerId: string, quarantineMs: number) => void;
  /** The peer passed the identity proof. Best-effort: a throw is swallowed. */
  onPeerVerified?: (peerId: string) => void;
  log?: {
    info(ctx: OperationContext, message: string): void;
    warn(ctx: OperationContext, message: string): void;
  };
  probeTimeoutMs?: number;
  /** One longer retry for a transport deadline; caller cancellation still wins. Default 15s. */
  probeRetryTimeoutMs?: number;
}

export interface NetworkAdmissionAttemptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface NetworkAdmissionPreflightOptions {
  /** Bound parallel identity streams so publish cannot fan out without limit. */
  maxConcurrency?: number;
}

export interface NetworkAdmissionPreflightResult {
  checked: number;
  admitted: number;
  unresolved: number;
}

interface NetworkAdmissionAttemptPolicy {
  probeRetrySuppression: 'respect' | 'bypass';
}

const AUTOMATIC_ADMISSION_POLICY: NetworkAdmissionAttemptPolicy = {
  probeRetrySuppression: 'respect',
};

const EXPLICIT_CONNECT_ADMISSION_POLICY: NetworkAdmissionAttemptPolicy = {
  probeRetrySuppression: 'bypass',
};

type AdmissionState =
  | { kind: 'cached'; verdict: NetworkAdmissionVerdict }
  | { kind: 'in-flight'; attempt: InFlightAdmissionAttempt }
  | { kind: 'backed-off'; backoff: NetworkAdmissionProbeBackoff }
  | { kind: 'probe' };

/**
 * Most identity probes one admission caller keeps in flight: the ceiling of a
 * preflight round, and the bound the catch-up connected-peer filter
 * (`DKGAgent.listAdmittedConnectedPeers`) probes with.
 */
export const MAX_IDENTITY_PROBE_CONCURRENCY = 4;

export interface NetworkIdentityProtocolRegistrar {
  register(protocolId: string, handler: (data: Uint8Array) => Promise<Uint8Array>): void;
}

class InFlightAdmissionAttempt {
  private readonly controller = new AbortController();
  private readonly promise: Promise<NetworkAdmissionVerdict>;
  private waiters = 0;
  private settled = false;

  constructor(
    private readonly defaultTimeoutMs: number,
    work: (signal: AbortSignal) => Promise<NetworkAdmissionVerdict>,
    onSettled: (attempt: InFlightAdmissionAttempt) => void,
  ) {
    this.promise = Promise.resolve().then(() => work(this.controller.signal)).finally(() => {
      this.settled = true;
      onSettled(this);
    });
  }

  wait(options: NetworkAdmissionAttemptOptions): Promise<NetworkAdmissionVerdict> {
    const signal = options.signal;
    const timeoutMs = options.timeoutMs;
    if (signal?.aborted) return Promise.reject(abortErrorFromSignal(signal.reason));
    this.waiters += 1;

    return new Promise<NetworkAdmissionVerdict>((resolve, reject) => {
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

/**
 * A retryable identity-probe failure.
 *
 * Logging contract: the coordinator logs the failed probe itself, once, with
 * its reason and the backoff it starts. A backed-off skip throws the subclass
 * {@link NetworkAdmissionProbeBackoffError}: no new probe ran, and it repeats
 * the reason of the probe that opened the backoff window. Callers handle
 * either error without logging it again at warning level (GH#1578, GH#3579:
 * one warning per failed probe, not one per caller or per skip). A new throw
 * site must keep that contract or use another error type.
 */
export class NetworkAdmissionProbeError extends Error {
  readonly code = 'NETWORK_ADMISSION_PROBE_FAILED';

  constructor(peerId: string, reason: string) {
    super(`Network identity probe failed for ${peerId}: ${reason}`);
    this.name = 'NetworkAdmissionProbeError';
  }
}

/**
 * An automatic admission attempt skipped inside a failed probe's backoff
 * window. No probe ran, so the peer is simply not admitted yet; automatic
 * probes resume after `retryAfterMs`.
 */
export class NetworkAdmissionProbeBackoffError extends NetworkAdmissionProbeError {
  readonly retryAfterMs: number;

  constructor(peerId: string, backoff: Pick<NetworkAdmissionProbeBackoff, 'reason' | 'retryAfterMs'>) {
    super(peerId, `retryable probe backed off for ${backoff.retryAfterMs}ms after ${backoff.reason}`);
    this.name = 'NetworkAdmissionProbeBackoffError';
    this.retryAfterMs = backoff.retryAfterMs;
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
  private readonly cacheIdentities: readonly DkgNetworkIdentity[];
  private readonly selfPeerId: string;
  private readonly sign: (payload: Uint8Array) => Promise<Uint8Array>;
  private readonly sendIdentityProbe: NetworkAdmissionCoordinatorOptions['sendIdentityProbe'];
  private readonly getConnections: () => Iterable<NetworkAdmissionConnection>;
  private readonly deletePeerFromPeerStore: (peerId: string) => Promise<void>;
  private readonly cleanupRejectedPeerState?: (peerId: string) => void;
  private readonly onPeerRejected?: (peerId: string, quarantineMs: number) => void;
  private readonly onPeerVerified?: (peerId: string) => void;
  private readonly log?: NetworkAdmissionCoordinatorOptions['log'];
  private readonly probeTimeoutMs: number;
  private readonly probeRetryTimeoutMs: number;
  private readonly inFlight = new Map<CanonicalPeerId, InFlightAdmissionAttempt>();

  constructor(options: NetworkAdmissionCoordinatorOptions) {
    this.admission = options.admission;
    this.identity = options.identity;
    this.cacheIdentities = Object.freeze((options.cacheIdentities ?? []).slice(0, 16).map(i => Object.freeze({ ...i })));
    this.selfPeerId = options.identity?.networkId
      ? canonicalAdmissionPeerId(options.selfPeerId)
      : options.selfPeerId.trim();
    this.sign = options.sign;
    this.sendIdentityProbe = options.sendIdentityProbe;
    this.getConnections = options.getConnections;
    this.deletePeerFromPeerStore = options.deletePeerFromPeerStore;
    this.cleanupRejectedPeerState = options.cleanupRejectedPeerState;
    this.onPeerRejected = options.onPeerRejected;
    this.onPeerVerified = options.onPeerVerified;
    this.log = options.log;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
    this.probeRetryTimeoutMs = options.probeRetryTimeoutMs ?? 15_000;
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

  /**
   * Whether an automatic admission attempt would skip the peer now: it has no
   * cached verdict and no probe in flight, and a failed probe's backoff window
   * is still open. Callers can leave such a peer out instead of asking.
   */
  isProbeBackedOff(peerId: string): boolean {
    if (!this.enabled) return false;
    const canonicalPeerId = tryCanonicalPeerIdString(peerId);
    return canonicalPeerId !== null && this.admissionState(canonicalPeerId).kind === 'backed-off';
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
      const ctx = createOperationContext('connect');
      const startedAt = performance.now();
      notifyBestEffort(() => this.log?.info(ctx, `Network identity request received from ${request.requesterPeerId.slice(-8)}`));
      const response = await signNetworkIdentityResponse({
        request,
        identity: this.identity,
        responderPeerId: this.selfPeerId,
        sign: this.sign,
      });
      notifyBestEffort(() => this.log?.info(ctx, `Network identity response signed in ${Math.round(performance.now() - startedAt)}ms`));
      return new TextEncoder().encode(JSON.stringify(response));
    });
  }

  async ensureAdmitted(
    remotePeer: string,
    ctx: OperationContext,
    options: NetworkAdmissionAttemptOptions = {},
  ): Promise<boolean> {
    return (await this.ensureVerdictWithPolicy(remotePeer, ctx, AUTOMATIC_ADMISSION_POLICY, options)) === 'same-network';
  }

  /** This verdict permits only the public chain-cache protocols, never normal admission. */
  async ensureCacheAdmitted(remotePeer: string, ctx: OperationContext, options: NetworkAdmissionAttemptOptions = {}): Promise<boolean> {
    if (!this.enabled || !this.cacheIdentities.length) return false;
    const verdict = await this.ensureVerdictWithPolicy(remotePeer, ctx, AUTOMATIC_ADMISSION_POLICY, options);
    options.signal?.throwIfAborted();
    return verdict === 'same-network' || verdict === 'cache-only';
  }

  async ensureExplicitConnectAdmitted(
    remotePeer: string,
    ctx: OperationContext,
    options: NetworkAdmissionAttemptOptions = {},
  ): Promise<boolean> {
    return (await this.ensureVerdictWithPolicy(remotePeer, ctx, EXPLICIT_CONNECT_ADMISSION_POLICY, options)) === 'same-network';
  }

  /**
   * Resolve admission for a bounded, caller-selected peer set.
   *
   * The coordinator remains the sole owner of accepted/rejected state. An ACK
   * round may briefly bypass the active retry window so a healthy peer cannot
   * be frozen out of a quorum. The admission service owns a short preflight
   * lease inside its bounded retry state, preventing concurrent probe storms
   * without inheriting the longer automatic backoff.
   */
  async preflightPeerAdmission(
    peerIds: Iterable<string>,
    ctx: OperationContext,
    options: NetworkAdmissionPreflightOptions = {},
  ): Promise<NetworkAdmissionPreflightResult> {
    if (!this.enabled) return { checked: 0, admitted: 0, unresolved: 0 };

    const canonicalPeerIds: CanonicalPeerId[] = [];
    for (const peerId of peerIds) {
      try {
        canonicalPeerIds.push(canonicalAdmissionPeerId(peerId));
      } catch {
        // Invalid peer IDs are already rejected by the coordinator boundary.
      }
    }
    const pending = [...new Set(canonicalPeerIds)]
      .filter((peerId) => peerId !== this.selfPeerId)
      .filter((peerId) => !this.isAcceptedPeer(peerId) && !this.isRejectedPeer(peerId));
    if (pending.length === 0) return { checked: 0, admitted: 0, unresolved: 0 };

    const requestedConcurrency = options.maxConcurrency ?? MAX_IDENTITY_PROBE_CONCURRENCY;
    const maxConcurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
      ? Math.min(requestedConcurrency, MAX_IDENTITY_PROBE_CONCURRENCY)
      : 1;
    const results = await mapWithConcurrencySettled(
      pending,
      maxConcurrency,
      async (peerId) => {
        if (!this.admission.claimRetryablePreflightProbe(peerId)) return false;
        try {
          return (await this.ensureVerdictWithPolicy(peerId, ctx, EXPLICIT_CONNECT_ADMISSION_POLICY, {})) === 'same-network';
        } catch (error) {
          this.admission.markRetryablePreflightProbeAttempted(peerId);
          throw error;
        }
      },
    );
    const admitted = results.filter(
      (result) => result.status === 'fulfilled' && result.value,
    ).length;
    const unresolved = pending.length - admitted;
    return { checked: pending.length, admitted, unresolved };
  }

  private async ensureVerdictWithPolicy(
    remotePeer: string,
    ctx: OperationContext,
    policy: NetworkAdmissionAttemptPolicy,
    options: NetworkAdmissionAttemptOptions,
  ): Promise<NetworkAdmissionVerdict> {
    options.signal?.throwIfAborted();
    if (!this.enabled) return 'same-network';
    const remotePeerId = canonicalAdmissionPeerId(remotePeer);
    const state = this.admissionState(remotePeerId);
    if (state.kind === 'cached') return state.verdict;
    if (state.kind === 'in-flight') return state.attempt.wait(options);
    if (state.kind === 'backed-off' && policy.probeRetrySuppression === 'respect') {
      throw new NetworkAdmissionProbeBackoffError(remotePeerId, state.backoff);
    }

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

  /**
   * Where an attempt for the peer starts, in this order: its cached verdict,
   * the probe in flight, the backoff a failed probe opened, or a new probe.
   * The attempt's policy decides whether the backoff holds.
   */
  private admissionState(remotePeerId: CanonicalPeerId): AdmissionState {
    const verdict = this.admission.cachedVerdict(remotePeerId);
    if (verdict !== undefined) return { kind: 'cached', verdict };
    const attempt = this.inFlight.get(remotePeerId);
    if (attempt) return { kind: 'in-flight', attempt };
    const backoff = this.admission.getRetryableProbeBackoff(remotePeerId);
    return backoff ? { kind: 'backed-off', backoff } : { kind: 'probe' };
  }

  /**
   * Suffix for the one warning a failed probe gets. The skips inside the
   * backoff window are not logged, so that warning states the window.
   */
  private describeProbeBackoff(remotePeer: CanonicalPeerId): string {
    const backoff = this.admission.getRetryableProbeBackoff(remotePeer);
    return backoff ? ` (automatic probes paused for ${backoff.retryAfterMs}ms)` : '';
  }

  private throwTransientProbeFailure(
    remotePeer: CanonicalPeerId,
    ctx: OperationContext,
    message: string,
  ): never {
    // Connection liveness permits an earlier re-probe, never admission without
    // a signed identity. Disconnected peers retain exponential suppression.
    const connected = [...this.getConnections()].some(({ remotePeer: peer }) => peer.toString() === remotePeer);
    this.admission.rememberRetryableProbeFailure(remotePeer, message, 'transient', connected ? 3_000 : undefined);
    this.log?.warn(
      ctx,
      `Network identity probe for ${remotePeer.slice(-8)} failed retryably: ${message}${this.describeProbeBackoff(remotePeer)}`,
    );
    throw new NetworkAdmissionProbeError(remotePeer, message);
  }

  private async probePeer(
    remotePeer: CanonicalPeerId,
    ctx: OperationContext,
    signal: AbortSignal,
  ): Promise<NetworkAdmissionVerdict> {
    const identity = this.identity;
    if (!this.enabled) return 'same-network';
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
      const data = new TextEncoder().encode(JSON.stringify(request));
      try {
        response = await this.sendIdentityProbe(remotePeer, data, { timeoutMs: this.probeTimeoutMs, signal });
      } catch (error) {
        if (signal.aborted) throw abortErrorFromSignal(signal.reason);
        if (!isTransportTimeoutError(error)) throw error;
        // A busy peer can miss the first deadline. The same shared owner makes
        // exactly one longer attempt before recording any failure/backoff.
        response = await this.sendIdentityProbe(remotePeer, data, { timeoutMs: this.probeRetryTimeoutMs, signal });
      }
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
      this.throwTransientProbeFailure(remotePeer, ctx, message);
    }
    if (signal.aborted) throw abortErrorFromSignal(signal.reason);
    // A stream can close before sending an identity document. This is retryable
    // transport interruption; only a nonempty malformed document is unreadable.
    if (response.byteLength === 0) {
      this.throwTransientProbeFailure(remotePeer, ctx, 'identity probe ended without a response');
    }

    let claimed: unknown;
    try {
      claimed = JSON.parse(new TextDecoder().decode(response)) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Store a fixed reason: the SyntaxError message echoes remote-controlled
      // bytes, and the backoff reason is re-interpolated into later thrown
      // errors and logs. The raw message is still logged once, below.
      this.admission.rememberRetryableProbeFailure(remotePeer, 'unreadable response', 'unreadable-response');
      this.log?.warn(
        ctx,
        `Network identity probe for ${remotePeer.slice(-8)} returned unreadable response: ${message}${this.describeProbeBackoff(remotePeer)}`,
      );
      throw new NetworkAdmissionProbeError(remotePeer, message);
    }

    const verdict = await verifyNetworkIdentityResponse({
      response: claimed,
      remotePeerId: remotePeer,
      localIdentity: identity,
      nonce,
      requesterPeerId: this.selfPeerId,
    });
    signal.throwIfAborted();
    if (verdict.ok) {
      this.admission.markVerifiedSameNetwork(remotePeer);
      notifyBestEffort(() => this.onPeerVerified?.(remotePeer));
      return 'same-network';
    }
    for (const cacheIdentity of this.cacheIdentities) {
      const cacheVerdict = await verifyNetworkIdentityResponse({ response: claimed, remotePeerId: remotePeer,
        localIdentity: cacheIdentity, nonce, requesterPeerId: this.selfPeerId });
      signal.throwIfAborted();
      if (cacheVerdict.ok) {
        this.admission.markVerifiedCacheOnly(remotePeer);
        // Do not mark same-network, call onPeerVerified, or populate normal peer selection.
        return 'cache-only';
      }
    }
    await this.rejectPeer(remotePeer, ctx, `network identity proof rejected: ${verdict.reason ?? 'unknown reason'}`);
    return 'rejected';
  }

  private async rejectPeer(remotePeer: CanonicalPeerId, ctx: OperationContext, reason: string): Promise<void> {
    // Quarantine is a bounded cooldown, not a permanent blackhole: after it
    // elapses the peer is re-probed, so an operator who corrects a mismatched
    // networkId and restarts the peer re-admits without every observer node
    // restarting.
    const quarantineMs = this.admission.quarantinePeerForCooldown(remotePeer);
    // Before the disconnect: libp2p redials keep-alive-tagged peers on
    // `peer:disconnect`, and discovery re-offers the peer within ~0.2s.
    notifyBestEffort(() => this.onPeerRejected?.(remotePeer, quarantineMs));
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

function notifyBestEffort(notify: () => void): void {
  try {
    notify();
  } catch {
    // Transport hints must never change an admission verdict.
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
