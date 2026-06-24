import { describe, it, expect } from 'vitest';
import {
  MockPaymentVerifier,
  parsePrice,
  amountGte,
  parseXPaymentHeader,
  encodeXPaymentHeader,
  build402Body,
  resolvePayment,
  X402_VERSION,
  type PaymentPayload,
} from '../src/daemon/payment.js';

const REQ = {
  network: 'base-sepolia',
  payTo: '0x1111111111111111111111111111111111111111',
  resource: '/api/answer',
  nonce: 'nonce-1',
};

function payload(over: Partial<PaymentPayload> = {}): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    scheme: 'exact',
    network: 'base-sepolia',
    asset: 'USDC',
    amount: '0.01',
    payTo: REQ.payTo,
    nonce: 'nonce-1',
    from: '0x2222222222222222222222222222222222222222',
    ...over,
  };
}

describe('dRAG payment — parsing helpers', () => {
  it('parsePrice accepts "<amount> <ASSET>" and normalises the asset', () => {
    expect(parsePrice('0.01 USDC')).toEqual({ amount: '0.01', asset: 'USDC' });
    expect(parsePrice('5 trac')).toEqual({ amount: '5', asset: 'TRAC' });
  });
  it('parsePrice rejects malformed / non-positive prices', () => {
    expect(parsePrice('USDC')).toBeNull();
    expect(parsePrice('0.01')).toBeNull();
    expect(parsePrice('-1 USDC')).toBeNull();
    expect(parsePrice('0 USDC')).toBeNull();
    expect(parsePrice('abc USDC')).toBeNull();
  });
  it('amountGte compares decimal strings', () => {
    expect(amountGte('0.02', '0.01')).toBe(true);
    expect(amountGte('0.01', '0.01')).toBe(true);
    expect(amountGte('0.009', '0.01')).toBe(false);
    expect(amountGte('x', '0.01')).toBe(false);
  });
  it('X-PAYMENT header round-trips through base64(JSON)', () => {
    const p = payload();
    const decoded = parseXPaymentHeader(encodeXPaymentHeader(p));
    expect(decoded).toMatchObject({ scheme: 'exact', asset: 'USDC', amount: '0.01', payTo: REQ.payTo });
  });
  it('parseXPaymentHeader returns null for absent / garbage headers', () => {
    expect(parseXPaymentHeader(undefined)).toBeNull();
    expect(parseXPaymentHeader('not-base64-{')).toBeNull();
    expect(parseXPaymentHeader(Buffer.from('{"scheme":1}').toString('base64'))).toBeNull();
  });
  it('build402Body wraps the requirements in an x402 accepts envelope', () => {
    const body = build402Body({ scheme: 'exact', network: 'base-sepolia', asset: 'USDC', amount: '0.01', payTo: REQ.payTo, resource: '/api/answer', nonce: 'n' });
    expect(body.x402Version).toBe(X402_VERSION);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].asset).toBe('USDC');
  });
});

describe('dRAG payment — MockPaymentVerifier', () => {
  const v = new MockPaymentVerifier();
  const required = { scheme: 'exact' as const, network: 'base-sepolia', asset: 'USDC', amount: '0.01', payTo: REQ.payTo, resource: '/api/answer', nonce: 'n' };

  it('accepts a matching payment and returns a receipt', async () => {
    const r = await v.verify(payload(), required);
    expect(r.ok).toBe(true);
    expect(r.txRef).toBeTruthy();
    expect(r.from).toBe('0x2222222222222222222222222222222222222222');
  });
  it('accepts an overpayment', async () => {
    expect((await v.verify(payload({ amount: '1.0' }), required)).ok).toBe(true);
  });
  it('rejects wrong network / asset / payTo / underpayment', async () => {
    expect((await v.verify(payload({ network: 'ethereum' }), required)).ok).toBe(false);
    expect((await v.verify(payload({ asset: 'DAI' }), required)).ok).toBe(false);
    expect((await v.verify(payload({ payTo: '0x9999999999999999999999999999999999999999' }), required)).ok).toBe(false);
    const under = await v.verify(payload({ amount: '0.001' }), required);
    expect(under.ok).toBe(false);
    expect(under.reason).toMatch(/insufficient/);
  });
  it('matches payTo case-insensitively', async () => {
    expect((await v.verify(payload({ payTo: REQ.payTo.toUpperCase().replace('0X', '0x') }), required)).ok).toBe(true);
  });
});

describe('dRAG payment — resolvePayment gate', () => {
  const v = new MockPaymentVerifier();
  const base = { network: 'base-sepolia', payTo: REQ.payTo, resource: '/api/answer', nonce: 'n', verifier: v };

  it('is FREE when no price is configured', async () => {
    const r = await resolvePayment({ ...base, price: undefined, xPaymentHeader: undefined });
    expect(r.kind).toBe('free');
  });
  it('CHALLENGES (402) when priced but no payment present', async () => {
    const r = await resolvePayment({ ...base, price: { amount: '0.01', asset: 'USDC' }, xPaymentHeader: undefined });
    expect(r.kind).toBe('challenge');
    if (r.kind === 'challenge') expect(r.required.amount).toBe('0.01');
  });
  it('PAYS through when a valid payment is presented', async () => {
    const header = encodeXPaymentHeader(payload());
    const r = await resolvePayment({ ...base, price: { amount: '0.01', asset: 'USDC' }, xPaymentHeader: header });
    expect(r.kind).toBe('paid');
    if (r.kind === 'paid') expect(r.receipt.ok).toBe(true);
  });
  it('re-CHALLENGES when the presented payment is invalid (underpayment)', async () => {
    const header = encodeXPaymentHeader(payload({ amount: '0.0001' }));
    const r = await resolvePayment({ ...base, price: { amount: '0.01', asset: 'USDC' }, xPaymentHeader: header });
    expect(r.kind).toBe('challenge');
    if (r.kind === 'challenge') expect(r.reason).toMatch(/insufficient/);
  });
});
