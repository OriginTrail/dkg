// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS,
  decodeContextGraphAuthorityIndexSnapshot,
  type ContextGraphAuthorityIndexSnapshotRequest,
} from '@origintrail-official/dkg-chain';
import {
  AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS,
  normalizeAuthorityIndexSnapshotConfig,
  type AuthorityIndexSnapshotConfig,
  type AuthorityIndexSnapshotPeer,
  type NormalizedAuthorityIndexSnapshotConfig,
} from './authority-index-snapshot-config.js';
import {
  AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES,
  AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES,
  encoder,
  exactKeys,
  hasSnapshotEnvelopeKeys,
  parseBounded,
  record,
  STATUSES,
  validateRequest,
  type Status,
} from './authority-index-snapshot-wire.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface AuthorityIndexSnapshotTransportOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxReadBytes: number;
  readonly payloadReuse: 'single-use';
}

export type AuthorityIndexSnapshotClientOptions = (
  | { readonly config: AuthorityIndexSnapshotConfig; readonly normalizedConfig?: never }
  | { readonly normalizedConfig: NormalizedAuthorityIndexSnapshotConfig; readonly config?: never }
) & {
  /**
   * Prime peer.multiaddr, then call ProtocolRouter.send(peer.peerId, protocol, ...).
   * The router's authenticated Noise connection binds the response to that exact
   * configured PeerID. Never implement this callback with a response-claimed ID.
   * Pass the complete options object: single-use bypasses pooled buffering and
   * maxReadBytes aborts the response stream before its wire budget is exceeded.
   */
  readonly request: (
    peer: AuthorityIndexSnapshotPeer,
    bytes: Uint8Array,
    options: AuthorityIndexSnapshotTransportOptions,
  ) => Promise<Uint8Array>;
  /**
   * Runtime trust set, resolved once per fetch, walked instead of the
   * configured peers: cores the chain vouches for plus the network relays.
   * Bounded exactly like configuration (unique identities, at most 8) and
   * under the same per-peer and overall deadlines, validation and failover.
   */
  readonly resolvePeers?: (signal: AbortSignal) => Promise<readonly AuthorityIndexSnapshotPeer[]>;
  readonly timeoutMs?: number;
  /** One peer walk, including chain admission, never gets more than 30 seconds. */
  readonly overallTimeoutMs?: number;
};

export class AuthorityIndexSnapshotUnavailableError extends AggregateError {
  readonly code = 'AUTHORITY_INDEX_SNAPSHOT_UNAVAILABLE';

  constructor(errors: readonly unknown[]) {
    super(errors, 'No configured trusted core supplied a usable authority index snapshot; retry later');
    this.name = 'AuthorityIndexSnapshotUnavailableError';
  }
}

export class AuthorityIndexSnapshotPeerStatusError extends Error {
  constructor(readonly peerId: string, readonly status: Status) {
    super(`Authority index core ${peerId} replied ${status}`);
    this.name = 'AuthorityIndexSnapshotPeerStatusError';
  }
}

async function resolveTrustedPeers(
  resolvePeers: NonNullable<AuthorityIndexSnapshotClientOptions['resolvePeers']>,
  signal: AbortSignal | undefined,
  overall: AbortSignal,
): Promise<readonly AuthorityIndexSnapshotPeer[]> {
  let resolved: readonly AuthorityIndexSnapshotPeer[];
  try {
    resolved = await resolvePeers(overall);
  } catch (error) {
    signal?.throwIfAborted();
    throw new AuthorityIndexSnapshotUnavailableError([error]);
  }
  signal?.throwIfAborted();
  const peers: AuthorityIndexSnapshotPeer[] = [];
  const seen = new Set<string>();
  for (const peer of resolved) {
    if (seen.has(peer.peerId)) continue;
    seen.add(peer.peerId);
    peers.push(peer);
    if (peers.length === AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS) break;
  }
  if (peers.length === 0) {
    throw new AuthorityIndexSnapshotUnavailableError([new Error('no on-chain core peers are available')]);
  }
  return peers;
}

