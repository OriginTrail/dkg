import { describe, it, expect } from 'vitest';
import {
  InMemoryPaymentChallengeStore,
  MockPaymentVerifier,
  parsePrice,
  amountGte,
  parseXPaymentHeader,
  encodeXPaymentHeader,
  build402Body,
  resolvePayment,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentVerifier,
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
  it('amountGte compares large and precise amounts without Number rounding', () => {
    expect(amountGte('9007199254740992', '9007199254740993')).toBe(false);
    expect(amountGte('9007199254740993', '9007199254740992')).toBe(true);
    expect(amountGte('0.1000000000000000000000000000001', '0.1000000000000000000000000000002')).toBe(false);
    expect(amountGte('0.1000000000000000000000000000002', '0.1000000000000000000000000000001')).toBe(true);
    expect(amountGte('0001.2300', '1.23')).toBe(true);
    expect(amountGte('1e3', '999')).toBe(false);
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
    expect(parseXPaymentHeader(Buffer.from(JSON.stringify({ ...payload(), x402Version: undefined })).toString('base64'))).toBeNull();
    expect(parseXPaymentHeader(Buffer.from(JSON.stringify({ ...payload(), nonce: '' })).toString('base64'))).toBeNull();
  });
  it('build402Body wraps the requirements in an x402 accepts envelope', () => {
    const body = build402Body({
      scheme: 'exact',
      network: 'base-sepolia',
      asset: 'USDC',
      amount: '0.01',
      payTo: REQ.payTo,
      resource: '/api/answer',
      nonce: 'n',
    });
    expect(body.x402Version).toBe(X402_VERSION);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].asset).toBe('USDC');
  });
});

describe('dRAG payment — MockPaymentVerifier', () => {
  const v = new MockPaymentVerifier();
  const required = {
    scheme: 'exact' as const,
    network: 'base-sepolia',
    asset: 'USDC',
    amount: '0.01',
    payTo: REQ.payTo,
    resource: '/api/answer',
    nonce: 'n',
  };
  const matchingPayload = (over: Partial<PaymentPayload> = {}) => payload({ nonce: required.nonce, ...over });

  it('accepts a matching payment and returns a receipt', async () => {
    const r = await v.verify(matchingPayload(), required);
    expect(r.ok).toBe(true);
    expect(r.txRef).toBeTruthy();
    expect(r.from).toBe('0x2222222222222222222222222222222222222222');
  });
  it('accepts an overpayment', async () => {
    expect((await v.verify(matchingPayload({ amount: '1.0' }), required)).ok).toBe(true);
  });
  it('rejects wrong scheme / network / asset / payTo / nonce / underpayment', async () => {
    expect((await v.verify(matchingPayload({ x402Version: 999 }), required)).reason).toBe('x402 version mismatch');
    expect((await v.verify(matchingPayload({ scheme: 'upto' }), required)).reason).toBe('scheme mismatch');
    expect((await v.verify(matchingPayload({ network: 'ethereum' }), required)).ok).toBe(false);
    expect((await v.verify(matchingPayload({ asset: 'DAI' }), required)).ok).toBe(false);
    expect(
      (await v.verify(matchingPayload({ payTo: '0x9999999999999999999999999999999999999999' }), required)).ok,
    ).toBe(false);
    expect((await v.verify(matchingPayload({ nonce: 'not-the-issued-nonce' }), required)).reason).toBe(
      'nonce mismatch',
    );
    const under = await v.verify(matchingPayload({ amount: '0.001' }), required);
    expect(under.ok).toBe(false);
    expect(under.reason).toMatch(/insufficient/);
  });
  it('rejects underpayment at arbitrary precision', async () => {
    const precise = { ...required, amount: '9007199254740993.0000000000000000002' };
    const under = await v.verify(
      matchingPayload({ amount: '9007199254740993.0000000000000000001' }),
      precise,
    );
    expect(under.reason).toBe('insufficient amount');
  });
  it('matches payTo case-insensitively', async () => {
    expect(
      (await v.verify(matchingPayload({ payTo: REQ.payTo.toUpperCase().replace('0X', '0x') }), required)).ok,
    ).toBe(true);
  });
});

describe('dRAG payment — challenge store', () => {
  const requirement: Omit<PaymentRequirements, 'nonce'> = {
    scheme: 'exact',
    network: REQ.network,
    asset: 'USDC',
    amount: '0.01',
    payTo: REQ.payTo,
    resource: REQ.resource,
  };

  it('has atomic one-use take semantics', () => {
    const store = new InMemoryPaymentChallengeStore({ nonce: () => 'one-use' });
    const issued = store.issue(requirement);
    expect(store.take(issued.nonce)).toEqual(issued);
    expect(store.take(issued.nonce)).toBeNull();
  });

  it('evicts the oldest challenge at its hard entry bound', () => {
    const nonces = ['first', 'second', 'third'];
    const store = new InMemoryPaymentChallengeStore({ maxEntries: 2, nonce: () => nonces.shift() ?? '' });
    const first = store.issue(requirement);
    const second = store.issue(requirement);
    const third = store.issue(requirement);
    expect(store.take(first.nonce)).toBeNull();
    expect(store.take(second.nonce)).not.toBeNull();
    expect(store.take(third.nonce)).not.toBeNull();
  });
});

