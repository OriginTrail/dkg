import { describe, it, expect } from 'vitest';
import {
  MARKETPLACE_CONTEXT_GRAPH,
  MARKETPLACE_SERVE_VERSION,
  PROTOCOL_MARKETPLACE_QUOTE,
  PROTOCOL_MARKETPLACE_SERVE,
  encodeMarketplaceQuoteRequest,
  decodeMarketplaceQuoteRequest,
  encodeMarketplaceQuoteResponse,
  decodeMarketplaceQuoteResponse,
  encodeMarketplaceServeRequest,
  decodeMarketplaceServeRequest,
  encodeMarketplaceServeResponse,
  decodeMarketplaceServeResponse,
  type MarketplaceServeRequestMsg,
  type MarketplaceServeResponseMsg,
} from '../../src/index.js';

function patternBytes(n: number, seed = 0): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = (i + seed) % 256;
  return buf;
}

describe('marketplace protocol constants', () => {
  it('pins the OT-RFC-27 protocol ids on the Messenger 10.0.1 prefix', () => {
    expect(PROTOCOL_MARKETPLACE_QUOTE).toBe('/dkg/10.0.1/marketplace-quote');
    expect(PROTOCOL_MARKETPLACE_SERVE).toBe('/dkg/10.0.1/marketplace-serve');
    expect(MARKETPLACE_CONTEXT_GRAPH).toBe('marketplace');
  });
});

describe('MarketplaceQuoteRequest encode/decode', () => {
  it('round-trips the offering id', () => {
    const offeringId = patternBytes(32, 7);
    const decoded = decodeMarketplaceQuoteRequest(
      encodeMarketplaceQuoteRequest({ offeringId }),
    );
    expect(new Uint8Array(decoded.offeringId)).toEqual(offeringId);
  });
});

describe('MarketplaceQuoteResponse encode/decode', () => {
  it('round-trips an available quote with a > 2^53 wei ask kept exact', () => {
    // 1 TRAC/unit = 1e18 wei — far beyond Number.MAX_SAFE_INTEGER, which
    // is exactly why asks cross the wire as decimal strings.
    const decoded = decodeMarketplaceQuoteResponse(
      encodeMarketplaceQuoteResponse({
        available: true,
        askPerUnitWei: '1000000000000000001',
        capacityUnitsPerMin: 60_000n,
      }),
    );
    expect(decoded.available).toBe(true);
    expect(decoded.askPerUnitWei).toBe('1000000000000000001');
    expect(BigInt(decoded.askPerUnitWei!)).toBe(1_000_000_000_000_000_001n);
    expect(Number(decoded.capacityUnitsPerMin)).toBe(60_000);
    expect(decoded.declineCode).toBeUndefined();
  });

  it('round-trips a decline with the quote fields unset', () => {
    const decoded = decodeMarketplaceQuoteResponse(
      encodeMarketplaceQuoteResponse({
        available: false,
        declineCode: 'AT_CAPACITY',
      }),
    );
    expect(decoded.available).toBe(false);
    expect(decoded.declineCode).toBe('AT_CAPACITY');
    expect(decoded.askPerUnitWei).toBeUndefined();
    expect(Number(decoded.capacityUnitsPerMin)).toBe(0);
  });
});

describe('MarketplaceServeRequest encode/decode', () => {
  const request: MarketplaceServeRequestMsg = {
    version: MARKETPLACE_SERVE_VERSION,
    buyer: patternBytes(20, 1),
    sellerIdentityId: '4722366482869645213695', // max uint72, decimal
    offeringId: patternBytes(32, 2),
    callId: patternBytes(32, 3),
    epoch: 42n,
    maxUnits: 5_000n,
    askPerUnitWei: '500000000000',
    expiry: 1_767_225_600n, // uint40-range unix seconds
    authSignature: patternBytes(65, 4),
    payloadKind: 'inference',
    payload: new TextEncoder().encode('{"prompt":"hello marketplace"}'),
  };

  it('round-trips every authorization field (bigint uint64s normalize to number)', () => {
    const decoded = decodeMarketplaceServeRequest(encodeMarketplaceServeRequest(request));
    expect(decoded.version).toBe(MARKETPLACE_SERVE_VERSION);
    expect(new Uint8Array(decoded.buyer)).toEqual(request.buyer);
    expect(decoded.sellerIdentityId).toBe('4722366482869645213695');
    expect(BigInt(decoded.sellerIdentityId)).toBe(2n ** 72n - 1n);
    expect(new Uint8Array(decoded.offeringId)).toEqual(request.offeringId);
    expect(new Uint8Array(decoded.callId)).toEqual(request.callId);
    expect(Number(decoded.epoch)).toBe(42);
    expect(Number(decoded.maxUnits)).toBe(5_000);
    expect(decoded.askPerUnitWei).toBe('500000000000');
    expect(Number(decoded.expiry)).toBe(1_767_225_600);
    expect(new Uint8Array(decoded.authSignature)).toEqual(request.authSignature);
    expect(decoded.payloadKind).toBe('inference');
    expect(new TextDecoder().decode(decoded.payload)).toBe('{"prompt":"hello marketplace"}');
  });

  it('preserves byte-field lengths (address 20, ids 32, signature 65)', () => {
    const decoded = decodeMarketplaceServeRequest(encodeMarketplaceServeRequest(request));
    expect(decoded.buyer.length).toBe(20);
    expect(decoded.offeringId.length).toBe(32);
    expect(decoded.callId.length).toBe(32);
    expect(decoded.authSignature.length).toBe(65);
  });
});

describe('MarketplaceServeResponse encode/decode', () => {
  it('round-trips a success with the full receipt', () => {
    const response: MarketplaceServeResponseMsg = {
      ok: true,
      servedUnits: 1_234n,
      // 1234 units · 5e11 wei/unit — exact as a string, lossy as a float.
      receiptValueWei: '617000000000000',
      resultCommitment: patternBytes(32, 5),
      sellerSignature: patternBytes(65, 6),
      result: new TextEncoder().encode('{"completion":"ok"}'),
      authDigest: patternBytes(32, 8),
    };
    const decoded = decodeMarketplaceServeResponse(encodeMarketplaceServeResponse(response));
    expect(decoded.ok).toBe(true);
    expect(decoded.errorCode).toBeUndefined();
    expect(Number(decoded.servedUnits)).toBe(1_234);
    expect(BigInt(decoded.receiptValueWei!)).toBe(617_000_000_000_000n);
    expect(new Uint8Array(decoded.resultCommitment!)).toEqual(response.resultCommitment!);
    expect(new Uint8Array(decoded.sellerSignature!)).toEqual(response.sellerSignature!);
    expect(new TextDecoder().decode(decoded.result!)).toBe('{"completion":"ok"}');
    expect(new Uint8Array(decoded.authDigest!)).toEqual(response.authDigest!);
  });

  it('round-trips a failure with only ok + errorCode set', () => {
    const decoded = decodeMarketplaceServeResponse(
      encodeMarketplaceServeResponse({ ok: false, errorCode: 'BAD_AUTH' }),
    );
    expect(decoded.ok).toBe(false);
    expect(decoded.errorCode).toBe('BAD_AUTH');
    expect(Number(decoded.servedUnits)).toBe(0);
    expect(decoded.receiptValueWei).toBeUndefined();
    expect(decoded.resultCommitment!.length).toBe(0);
    expect(decoded.sellerSignature!.length).toBe(0);
    expect(decoded.result!.length).toBe(0);
    expect(decoded.authDigest!.length).toBe(0);
  });
});
