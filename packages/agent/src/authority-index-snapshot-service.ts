// SPDX-License-Identifier: Apache-2.0

import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS,
  CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_BYTES,
  CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MIN_TAIL_BLOCKS,
  ContextGraphAuthorityIndexSnapshotExportError,
  type ContextGraphAuthorityIndexSnapshotRequest,
} from '@origintrail-official/dkg-chain';

/** A bootstrap protocol: never resolve catalog/phonebook authority to serve it. */
export const PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT = '/dkg/10.0.0/authority-index-snapshot/1';
export const AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES = 2_048;
export const AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES = CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_BYTES;
export const AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS = 8;
export const AUTHORITY_INDEX_SNAPSHOT_DEFAULT_MAX_TAIL_BLOCKS = 2_000;
const MAX_TAIL_BLOCKS = 10_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_EXPORTS = 4;
const FAILURE_COOLDOWN_MS = 5_000;
const MAX_COOLDOWN_SCOPES = 32;
const PEER_RATE_WINDOW_MS = 5_000;
const PEER_RATE_BURST = 4;
const MAX_RATE_LIMIT_PEERS = 1_024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HASH = /^0x[0-9a-f]{64}$/i;

export interface AuthorityIndexSnapshotConfig {
  readonly trustedCorePeers: readonly string[];
  readonly maxTailBlocks?: number;
}

export interface AuthorityIndexSnapshotPeer {
  readonly peerId: string;
  readonly multiaddr: string;
}

export interface NormalizedAuthorityIndexSnapshotConfig {
  readonly trustedCorePeers: readonly AuthorityIndexSnapshotPeer[];
  readonly maxTailBlocks: number;
}

/** Explicit identities only. Discovery or relay roles never enlarge this trust set. */
export function normalizeAuthorityIndexSnapshotConfig(
  config: AuthorityIndexSnapshotConfig,
): NormalizedAuthorityIndexSnapshotConfig {
  if (!Array.isArray(config.trustedCorePeers)
    || config.trustedCorePeers.length === 0
    || config.trustedCorePeers.length > AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS) {
    throw new Error('Authority index trustedCorePeers must contain at least 1 and at most 8 explicit multiaddrs');
  }
  const maxTailBlocks = config.maxTailBlocks === undefined
    ? AUTHORITY_INDEX_SNAPSHOT_DEFAULT_MAX_TAIL_BLOCKS
    : config.maxTailBlocks;
  if (!Number.isSafeInteger(maxTailBlocks)
    || maxTailBlocks < CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MIN_TAIL_BLOCKS
    || maxTailBlocks > MAX_TAIL_BLOCKS) {
    throw new Error(`Authority index maxTailBlocks must be an integer between ${CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MIN_TAIL_BLOCKS} and 10000`);
  }
  const identities = new Set<string>();
  const peers = config.trustedCorePeers.map((raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1_024) {
      throw new Error('Authority index trusted core must be an explicit multiaddr');
    }
    const parsed = multiaddr(raw);
    const components = parsed.getComponents();
    const last = components.at(-1);
    const circuitIndexes = components.flatMap((part, index) => part.name === 'p2p-circuit' ? [index] : []);
    const peerIndexes = components.flatMap((part, index) => part.name === 'p2p' ? [index] : []);
    const host = components[0];
    if (!host || !['ip4', 'ip6', 'dns', 'dns4', 'dns6'].includes(host.name)
      || !components.some((part) => part.name === 'tcp' || part.name === 'udp')
      || last?.name !== 'p2p' || !last.value
      || circuitIndexes.length > 1
      || (circuitIndexes.length === 0 && peerIndexes.length !== 1)
      || (circuitIndexes.length === 1 && (
        peerIndexes.length !== 2
        || peerIndexes[0] !== circuitIndexes[0] - 1
        || peerIndexes[1] !== circuitIndexes[0] + 1
      ))) {
      throw new Error('Authority index trusted core requires a host transport and unambiguous final /p2p/<peerId>');
    }
    // Canonicalize alternate encodings so one identity cannot count twice.
    const peerId = peerIdFromString(last.value).toString();
    if (identities.has(peerId)) throw new Error('Authority index trustedCorePeers contains a duplicate peer identity');
    identities.add(peerId);
    return Object.freeze({ peerId, multiaddr: parsed.toString() });
  });
  return Object.freeze({ trustedCorePeers: Object.freeze(peers), maxTailBlocks });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validBlock(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateRequest(value: unknown, maxTailBlocks = MAX_TAIL_BLOCKS): ContextGraphAuthorityIndexSnapshotRequest {
  const data = record(value);
  if (!data || !exactKeys(data, ['scope', 'deploymentBlockNumber', 'minThroughBlockNumber', 'maxThroughBlockNumber'])
    || typeof data.scope !== 'string' || data.scope.length === 0 || data.scope.length > 512
    || data.scope !== data.scope.trim()
    || Array.from(data.scope).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || !validBlock(data.deploymentBlockNumber)
    || !validBlock(data.minThroughBlockNumber)
    || !validBlock(data.maxThroughBlockNumber)
    || data.minThroughBlockNumber < data.deploymentBlockNumber
    || data.maxThroughBlockNumber < data.minThroughBlockNumber
    || data.maxThroughBlockNumber - data.minThroughBlockNumber > maxTailBlocks) {
    throw new Error('Invalid authority index snapshot request');
  }
  return Object.freeze({
    scope: data.scope,
    deploymentBlockNumber: data.deploymentBlockNumber,
    minThroughBlockNumber: data.minThroughBlockNumber,
    maxThroughBlockNumber: data.maxThroughBlockNumber,
  });
}

function parseBounded(bytes: Uint8Array, limit: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit) {
    throw new Error('Authority index snapshot wire size limit exceeded');
  }
  return JSON.parse(decoder.decode(bytes));
}