describe('dRAG payment — resolvePayment gate', () => {
  const v = new MockPaymentVerifier();
  const price = { amount: '0.01', asset: 'USDC' };
  const base = { network: 'base-sepolia', payTo: REQ.payTo, resource: '/api/answer', verifier: v };

  async function issue(store: InMemoryPaymentChallengeStore, overrides: Partial<typeof base> = {}) {
    const result = await resolvePayment({
      ...base,
      ...overrides,
      price,
      xPaymentHeader: undefined,
      challengeStore: store,
    });
    if (result.kind !== 'challenge') throw new Error(`expected challenge, got ${result.kind}`);
    return result.required;
  }

  it('is FREE when no price is configured', async () => {
    const r = await resolvePayment({
      ...base,
      price: undefined,
      xPaymentHeader: undefined,
      challengeStore: new InMemoryPaymentChallengeStore(),
    });
    expect(r.kind).toBe('free');
  });
  it('records and returns a challenge (402) when priced but no payment is present', async () => {
    const store = new InMemoryPaymentChallengeStore();
    const r = await resolvePayment({ ...base, price, xPaymentHeader: undefined, challengeStore: store });
    expect(r.kind).toBe('challenge');
    if (r.kind === 'challenge') {
      expect(r.required.amount).toBe('0.01');
      expect(store.take(r.required.nonce)).toEqual(r.required);
    }
  });
  it('completes the happy 402 → paid flow', async () => {
    const store = new InMemoryPaymentChallengeStore();
    const required = await issue(store);
    const header = encodeXPaymentHeader(payload({ nonce: required.nonce }));
    const r = await resolvePayment({ ...base, price, xPaymentHeader: header, challengeStore: store });
    expect(r.kind).toBe('paid');
    if (r.kind === 'paid') expect(r.receipt.ok).toBe(true);
  });

  it('rejects replay of an already consumed challenge', async () => {
    const store = new InMemoryPaymentChallengeStore();
    const required = await issue(store);
    const header = encodeXPaymentHeader(payload({ nonce: required.nonce }));
    expect((await resolvePayment({ ...base, price, xPaymentHeader: header, challengeStore: store })).kind).toBe('paid');
    const replay = await resolvePayment({ ...base, price, xPaymentHeader: header, challengeStore: store });
    expect(replay.kind).toBe('challenge');
    if (replay.kind === 'challenge') expect(replay.reason).toMatch(/unknown|expired|already used/);
  });

  it('rejects a challenge issued for a different resource and consumes it', async () => {
    const store = new InMemoryPaymentChallengeStore();
    const resourceA = '/api/answer/context-a';
    const required = await issue(store, { resource: resourceA });
    const header = encodeXPaymentHeader(payload({ nonce: required.nonce }));
    const crossResource = await resolvePayment({ ...base, price, xPaymentHeader: header, challengeStore: store });
    expect(crossResource.kind).toBe('challenge');
    if (crossResource.kind === 'challenge') expect(crossResource.reason).toMatch(/does not match/);

    const originalResourceReplay = await resolvePayment({
      ...base,
      resource: resourceA,
      price,
      xPaymentHeader: header,
      challengeStore: store,
    });
    expect(originalResourceReplay.kind).toBe('challenge');
    if (originalResourceReplay.kind === 'challenge') expect(originalResourceReplay.reason).toMatch(/already used/);
  });

  it('rejects a nonce that was never issued', async () => {
    const store = new InMemoryPaymentChallengeStore();
    await issue(store);
    const header = encodeXPaymentHeader(payload({ nonce: 'not-issued' }));
    const r = await resolvePayment({ ...base, price, xPaymentHeader: header, challengeStore: store });
    expect(r.kind).toBe('challenge');
    if (r.kind === 'challenge') expect(r.reason).toMatch(/unknown/);
  });

  it('rejects an expired challenge', async () => {
    let now = 1_000;
    const store = new InMemoryPaymentChallengeStore({ ttlMs: 50, now: () => now });
    const required = await issue(store);
    now += 50;
    const header = encodeXPaymentHeader(payload({ nonce: required.nonce }));
    const r = await resolvePayment({ ...base, price, xPaymentHeader: header, challengeStore: store });
    expect(r.kind).toBe('challenge');
    if (r.kind === 'challenge') expect(r.reason).toMatch(/expired/);
  });

  it('consumes the challenge before awaiting asynchronous verification', async () => {
    let release!: () => void;
    const verifierGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let verifyCalls = 0;
    const verifier: PaymentVerifier = {
      async verify(payment, required) {
        verifyCalls++;
        await verifierGate;
        return {
          ok: true,
          scheme: required.scheme,
          network: required.network,
          asset: required.asset,
          amount: required.amount,
          payTo: required.payTo,
          from: payment.from,
        };
      },
    };
    const store = new InMemoryPaymentChallengeStore();
    const required = await issue(store);
    const header = encodeXPaymentHeader(payload({ nonce: required.nonce }));
    const first = resolvePayment({ ...base, verifier, price, xPaymentHeader: header, challengeStore: store });
    expect(verifyCalls).toBe(1);

    const concurrentReplay = await resolvePayment({
      ...base,
      verifier,
      price,
      xPaymentHeader: header,
      challengeStore: store,
    });
    expect(concurrentReplay.kind).toBe('challenge');
    expect(verifyCalls).toBe(1);
    release();
    expect((await first).kind).toBe('paid');
  });

  it('re-challenges when the presented payment is invalid and issues a fresh nonce', async () => {
    const store = new InMemoryPaymentChallengeStore();
    const required = await issue(store);
    const header = encodeXPaymentHeader(payload({ nonce: required.nonce, amount: '0.0001' }));
    const r = await resolvePayment({ ...base, price, xPaymentHeader: header, challengeStore: store });
    expect(r.kind).toBe('challenge');
    if (r.kind === 'challenge') {
      expect(r.reason).toMatch(/insufficient/);
      expect(r.required.nonce).not.toBe(required.nonce);
    }
  });
});
