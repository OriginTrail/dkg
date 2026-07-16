/**
 * OT-RFC-59 changelog read-lane wire format (PROTOCOL_SYNC_CHANGELOG).
 *
 * A structured JSON request/response over the raw ProtocolRouter stream —
 * deliberately SEPARATE from the legacy `/dkg/10.0.2/sync` bare-N-Quads wire and
 * its `SyncRequestEnvelope`, which are left untouched. The delta round is:
 *   requester → { contextGraphId, sinceSeq, era } (+ the same signed-digest auth
 *   fields the legacy lane carries; added by the handler wiring, SC4)
 *   responder → one of:
 *     - `resync` : era mismatch / no cursor / rollback → requester full-syncs
 *     - `delta`  : a bounded page of change records + the changed graphs' content
 *     - `denied` : RFC-49 authorization failure (reuses the legacy deny sentinel)
 *
 * Two red-team-driven shape decisions (see RFC59-RESPONDER-PLAN.md):
 *  - Each record carries its own `seq`, so a requester that fails to apply one
 *    record (e.g. a poison/oversized graph) advances its cursor only to the last
 *    SUCCESSFULLY applied seq — never a permanent gap past an unapplied change.
 *  - Progress is the scanned-through `nextSeq`, never the record count: because
 *    `readChanges` is node-global, a page scoped to one CG can be validly empty
 *    while `headSeq ≫ sinceSeq`. The requester loops while `nextSeq < headSeq`.
 */
import { SYNC_ACCESS_DENIED_MARKER } from '../../dkg-agent-constants.js';

export interface ChangelogSyncRequest {
  /** The context graph this delta round is scoped to. */
  contextGraphId: string;
  /** Requester's last-applied seq for (peer, cg); 0 on first contact. */
  sinceSeq: number;
  /** Requester's cursor era; null on first contact. Mismatch ⇒ responder resyncs. */
  era: string | null;
  /** Max RAW change records the responder scans for this page. */
  limit: number;
}

export type ChangeOp = 'upsert' | 'drop';

export interface ChangelogDeltaRecord {
  /** The record's per-node seq — the unit of cursor advancement. */
  seq: number;
  /** Admitted, non-reserved graph URI. */
  graph: string;
  op: ChangeOp;
  /** N-Quads text of the graph's ADMITTED content. Present iff `op === 'upsert'`. */
  quads?: string;
}

