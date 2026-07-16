import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  encodeSwmHostCatchupRequest,
  encodeSwmHostCatchupResponse,
  decodeSwmHostCatchupRequest,
  decodeSwmHostCatchupResponse,
  SWM_HOST_CATCHUP_WIRE_VERSION,
} from '../../src/swm/host-catchup-wire.js';
import {
  computeCatchupRequestDigest,
  mintSignedCatchupRequest,
} from '../../src/swm/host-catchup-sign.js';

const SIG_FILLER = '0x' + 'aa'.repeat(65); // shape-valid 65-byte hex (won't verify, but encode/decode only)
const NONCE_FILLER = '0x' + '00'.repeat(16);

async function buildSignedRequestWith(wallet: ethers.Wallet, opts: { sinceSeqno?: number; cgId?: string } = {}) {
  return mintSignedCatchupRequest({
    contextGraphId: opts.cgId ?? 'curator/cg-1',
    sinceSeqno: opts.sinceSeqno ?? 0,
    maxEntries: 32,
    maxBytes: 64 * 1024,
    requesterEoa: wallet.address,
    sign: async (digest) => wallet.signMessage(digest),
  });
}

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
      const malformed = new TextEncoder().encode(`{"version":${SWM_HOST_CATCHUP_WIRE_VERSION},"contextGraphId":"c/g","nextSeqno":1e999,"truncated":false,"entries":[]}`);
      expect(() => decodeSwmHostCatchupResponse(malformed)).toThrow(/invalid nextSeqno/i);
    });
  });

  describe('request encode/decode roundtrip (B1: signed requests)', () => {
    it('encodes and decodes a well-formed signed request', async () => {
      const wallet = ethers.Wallet.createRandom();
      const signed = await buildSignedRequestWith(wallet);
      const wire = encodeSwmHostCatchupRequest({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: 'curator/cg-1',
        sinceSeqno: 0,
        maxEntries: 32,
        maxBytes: 64 * 1024,
        requesterEoa: signed.requesterEoa,
        issuedAtMs: signed.issuedAtMs,
        nonce: signed.nonce,
        sig: signed.sig,
      });
      expect(wire.byteLength).toBeGreaterThan(0);
      const decoded = decodeSwmHostCatchupRequest(wire);
      expect(decoded.contextGraphId).toBe('curator/cg-1');
      expect(decoded.sinceSeqno).toBe(0);
      expect(decoded.requesterEoa).toBe(wallet.address.toLowerCase());
      expect(decoded.sig).toBe(signed.sig);
    });

    it('rejects request missing requesterEoa', () => {
      const malformed = new TextEncoder().encode(JSON.stringify({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: 'curator/cg-1',
        sinceSeqno: 0,
        issuedAtMs: Date.now(),
        nonce: NONCE_FILLER,
        sig: SIG_FILLER,
      }));
      expect(() => decodeSwmHostCatchupRequest(malformed)).toThrow(/requesterEoa/);
    });

    it('rejects request with malformed sig (wrong length)', () => {
      const malformed = new TextEncoder().encode(JSON.stringify({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: 'curator/cg-1',
        sinceSeqno: 0,
        requesterEoa: '0x' + 'a'.repeat(40),
        issuedAtMs: Date.now(),
        nonce: NONCE_FILLER,
        sig: '0xdeadbeef',
      }));
      expect(() => decodeSwmHostCatchupRequest(malformed)).toThrow(/sig/);
    });

    it('rejects request with malformed nonce (wrong length)', () => {
      const malformed = new TextEncoder().encode(JSON.stringify({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: 'curator/cg-1',
        sinceSeqno: 0,
        requesterEoa: '0x' + 'a'.repeat(40),
        issuedAtMs: Date.now(),
        nonce: '0xdead',
        sig: SIG_FILLER,
      }));
      expect(() => decodeSwmHostCatchupRequest(malformed)).toThrow(/nonce/);
    });

    it('rejects v1 (legacy unsigned) requests — hard cutover', () => {
      const v1 = new TextEncoder().encode(JSON.stringify({
        version: 1,
        contextGraphId: 'curator/cg-1',
        sinceSeqno: 0,
      }));
      expect(() => decodeSwmHostCatchupRequest(v1)).toThrow(/version/i);
    });
  });

  describe('digest determinism', () => {
    it('produces identical digests for identical fields across runs', () => {
      const fields = {
        version: 2,
        contextGraphId: 'curator/cg-determinism',
        sinceSeqno: 7,
        maxEntries: 32,
        maxBytes: 64 * 1024,
        requesterEoa: '0x' + 'a'.repeat(40),
        issuedAtMs: 1_700_000_000_000,
        nonce: '0x' + '01'.repeat(16),
      };
      const d1 = computeCatchupRequestDigest(fields);
      const d2 = computeCatchupRequestDigest(fields);
      expect(Buffer.from(d1).toString('hex')).toBe(Buffer.from(d2).toString('hex'));
    });

    it('produces different digests when contextGraphId differs', () => {
      const base = {
        version: 2,
        contextGraphId: 'curator/cg-a',
        sinceSeqno: 0,
        maxEntries: 32,
        maxBytes: 64 * 1024,
        requesterEoa: '0x' + 'a'.repeat(40),
        issuedAtMs: 1_700_000_000_000,
        nonce: '0x' + '01'.repeat(16),
      };
      const d1 = computeCatchupRequestDigest(base);
      const d2 = computeCatchupRequestDigest({ ...base, contextGraphId: 'curator/cg-b' });
      expect(Buffer.from(d1).toString('hex')).not.toBe(Buffer.from(d2).toString('hex'));
    });
  });
});
