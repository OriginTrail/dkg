/**
 * OT-RFC-38 LU-6 — wire format for /dkg/10.0.1/swm-host-catchup.
 *
 * Members call this against any peer (typically a core) that's
 * known to host the curated CG's encrypted SWM substrate. The
 * responder serves opaque envelope bytes from {@link
 * SwmHostModeStore} starting strictly after the requested seqno.
 * The member then re-feeds each envelope through its local
 * {@link SharedMemoryHandler} so the existing Sender-Key decrypt
 * path runs verbatim.
 *
 * Wire format is JSON over the universal Messenger substrate
 * (envelope-versioned, dedup'd, idempotent). The bytes are small
 * (one request per catchup, response capped by `maxEntries`/byte
 * caps) so the protobuf-vs-JSON cost is negligible; JSON keeps
 * the wire schema visible in tests and devnet logs and avoids
 * adding another protobuf descriptor to the build.
 *
 * Request schema:
 *   {
 *     version: 1,
 *     contextGraphId: string,
 *     sinceSeqno: number (0 means "all entries"),
 *     maxEntries?: number (default DEFAULT_MAX_ENTRIES, hard-capped at MAX_MAX_ENTRIES),
 *     maxBytes?: number   (default DEFAULT_MAX_BYTES, hard-capped at MAX_MAX_BYTES)
 *   }
 *
 * Response schema:
 *   {
 *     version: 1,
 *     contextGraphId: string,
 *     nextSeqno: number,    // largest seqno returned, or sinceSeqno when empty
 *     truncated: boolean,   // true if more entries exist beyond what we returned
 *     denied?: string,      // human-readable denial reason; entries empty when set
 *     entries: [{ seqno: number, timestampMs: number, envelopeB64: string }]
 *   }
 *
 * Denial vs empty:
 *   - `denied` is set when the responder is unwilling/unable to serve
 *     (CG unknown, requester not authorised, host mode disabled). The
 *     requester treats this as a terminal failure for this peer.
 *   - `entries.length === 0` with `denied` unset is a *valid empty*
 *     response — the requester is up-to-date relative to this host,
 *     or the host has nothing for that CG.
 */

export const SWM_HOST_CATCHUP_WIRE_VERSION = 1;

export const DEFAULT_MAX_ENTRIES = 256;
export const MAX_MAX_ENTRIES = 1024;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_MAX_BYTES = 16 * 1024 * 1024;

export interface SwmHostCatchupRequest {
  version: number;
  contextGraphId: string;
  sinceSeqno: number;
  maxEntries?: number;
  maxBytes?: number;
}

export interface SwmHostCatchupResponseEntry {
  seqno: number;
  timestampMs: number;
  envelopeB64: string;
}

export interface SwmHostCatchupResponse {
  version: number;
  contextGraphId: string;
  nextSeqno: number;
  truncated: boolean;
  denied?: string;
  entries: SwmHostCatchupResponseEntry[];
}

export function encodeSwmHostCatchupRequest(req: SwmHostCatchupRequest): Uint8Array {
  if (!Number.isFinite(req.sinceSeqno) || req.sinceSeqno < 0) {
    throw new Error('sinceSeqno must be a finite non-negative number');
  }
  if (!req.contextGraphId) {
    throw new Error('contextGraphId is required');
  }
  const normalized: SwmHostCatchupRequest = {
    version: SWM_HOST_CATCHUP_WIRE_VERSION,
    contextGraphId: req.contextGraphId,
    sinceSeqno: Math.floor(req.sinceSeqno),
    ...(req.maxEntries !== undefined ? { maxEntries: clamp(req.maxEntries, 1, MAX_MAX_ENTRIES) } : {}),
    ...(req.maxBytes !== undefined ? { maxBytes: clamp(req.maxBytes, 1, MAX_MAX_BYTES) } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(normalized));
}

export function decodeSwmHostCatchupRequest(bytes: Uint8Array): SwmHostCatchupRequest {
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text) as Partial<SwmHostCatchupRequest>;
  if (parsed.version !== SWM_HOST_CATCHUP_WIRE_VERSION) {
    throw new Error(`Unsupported SwmHostCatchup request version: ${parsed.version}`);
  }
  if (typeof parsed.contextGraphId !== 'string' || parsed.contextGraphId.length === 0) {
    throw new Error('SwmHostCatchup request missing contextGraphId');
  }
  if (typeof parsed.sinceSeqno !== 'number' || !Number.isFinite(parsed.sinceSeqno) || parsed.sinceSeqno < 0) {
    throw new Error('SwmHostCatchup request has invalid sinceSeqno');
  }
  return {
    version: SWM_HOST_CATCHUP_WIRE_VERSION,
    contextGraphId: parsed.contextGraphId,
    sinceSeqno: Math.floor(parsed.sinceSeqno),
    ...(parsed.maxEntries !== undefined ? { maxEntries: clamp(parsed.maxEntries, 1, MAX_MAX_ENTRIES) } : {}),
    ...(parsed.maxBytes !== undefined ? { maxBytes: clamp(parsed.maxBytes, 1, MAX_MAX_BYTES) } : {}),
  };
}

export function encodeSwmHostCatchupResponse(resp: SwmHostCatchupResponse): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(resp));
}

export function decodeSwmHostCatchupResponse(bytes: Uint8Array): SwmHostCatchupResponse {
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text) as Partial<SwmHostCatchupResponse>;
  if (parsed.version !== SWM_HOST_CATCHUP_WIRE_VERSION) {
    throw new Error(`Unsupported SwmHostCatchup response version: ${parsed.version}`);
  }
  if (typeof parsed.contextGraphId !== 'string') {
    throw new Error('SwmHostCatchup response missing contextGraphId');
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  for (const entry of entries) {
    if (typeof entry.seqno !== 'number' || typeof entry.timestampMs !== 'number' || typeof entry.envelopeB64 !== 'string') {
      throw new Error('SwmHostCatchup response entry is malformed');
    }
  }
  // Codex PR #610 round-2 #9: harden `nextSeqno` decoding. A
  // malformed or hostile host could return non-numeric / negative /
  // NaN values; without validation the bare `Number(...)` coerced
  // them silently and the next pagination round throwed inside
  // `encodeSwmHostCatchupRequest`'s `sinceSeqno` validation —
  // surfacing as an opaque encode error far from the source.
  // Validate at the decode boundary instead.
  const rawNextSeqno = (parsed as { nextSeqno?: unknown }).nextSeqno;
  const nextSeqnoNum = typeof rawNextSeqno === 'number' ? rawNextSeqno : Number(rawNextSeqno ?? 0);
  if (!Number.isFinite(nextSeqnoNum) || nextSeqnoNum < 0 || !Number.isInteger(nextSeqnoNum)) {
    throw new Error(`SwmHostCatchup response has invalid nextSeqno: ${String(rawNextSeqno)}`);
  }
  return {
    version: SWM_HOST_CATCHUP_WIRE_VERSION,
    contextGraphId: parsed.contextGraphId,
    nextSeqno: nextSeqnoNum,
    truncated: Boolean(parsed.truncated),
    ...(typeof parsed.denied === 'string' ? { denied: parsed.denied } : {}),
    entries: entries as SwmHostCatchupResponseEntry[],
  };
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(value)));
}