/** Envelope/coverage check only; chain-owned admission validates state and its anchor. */
function validateSnapshotEnvelope(value: unknown, request: ContextGraphAuthorityIndexSnapshotRequest): unknown {
  const snapshot = record(value);
  const checkpoint = record(snapshot?.checkpoint);
  const cursor = record(checkpoint?.cursor);
  if (!snapshot || !exactKeys(snapshot, ['version', 'scope', 'checkpoint'])
    || snapshot.version !== 1 || snapshot.scope !== request.scope
    || !checkpoint || checkpoint.version !== 2 || !Array.isArray(checkpoint.states)
    || typeof checkpoint.integrity !== 'string' || !HASH.test(checkpoint.integrity)
    || !cursor || cursor.deploymentBlockNumber !== request.deploymentBlockNumber
    || !validBlock(cursor.throughBlockNumber)
    || cursor.throughBlockNumber < request.minThroughBlockNumber
    || cursor.throughBlockNumber > request.maxThroughBlockNumber
    || typeof cursor.throughBlockHash !== 'string' || !HASH.test(cursor.throughBlockHash)) {
    throw new Error('Invalid authority index snapshot envelope, scope, or coverage');
  }
  return value;
}

export interface AuthorityIndexSnapshotTransportOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxReadBytes: number;
  readonly payloadReuse: 'single-use';
}

export interface AuthorityIndexSnapshotClientOptions {
  readonly config: AuthorityIndexSnapshotConfig;
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
  readonly timeoutMs?: number;
  /** One peer walk, including chain admission, never gets more than 30 seconds. */
  readonly overallTimeoutMs?: number;
}

export class AuthorityIndexSnapshotUnavailableError extends AggregateError {
  readonly code = 'AUTHORITY_INDEX_SNAPSHOT_UNAVAILABLE';

  constructor(errors: readonly unknown[], readonly retryAfterMs: number) {
    super(errors, 'No configured trusted core supplied a usable authority index snapshot; retry later');
    this.name = 'AuthorityIndexSnapshotUnavailableError';
  }
}

type Status = 'not-ready' | 'invalid-request' | 'unavailable' | 'too-large' | 'busy' | 'above-range' | 'below-range';
const STATUSES: ReadonlySet<string> = new Set<Status>([
  'not-ready', 'invalid-request', 'unavailable', 'too-large', 'busy', 'above-range', 'below-range',
]);

export class AuthorityIndexSnapshotPeerStatusError extends Error {
  constructor(readonly peerId: string, readonly status: Status) {
    super(`Authority index core ${peerId} replied ${status}`);
    this.name = 'AuthorityIndexSnapshotPeerStatusError';
  }
}