/** Ordered, bounded failover; no multicast or durable message outbox. */
export function createAuthorityIndexSnapshotClient(options: AuthorityIndexSnapshotClientOptions): {
  fetchSnapshot(
    request: ContextGraphAuthorityIndexSnapshotRequest,
    signal?: AbortSignal,
    validateSnapshot?: (snapshot: unknown, signal?: AbortSignal) => Promise<void>,
  ): Promise<unknown>;
} {
  const config = options.normalizedConfig ?? normalizeAuthorityIndexSnapshotConfig(options.config);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new Error('Authority index snapshot timeout must be an integer between 1 and 10000 ms');
  }
  const overallTimeoutMs = options.overallTimeoutMs ?? CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS;
  if (!Number.isSafeInteger(overallTimeoutMs) || overallTimeoutMs < 1
    || overallTimeoutMs > CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS) {
    throw new Error('Authority index snapshot overall timeout must be an integer between 1 and 30000 ms');
  }
  return Object.freeze({
    async fetchSnapshot(
      rawRequest: ContextGraphAuthorityIndexSnapshotRequest,
      signal?: AbortSignal,
      validateSnapshot?: (snapshot: unknown, signal?: AbortSignal) => Promise<void>,
    ) {
      signal?.throwIfAborted();
      const request = validateRequest(rawRequest, config.maxTailBlocks);
      const bytes = encoder.encode(JSON.stringify({ version: 1, request }));
      if (bytes.byteLength > AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES) {
        throw new Error('Authority index snapshot request exceeds wire limit');
      }
      const failures: unknown[] = [];
      const overall = new AbortController();
      const forwardOverallAbort = () => overall.abort(signal!.reason);
      signal?.addEventListener('abort', forwardOverallAbort, { once: true });
      const overallDeadline = Date.now() + overallTimeoutMs;
      const overallTimer = setTimeout(() => overall.abort(
        new Error('Authority index snapshot total seed deadline exceeded'),
      ), overallTimeoutMs);
      try {
        const peers = options.resolvePeers === undefined
          ? config.trustedCorePeers
          : await resolveTrustedPeers(options.resolvePeers, signal, overall.signal);
        for (const peer of peers) {
          signal?.throwIfAborted();
          if (overall.signal.aborted) break;
          const attempt = new AbortController();
          const forwardAbort = () => attempt.abort(overall.signal.reason);
          overall.signal.addEventListener('abort', forwardAbort, { once: true });
          const attemptTimeoutMs = Math.min(timeoutMs, Math.max(1, overallDeadline - Date.now()));
          const timeout = setTimeout(() => attempt.abort(
            new Error(`Authority index snapshot peer ${peer.peerId} timeout`),
          ), attemptTimeoutMs);
          let onAttemptAbort: (() => void) | undefined;
          try {
            const aborted = new Promise<never>((_, reject) => {
              onAttemptAbort = () => reject(attempt.signal.reason);
              attempt.signal.addEventListener('abort', onAttemptAbort, { once: true });
            });
            const fetched = (async () => {
              const responseBytes = await options.request(peer, bytes, {
                signal: attempt.signal,
                timeoutMs: attemptTimeoutMs,
                maxReadBytes: AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES,
                payloadReuse: 'single-use',
              });
              attempt.signal.throwIfAborted();
              const response = record(parseBounded(responseBytes, AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES));
              if (response?.version === 1 && typeof response.status === 'string'
                && STATUSES.has(response.status) && exactKeys(response, ['version', 'status'])) {
                throw new AuthorityIndexSnapshotPeerStatusError(peer.peerId, response.status as Status);
              }
              if (!response || response.version !== 1 || response.status !== 'ok'
                || !exactKeys(response, ['version', 'status', 'snapshot'])) {
                throw new Error('Authority index core snapshot invalid response');
              }
              const snapshot = response.snapshot;
              if (!hasSnapshotEnvelopeKeys(snapshot)
                || decodeContextGraphAuthorityIndexSnapshot(snapshot, request) === undefined) {
                throw new Error('Invalid authority index snapshot envelope, scope, coverage, or integrity');
              }
              // Canonical hash/integrity errors try the next trusted provider,
              // inside both the per-peer and physical seed deadline.
              await validateSnapshot?.(snapshot, attempt.signal);
              attempt.signal.throwIfAborted();
              return snapshot;
            })();
            return await Promise.race([fetched, aborted]);
          } catch (error) {
            signal?.throwIfAborted();
            failures.push(error);
          } finally {
            clearTimeout(timeout);
            overall.signal.removeEventListener('abort', forwardAbort);
            if (onAttemptAbort) attempt.signal.removeEventListener('abort', onAttemptAbort);
          }
        }
        if (overall.signal.aborted && !failures.includes(overall.signal.reason)) {
          failures.push(overall.signal.reason);
        }
        // Retry classification and cooldown belong to the chain bootstrap owner.
        throw new AuthorityIndexSnapshotUnavailableError(failures);
      } finally {
        clearTimeout(overallTimer);
        signal?.removeEventListener('abort', forwardOverallAbort);
      }
    },
  });
}
