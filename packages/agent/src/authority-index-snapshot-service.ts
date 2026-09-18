// SPDX-License-Identifier: Apache-2.0

import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { ContextGraphAuthorityIndexSnapshotRequest } from '@origintrail-official/dkg-chain';

/** A bootstrap protocol: never resolve catalog/phonebook authority to serve it. */
export const PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT = '/dkg/10.0.0/authority-index-snapshot/1';
export const AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES = 2_048;
export const AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS = 8;
export const AUTHORITY_INDEX_SNAPSHOT_DEFAULT_MAX_TAIL_BLOCKS = 2_000;
const MAX_TAIL_BLOCKS = 10_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_EXPORTS = 4;
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
  if (!Number.isSafeInteger(maxTailBlocks) || maxTailBlocks < 50 || maxTailBlocks > MAX_TAIL_BLOCKS) {
    throw new Error('Authority index maxTailBlocks must be an integer between 50 and 10000');
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
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Authority index snapshot timeout must be an integer between 1 and 60000 ms');
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
      for (const peer of config.trustedCorePeers) {
        signal?.throwIfAborted();
        const attempt = new AbortController();
        const forwardAbort = () => attempt.abort(signal!.reason);
        signal?.addEventListener('abort', forwardAbort, { once: true });
        const timeout = setTimeout(() => attempt.abort(new Error('Authority index snapshot peer timeout')), timeoutMs);
        let onAttemptAbort: (() => void) | undefined;
        try {
          const aborted = new Promise<never>((_, reject) => {
            onAttemptAbort = () => reject(attempt.signal.reason);
            attempt.signal.addEventListener('abort', onAttemptAbort, { once: true });
          });
          const fetched = (async () => {
            const responseBytes = await options.request(peer, bytes, {
              signal: attempt.signal,
              timeoutMs,
              maxReadBytes: AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES,
              payloadReuse: 'single-use',
            });
            attempt.signal.throwIfAborted();
            const response = record(parseBounded(responseBytes, AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES));
            if (!response || response.version !== 1 || response.status !== 'ok'
              || !exactKeys(response, ['version', 'status', 'snapshot'])) {
              throw new Error('Authority index core snapshot unavailable or invalid response');
            }
            const snapshot = validateSnapshotEnvelope(response.snapshot, request);
            // Canonical hash/integrity errors must try the next trusted provider,
            // rather than leaving fallback outside the chain admission boundary.
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
          signal?.removeEventListener('abort', forwardAbort);
          if (onAttemptAbort) attempt.signal.removeEventListener('abort', onAttemptAbort);
        }
      }
      throw new AggregateError(failures, 'No configured trusted core supplied a usable authority index snapshot');
    },
  });
}

type Status = 'not-ready' | 'invalid-request' | 'unavailable' | 'too-large' | 'busy';
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
  return async (bytes, _peer, handlerOptions) => {
    handlerOptions?.signal?.throwIfAborted();
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
    } catch {
      handlerOptions?.signal?.throwIfAborted();
      return statusBytes('unavailable');
    } finally {
      active -= 1;
    }
  };
}
