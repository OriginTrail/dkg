// SPDX-License-Identifier: Apache-2.0

import {
  ContextGraphAuthorityIndexSnapshotExportError,
  normalizeContextGraphAuthorityIndexSnapshot,
  type ContextGraphAuthorityIndexSnapshotRequest,
} from '@origintrail-official/dkg-chain';
import {
  AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES,
  AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES,
  encoder,
  exactKeys,
  hasSnapshotEnvelopeKeys,
  parseBounded,
  record,
  validateRequest,
  type Status,
} from './authority-index-snapshot-wire.js';

const MAX_CONCURRENT_EXPORTS = 4;
const PEER_RATE_WINDOW_MS = 5_000;
const PEER_RATE_BURST = 4;
const MAX_RATE_LIMIT_PEERS = 1_024;

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
    // ProtocolRouter invokes handlers with the canonical `{toString, toBytes}`
    // PeerID model, never a bare string, so normalize before keying the window.
    // Object.prototype.toString is rejected: it would collapse every unkeyed
    // caller onto one shared bucket instead of leaving them unkeyed.
    const peerKey = typeof peer === 'string' ? peer
      : typeof peer === 'object' && peer !== null && peer.toString !== Object.prototype.toString
        ? String(peer)
        : undefined;
    // Without an authenticated identity there is no one to charge the window
    // to; such a request still passes under MAX_CONCURRENT_EXPORTS below.
    if (peerKey !== undefined && peerKey.length > 0) {
      const now = Date.now();
      for (const [id, entry] of peers) {
        if (entry.until <= now) peers.delete(id);
      }
      const entry = peers.get(peerKey);
      if (entry) {
        if (entry.count >= PEER_RATE_BURST) return statusBytes('busy');
        entry.count += 1;
      } else {
        if (peers.size >= MAX_RATE_LIMIT_PEERS) return statusBytes('busy');
        peers.set(peerKey, { until: now + PEER_RATE_WINDOW_MS, count: 1 });
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
      // Size first so the chain decoder's size rejection retains the wire's
      // specific too-large diagnostic instead of becoming unavailable.
      const response = encoder.encode(JSON.stringify({ version: 1, status: 'ok', snapshot }));
      if (response.byteLength > AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES) return statusBytes('too-large');
      const normalized = hasSnapshotEnvelopeKeys(snapshot)
        ? normalizeContextGraphAuthorityIndexSnapshot(snapshot, request)
        : undefined;
      if (normalized === undefined) return statusBytes('unavailable');
      const normalizedResponse = encoder.encode(JSON.stringify({ version: 1, status: 'ok', snapshot: normalized }));
      return normalizedResponse.byteLength > AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES
        ? statusBytes('too-large')
        : normalizedResponse;
    } catch (error) {
      handlerOptions?.signal?.throwIfAborted();
      return statusBytes(error instanceof ContextGraphAuthorityIndexSnapshotExportError ? error.status : 'unavailable');
    } finally {
      active -= 1;
    }
  };
}
