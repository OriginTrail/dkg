import { describe, it, expect } from 'vitest';
import {
  encodeSwmHostCatchupRequest,
  encodeSwmHostCatchupResponse,
  decodeSwmHostCatchupResponse,
  SWM_HOST_CATCHUP_WIRE_VERSION,
} from '../../src/swm/host-catchup-wire.js';

describe('SwmHostCatchup wire (PR #610 round-2 Codex follow-ups)', () => {
  describe('decode: nextSeqno validation (#9)', () => {
    it('accepts well-formed non-negative integer nextSeqno', () => {
      const wire = encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: 'curator/cg-1',
        nextSeqno: 42,
        truncated: false,
        entries: [],
      });
      const decoded = decodeSwmHostCatchupResponse(wire);
      expect(decoded.nextSeqno).toBe(42);
    });

    it('accepts 0 nextSeqno (caller is up-to-date)', () => {
      const wire = encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: 'curator/cg-1',
        nextSeqno: 0,
        truncated: false,
        entries: [],
      });
      const decoded = decodeSwmHostCatchupResponse(wire);
      expect(decoded.nextSeqno).toBe(0);
    });

    it('rejects negative nextSeqno (hostile peer)', () => {
      const malformed = new TextEncoder().encode(JSON.stringify({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: 'curator/cg-1',
        nextSeqno: -5,
        truncated: false,
        entries: [],
      }));
      expect(() => decodeSwmHostCatchupResponse(malformed)).toThrow(/invalid nextSeqno/i);
    });

    it('rejects NaN nextSeqno', () => {
      const malformed = new TextEncoder().encode(JSON.stringify({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: 'curator/cg-1',
        nextSeqno: 'not-a-number',
        truncated: false,
        entries: [],
      }));
      expect(() => decodeSwmHostCatchupResponse(malformed)).toThrow(/invalid nextSeqno/i);
    });

    it('rejects fractional nextSeqno (only integers are valid seqnos)', () => {
      const malformed = new TextEncoder().encode(JSON.stringify({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: 'curator/cg-1',
        nextSeqno: 3.14,
        truncated: false,
        entries: [],
      }));
      expect(() => decodeSwmHostCatchupResponse(malformed)).toThrow(/invalid nextSeqno/i);
    });

    it('rejects Infinity nextSeqno', () => {
      const malformed = new TextEncoder().encode(`{"version":1,"contextGraphId":"c/g","nextSeqno":1e999,"truncated":false,"entries":[]}`);
      expect(() => decodeSwmHostCatchupResponse(malformed)).toThrow(/invalid nextSeqno/i);
    });
  });

  describe('request encode/decode roundtrip', () => {
    it('encodes a well-formed request', () => {
      const wire = encodeSwmHostCatchupRequest({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: 'curator/cg-1',
        sinceSeqno: 0,
        maxEntries: 32,
      });
      expect(wire.byteLength).toBeGreaterThan(0);
      // The body is JSON; should be parseable.
      const parsed = JSON.parse(new TextDecoder().decode(wire));
      expect(parsed.contextGraphId).toBe('curator/cg-1');
      expect(parsed.sinceSeqno).toBe(0);
    });
  });
});
