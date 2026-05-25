import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  computeCatchupRequestDigest,
  mintSignedCatchupRequest,
  verifySignedCatchupRequest,
  CatchupReplayGuard,
  CATCHUP_REQUEST_MAX_AGE_MS,
} from '../../src/swm/host-catchup-sign.js';

const FIXED_NOW = 1_700_000_000_000;

async function mintWith(wallet: ethers.Wallet, overrides: Partial<{ contextGraphId: string; sinceSeqno: number; nonce: string; issuedAtMs: number }> = {}) {
  return mintSignedCatchupRequest({
    contextGraphId: overrides.contextGraphId ?? 'curator/cg-1',
    sinceSeqno: overrides.sinceSeqno ?? 0,
    maxEntries: 32,
    maxBytes: 64 * 1024,
    requesterEoa: wallet.address,
    issuedAtMs: overrides.issuedAtMs ?? FIXED_NOW,
    nonce: overrides.nonce,
    sign: async (digest) => wallet.signMessage(digest),
  });
}

describe('host-catchup-sign (B1: signed catchup requests)', () => {
  describe('mint + verify roundtrip', () => {
    it('accepts a well-formed signature within the freshness window', async () => {
      const wallet = ethers.Wallet.createRandom();
      const req = await mintWith(wallet);
      const result = verifySignedCatchupRequest(req, FIXED_NOW + 1000);
      expect(result.ok).toBe(true);
      expect(result.recoveredSigner).toBe(wallet.address.toLowerCase());
    });

    it('rejects a tampered contextGraphId (digest no longer matches)', async () => {
      const wallet = ethers.Wallet.createRandom();
      const req = await mintWith(wallet);
      const tampered = { ...req, contextGraphId: 'attacker/owned-cg' };
      const result = verifySignedCatchupRequest(tampered, FIXED_NOW);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/signer mismatch/i);
    });

    it('rejects a tampered sinceSeqno (digest no longer matches)', async () => {
      const wallet = ethers.Wallet.createRandom();
      const req = await mintWith(wallet, { sinceSeqno: 5 });
      const tampered = { ...req, sinceSeqno: 999 };
      const result = verifySignedCatchupRequest(tampered, FIXED_NOW);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/signer mismatch/i);
    });

    it('rejects a request signed by a different wallet than requesterEoa claims', async () => {
      const a = ethers.Wallet.createRandom();
      const b = ethers.Wallet.createRandom();
      const req = await mintWith(a);
      const swapped = { ...req, requesterEoa: b.address.toLowerCase() };
      const result = verifySignedCatchupRequest(swapped, FIXED_NOW);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/signer mismatch/i);
    });
  });

  describe('B1 round-2: requesterEoa derivation from signer', () => {
    it('discovery mode (no requesterEoa supplied) binds digest to recovered signer', async () => {
      const wallet = ethers.Wallet.createRandom();
      const req = await mintSignedCatchupRequest({
        contextGraphId: 'cg/x',
        sinceSeqno: 0,
        maxEntries: 32,
        maxBytes: 64 * 1024,
        // requesterEoa intentionally omitted
        issuedAtMs: FIXED_NOW,
        sign: async (digest) => wallet.signMessage(digest),
      });
      expect(req.requesterEoa).toBe(wallet.address.toLowerCase());
      const result = verifySignedCatchupRequest(req, FIXED_NOW + 1000);
      expect(result.ok).toBe(true);
    });

    it('throws when caller claims a requesterEoa that does not match the actual signer', async () => {
      const signing = ethers.Wallet.createRandom();
      const wrongClaim = ethers.Wallet.createRandom();
      await expect(
        mintSignedCatchupRequest({
          contextGraphId: 'cg/x',
          sinceSeqno: 0,
          maxEntries: 32,
          maxBytes: 64 * 1024,
          requesterEoa: wrongClaim.address,
          issuedAtMs: FIXED_NOW,
          sign: async (digest) => signing.signMessage(digest),
        }),
      ).rejects.toThrow(/does not match signature signer/i);
    });
  });

  describe('freshness window', () => {
    it('rejects requests older than CATCHUP_REQUEST_MAX_AGE_MS', async () => {
      const wallet = ethers.Wallet.createRandom();
      const req = await mintWith(wallet, { issuedAtMs: FIXED_NOW });
      const stale = verifySignedCatchupRequest(req, FIXED_NOW + CATCHUP_REQUEST_MAX_AGE_MS + 1);
      expect(stale.ok).toBe(false);
      expect(stale.reason).toMatch(/age/i);
    });

    it('rejects requests with future-skewed timestamps beyond the window', async () => {
      const wallet = ethers.Wallet.createRandom();
      const req = await mintWith(wallet, { issuedAtMs: FIXED_NOW + CATCHUP_REQUEST_MAX_AGE_MS + 2000 });
      const future = verifySignedCatchupRequest(req, FIXED_NOW);
      expect(future.ok).toBe(false);
      expect(future.reason).toMatch(/age/i);
    });

    it('accepts requests just inside the window boundary', async () => {
      const wallet = ethers.Wallet.createRandom();
      const req = await mintWith(wallet, { issuedAtMs: FIXED_NOW });
      const justInside = verifySignedCatchupRequest(req, FIXED_NOW + CATCHUP_REQUEST_MAX_AGE_MS - 1);
      expect(justInside.ok).toBe(true);
    });
  });

  describe('digest binding', () => {
    it('binds to maxEntries (so digest changes when client lies about caps)', () => {
      const base = {
        version: 2,
        contextGraphId: 'cg/x',
        sinceSeqno: 0,
        maxEntries: 32,
        maxBytes: 64 * 1024,
        requesterEoa: '0x' + 'a'.repeat(40),
        issuedAtMs: FIXED_NOW,
        nonce: '0x' + '00'.repeat(16),
      };
      const d1 = computeCatchupRequestDigest(base);
      const d2 = computeCatchupRequestDigest({ ...base, maxEntries: 999 });
      expect(Buffer.from(d1).toString('hex')).not.toBe(Buffer.from(d2).toString('hex'));
    });

    it('binds to nonce (so replay-defence can rely on it being signed)', () => {
      const base = {
        version: 2,
        contextGraphId: 'cg/x',
        sinceSeqno: 0,
        maxEntries: 32,
        maxBytes: 64 * 1024,
        requesterEoa: '0x' + 'a'.repeat(40),
        issuedAtMs: FIXED_NOW,
        nonce: '0x' + '00'.repeat(16),
      };
      const d1 = computeCatchupRequestDigest(base);
      const d2 = computeCatchupRequestDigest({ ...base, nonce: '0x' + 'ff'.repeat(16) });
      expect(Buffer.from(d1).toString('hex')).not.toBe(Buffer.from(d2).toString('hex'));
    });
  });

  describe('CatchupReplayGuard', () => {
    it('admits a fresh (eoa, nonce) pair', () => {
      const guard = new CatchupReplayGuard();
      expect(guard.recordIfFresh('0xabc', '0xnonce1', FIXED_NOW, FIXED_NOW)).toBe(true);
    });

    it('rejects a replay of the same (eoa, nonce) pair within the window', () => {
      const guard = new CatchupReplayGuard();
      guard.recordIfFresh('0xabc', '0xnonce1', FIXED_NOW, FIXED_NOW);
      expect(guard.recordIfFresh('0xabc', '0xnonce1', FIXED_NOW, FIXED_NOW + 1000)).toBe(false);
    });

    it('distinguishes by EOA (same nonce, different wallet → fresh)', () => {
      const guard = new CatchupReplayGuard();
      guard.recordIfFresh('0xabc', '0xnonce1', FIXED_NOW, FIXED_NOW);
      expect(guard.recordIfFresh('0xdef', '0xnonce1', FIXED_NOW, FIXED_NOW + 1000)).toBe(true);
    });

    it('evicts stale entries once they age beyond the freshness window', () => {
      const guard = new CatchupReplayGuard();
      guard.recordIfFresh('0xabc', '0xnonce1', FIXED_NOW, FIXED_NOW);
      // Advance wall-clock past freshness window and probe with a new
      // entry (which triggers eviction). The old nonce should now be
      // re-admittable.
      guard.recordIfFresh('0xabc', '0xnonce2', FIXED_NOW + CATCHUP_REQUEST_MAX_AGE_MS + 1000, FIXED_NOW + CATCHUP_REQUEST_MAX_AGE_MS + 1000);
      // Both old nonces have aged out; reusing nonce1 is now fresh because
      // the freshness check would also reject it independently. Confirm
      // the guard's internal book-keeping evicted it (size shrunk).
      // size = 1 (only nonce2 remains)
      expect(guard.size()).toBe(1);
    });

    it('caps memory: evicts oldest first when over the LRU max', () => {
      const guard = new CatchupReplayGuard(3);
      guard.recordIfFresh('0xa', '0xn1', FIXED_NOW, FIXED_NOW);
      guard.recordIfFresh('0xa', '0xn2', FIXED_NOW + 100, FIXED_NOW + 100);
      guard.recordIfFresh('0xa', '0xn3', FIXED_NOW + 200, FIXED_NOW + 200);
      guard.recordIfFresh('0xa', '0xn4', FIXED_NOW + 300, FIXED_NOW + 300);
      // n1 should be evicted; nonces n2..n4 should still reject as replays.
      expect(guard.recordIfFresh('0xa', '0xn1', FIXED_NOW, FIXED_NOW + 300)).toBe(true);
      expect(guard.recordIfFresh('0xa', '0xn4', FIXED_NOW + 300, FIXED_NOW + 400)).toBe(false);
    });
  });
});