export type ChangelogSyncResponse =
  | { kind: 'resync'; era: string; headSeq: number }
  | {
      kind: 'delta';
      era: string;
      headSeq: number;
      /** Highest raw seq scanned this page; requester advances toward it. */
      nextSeq: number;
      records: ChangelogDeltaRecord[];
    }
  | { kind: 'denied' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeChangelogRequest(req: ChangelogSyncRequest): Uint8Array {
  return encoder.encode(JSON.stringify(req));
}

export function decodeChangelogRequest(bytes: Uint8Array): ChangelogSyncRequest {
  const obj = parseJsonObject(decoder.decode(bytes), 'request');
  const contextGraphId = obj.contextGraphId;
  const sinceSeq = obj.sinceSeq;
  const era = obj.era;
  const limit = obj.limit;
  if (typeof contextGraphId !== 'string' || contextGraphId.length === 0) {
    throw new Error('ChangelogSyncRequest: contextGraphId must be a non-empty string');
  }
  if (!isNonNegInt(sinceSeq)) throw new Error('ChangelogSyncRequest: sinceSeq must be a non-negative integer');
  if (era !== null && typeof era !== 'string') throw new Error('ChangelogSyncRequest: era must be a string or null');
  if (!isPosInt(limit)) throw new Error('ChangelogSyncRequest: limit must be a positive integer');
  // Preserve any extra fields (SC4 rides the signed-digest auth here) verbatim.
  return { ...(obj as Record<string, unknown>), contextGraphId, sinceSeq, era, limit } as ChangelogSyncRequest;
}

export function encodeChangelogResponse(resp: ChangelogSyncResponse): Uint8Array {
  // Denial reuses the legacy deny sentinel string so the requester's existing
  // deny classifier is shared — it is NOT valid JSON, hence the decode-side
  // sentinel check must run BEFORE JSON.parse.
  if (resp.kind === 'denied') return encoder.encode(SYNC_ACCESS_DENIED_MARKER);
  return encoder.encode(JSON.stringify(resp));
}

export function decodeChangelogResponse(bytes: Uint8Array): ChangelogSyncResponse {
  const text = decoder.decode(bytes);
  if (text === SYNC_ACCESS_DENIED_MARKER) return { kind: 'denied' };
  const obj = parseJsonObject(text, 'response');
  if (obj.kind === 'resync') {
    return { kind: 'resync', era: asString(obj.era, 'era'), headSeq: asNonNegInt(obj.headSeq, 'headSeq') };
  }
  if (obj.kind === 'delta') {
    const era = asString(obj.era, 'era');
    const headSeq = asNonNegInt(obj.headSeq, 'headSeq');
    const nextSeq = asNonNegInt(obj.nextSeq, 'nextSeq');
    if (!Array.isArray(obj.records)) throw new Error('ChangelogSyncResponse.delta: records must be an array');
    const records = obj.records.map((r, i) => decodeRecord(r, i));
    // Cursor invariants — defend against a buggy/malicious responder that could
    // otherwise wedge or over-advance the requester's cursor: the scan cannot
    // exceed the head, records ascend strictly and stay within the head, and
    // nextSeq covers every emitted record.
    if (nextSeq > headSeq) {
      throw new Error(`ChangelogSyncResponse.delta: nextSeq ${nextSeq} > headSeq ${headSeq}`);
    }
    let prev = 0;
    for (const rec of records) {
      if (rec.seq > headSeq) throw new Error(`ChangelogSyncResponse.delta: record seq ${rec.seq} > headSeq ${headSeq}`);
      if (rec.seq <= prev) throw new Error(`ChangelogSyncResponse.delta: records not strictly ascending (${prev} → ${rec.seq})`);
      prev = rec.seq;
    }
    if (records.length > 0 && records[records.length - 1].seq > nextSeq) {
      throw new Error(`ChangelogSyncResponse.delta: nextSeq ${nextSeq} < last record seq ${records[records.length - 1].seq}`);
    }
    return { kind: 'delta', era, headSeq, nextSeq, records };
  }
  throw new Error(`ChangelogSyncResponse: unknown kind ${JSON.stringify(obj.kind)}`);
}

function decodeRecord(r: unknown, i: number): ChangelogDeltaRecord {
  if (r === null || typeof r !== 'object') throw new Error(`ChangelogDeltaRecord[${i}]: not an object`);
  const o = r as Record<string, unknown>;
  const seq = o.seq;
  const graph = o.graph;
  const op = o.op;
  if (!isPosInt(seq)) throw new Error(`ChangelogDeltaRecord[${i}]: seq must be a positive integer`);
  if (typeof graph !== 'string' || graph.length === 0) throw new Error(`ChangelogDeltaRecord[${i}]: graph must be a non-empty string`);
  if (op !== 'upsert' && op !== 'drop') throw new Error(`ChangelogDeltaRecord[${i}]: op must be 'upsert' | 'drop'`);
  if (op === 'upsert') {
    if (typeof o.quads !== 'string') throw new Error(`ChangelogDeltaRecord[${i}]: upsert requires quads text`);
    return { seq, graph, op, quads: o.quads };
  }
  return { seq, graph, op };
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Changelog ${what}: not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Changelog ${what}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function asString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`Changelog response: ${field} must be a non-empty string`);
  return v;
}
function asNonNegInt(v: unknown, field: string): number {
  if (!isNonNegInt(v)) throw new Error(`Changelog response: ${field} must be a non-negative integer`);
  return v;
}