/** Ordered, bounded failover; no discovery, multicast, or durable message outbox. */
export function createAuthorityIndexSnapshotClient(options: AuthorityIndexSnapshotClientOptions): {
  fetchSnapshot(
    request: ContextGraphAuthorityIndexSnapshotRequest,
    signal?: AbortSignal,
    validateSnapshot?: (snapshot: unknown, signal?: AbortSignal) => Promise<void>,
  ): Promise<unknown>;
} {
  const config = normalizeAuthorityIndexSnapshotConfig(options.config);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new Error('Authority index snapshot timeout must be an integer between 1 and 10000 ms');
  }
  const overallTimeoutMs = options.overallTimeoutMs ?? CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS;
  if (!Number.isSafeInteger(overallTimeoutMs) || overallTimeoutMs < 1
    || overallTimeoutMs > CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS) {
    throw new Error('Authority index snapshot overall timeout must be an integer between 1 and 30000 ms');
  }
  const cooldowns = new Map<string, { until: number; errors: readonly unknown[] }>();
  return Object.freeze({
    async fetchSnapshot(
      rawRequest: ContextGraphAuthorityIndexSnapshotRequest,
      signal?: AbortSignal,
      validateSnapshot?: (snapshot: unknown, signal?: AbortSignal) => Promise<void>,
    ) {
      signal?.throwIfAborted();
      const request = validateRequest(rawRequest, config.maxTailBlocks);
      const now = Date.now();
      for (const [scope, cooldown] of cooldowns) {
        if (cooldown.until <= now) cooldowns.delete(scope);
      }
      const cooldown = cooldowns.get(request.scope);
      if (cooldown) throw new AuthorityIndexSnapshotUnavailableError(cooldown.errors, cooldown.until - now);
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
        for (const peer of config.trustedCorePeers) {
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
              const snapshot = validateSnapshotEnvelope(response.snapshot, request);
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
        if (cooldowns.size >= MAX_COOLDOWN_SCOPES) cooldowns.delete(cooldowns.keys().next().value!);
        cooldowns.set(request.scope, { until: Date.now() + FAILURE_COOLDOWN_MS, errors: failures });
        throw new AuthorityIndexSnapshotUnavailableError(failures, FAILURE_COOLDOWN_MS);
      } finally {
        clearTimeout(overallTimer);
        signal?.removeEventListener('abort', forwardOverallAbort);
      }
    },
  });
}

const statusBytes = (status: Status): Uint8Array => encoder.encode(JSON.stringify({ version: 1, status }));

/**
 * Register only on cores with router.register(PROTOCOL..., handler,
 * {maxReadBytes: AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES}). This handler reads
 * the materialized cache only: a peer request must never start a historical scan.
 */
export function createAuthorityIndexSnapshotHandler(options: {
  readonly exportSnapshot: (request: ContextGraphAuthorityIndexSnapshotRequest) => Promise<unknown | null>;
}): (
  bytes: Uint8Array,
  peer?: unknown,
  options?: { signal?: AbortSignal },
) => Promise<Uint8Array> {
  let active = 0;
  // The router supplies the Noise-authenticated remote PeerID. Never use a
  // response/request field as this key. Stop admitting new identities at the
  // map bound until old windows expire, rather than evicting active limits.
  const peers = new Map<string, { until: number; count: number }>();
  return async (bytes, peer, handlerOptions) => {
    handlerOptions?.signal?.throwIfAborted();
    if (typeof peer === 'string') {
      const now = Date.now();
      for (const [id, entry] of peers) {
        if (entry.until <= now) peers.delete(id);
      }
      const entry = peers.get(peer);
      if (entry) {
        if (entry.count >= PEER_RATE_BURST) return statusBytes('busy');
        entry.count += 1;
      } else {
        if (peers.size >= MAX_RATE_LIMIT_PEERS) return statusBytes('busy');
        peers.set(peer, { until: now + PEER_RATE_WINDOW_MS, count: 1 });
      }
    }
    let request: ContextGraphAuthorityIndexSnapshotRequest;
    try {
      const envelope = record(parseBounded(bytes, AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES));
      if (!envelope || envelope.version !== 1 || !exactKeys(envelope, ['version', 'request'])) {
        return statusBytes('invalid-request');
      }
      request = validateRequest(envelope.request);
    } catch {
      return statusBytes('invalid-request');
    }
    if (active >= MAX_CONCURRENT_EXPORTS) return statusBytes('busy');
    active += 1;
    try {
      const snapshot = await options.exportSnapshot(request);
      handlerOptions?.signal?.throwIfAborted();
      if (snapshot === null) return statusBytes('not-ready');
      validateSnapshotEnvelope(snapshot, request);
      const response = encoder.encode(JSON.stringify({ version: 1, status: 'ok', snapshot }));
      return response.byteLength > AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES
        ? statusBytes('too-large')
        : response;
    } catch (error) {
      handlerOptions?.signal?.throwIfAborted();
      return statusBytes(error instanceof ContextGraphAuthorityIndexSnapshotExportError ? error.status : 'unavailable');
    } finally {
      active -= 1;
    }
  };
}
