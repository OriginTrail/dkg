/**
 * OT-RFC-59 changelog read-lane wire codec tests (SC2).
 * Round-trips + the two red-team-driven guarantees: per-record `seq` survives,
 * and the deny sentinel is recognised BEFORE JSON.parse (it is not valid JSON).
 */
import { describe, it, expect } from 'vitest';
import {
  encodeChangelogRequest,
  decodeChangelogRequest,
  encodeChangelogResponse,
  decodeChangelogResponse,
  type ChangelogSyncRequest,
  type ChangelogSyncResponse,
} from '../src/sync/changelog/wire.js';
import { SYNC_ACCESS_DENIED_MARKER } from '../src/dkg-agent-constants.js';

const REQ: ChangelogSyncRequest = {
  contextGraphId: 'did:dkg:context-graph:0xabc',
  sinceSeq: 41,
  era: 'e3b0c442-98fc-1c14-9afb-4c8996fb9242',
  limit: 500,
};

describe('changelog wire — request', () => {
  it('round-trips the core fields', () => {
    expect(decodeChangelogRequest(encodeChangelogRequest(REQ))).toMatchObject(REQ);
  });

  it('preserves extra fields verbatim (SC4 rides signed-digest auth on this JSON)', () => {
    const withAuth = { ...REQ, requesterPeerId: '12D3Koo', requesterSignatureR: '0xdead' };
    const out = decodeChangelogRequest(encodeChangelogRequest(withAuth as ChangelogSyncRequest));
    expect((out as Record<string, unknown>).requesterPeerId).toBe('12D3Koo');
    expect((out as Record<string, unknown>).requesterSignatureR).toBe('0xdead');
  });

  it('accepts era=null and sinceSeq=0 (first contact)', () => {
    const first = decodeChangelogRequest(encodeChangelogRequest({ ...REQ, era: null, sinceSeq: 0 }));
    expect(first.era).toBeNull();
    expect(first.sinceSeq).toBe(0);
  });

  it('rejects malformed requests', () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(() => decodeChangelogRequest(enc({ ...REQ, contextGraphId: '' }))).toThrow(/contextGraphId/);
    expect(() => decodeChangelogRequest(enc({ ...REQ, sinceSeq: -1 }))).toThrow(/sinceSeq/);
    expect(() => decodeChangelogRequest(enc({ ...REQ, limit: 0 }))).toThrow(/limit/);
    expect(() => decodeChangelogRequest(enc({ ...REQ, era: 5 }))).toThrow(/era/);
    expect(() => decodeChangelogRequest(new TextEncoder().encode('not json'))).toThrow(/not valid JSON/);
  });
});

describe('changelog wire — response', () => {
  it('round-trips a resync', () => {
    const r: ChangelogSyncResponse = { kind: 'resync', era: 'era-1', headSeq: 900 };
    expect(decodeChangelogResponse(encodeChangelogResponse(r))).toEqual(r);
  });

  it('round-trips a delta preserving per-record seq, upsert quads, and drop', () => {
    const r: ChangelogSyncResponse = {
      kind: 'delta',
      era: 'era-1',
      headSeq: 140,
      nextSeq: 140,
      records: [
        { seq: 101, graph: 'did:dkg:context-graph:0xabc/1', op: 'upsert', quads: '<s> <p> "o" <g> .' },
        { seq: 137, graph: 'did:dkg:context-graph:0xabc/2', op: 'drop' },
      ],
    };
    const out = decodeChangelogResponse(encodeChangelogResponse(r));
    expect(out).toEqual(r);
    // seq is the load-bearing field for partial-apply cursor advancement.
    if (out.kind === 'delta') {
      expect(out.records.map((x) => x.seq)).toEqual([101, 137]);
      expect(out.records[1].quads).toBeUndefined();
    }
  });

  it('encodes denial to the legacy sentinel and decodes it WITHOUT JSON.parse', () => {
    const bytes = encodeChangelogResponse({ kind: 'denied' });
    expect(new TextDecoder().decode(bytes)).toBe(SYNC_ACCESS_DENIED_MARKER); // not JSON
    expect(decodeChangelogResponse(bytes)).toEqual({ kind: 'denied' });
  });

  it('rejects malformed responses', () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(() => decodeChangelogResponse(enc({ kind: 'delta', era: 'e', headSeq: 1, nextSeq: 1, records: [{ graph: 'g', op: 'upsert', quads: '' }] }))).toThrow(/seq/);
    expect(() => decodeChangelogResponse(enc({ kind: 'delta', era: 'e', headSeq: 1, nextSeq: 1, records: [{ seq: 1, graph: 'g', op: 'upsert' }] }))).toThrow(/quads/);
    expect(() => decodeChangelogResponse(enc({ kind: 'bogus' }))).toThrow(/unknown kind/);
    expect(() => decodeChangelogResponse(enc({ kind: 'resync', era: '', headSeq: 1 }))).toThrow(/era/);
  });
});
