// SPDX-License-Identifier: Apache-2.0
/**
 * What the seller reads from chain for a call, against MockChainAdapter's
 * marketplace, on a clock the tests move: the chain's time is the last tick's
 * moved on by the host's clock, a call's signer is recovered before anything
 * is read, a subscription is read once and kept for its epoch (and an id with
 * none for a while), its budgets only once a call its session key signed names
 * it, and a peer may start only so many reads of subscriptions not kept.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  SERVICE_CLASS_INFERENCE,
  marketplaceChainOf,
  signServiceRequest,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import {
  Seller,
  requestToWire,
  serviceIdOf,
  type Connector,
  type InferenceBody,
  type ServeResponse,
} from '../src/index.js';

const SELLER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const SESSION = new ethers.Wallet(`0x${'33'.repeat(32)}`);
const OTHER_KEY = new ethers.Wallet(`0x${'44'.repeat(32)}`);
const BUYER = ethers.getAddress(`0x${'b1'.repeat(20)}`);
const MODEL_A = 'urn:test:model:reads-a';
const MODEL_B = 'urn:test:model:reads-b';
const A = serviceIdOf(MODEL_A);
const B = serviceIdOf(MODEL_B);
const PRICE = 10n;
const BODY: InferenceBody = { messages: [{ role: 'user', content: 'synthetic question' }], max_tokens: 50 };
const BUYER_PEER = 'buyer-peer';
const STRANGER_PEER = 'stranger-peer';

let dir: string;
let chain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
let seller: Seller;
let subscriptionId: string;
/** Seconds from the epoch's start: the chain's time and the host's clock both read it. */
let clock: number;
let startsAt: number;
let calls: number;

const connector: Connector = {
  kind: 'openai',
  async complete() {
    calls++;
    clock += 1;
    return { content: 'synthetic answer', promptTokens: 12, completionTokens: 8 };
  },
};

function requestFor(over: Partial<ServiceRequest> = {}): ServiceRequest {
  const now = startsAt + clock;
  return {
    subscriptionId, serviceId: A, seller: seller.gate.identityId, nonce: 0n, pricePerUnit: PRICE,
    maxUnits: 1_000n, maxValueWei: 10_000n, issuedAt: now, expiry: now + 600, ...over,
  };
}

function wire(request: ServiceRequest, key: ethers.Wallet = SESSION) {
  return { request: requestToWire(request), signature: signServiceRequest(key.privateKey, domain, request), body: BODY };
}

const codeOf = (r: ServeResponse) => (r.ok ? 'ok' : r.code);

/** Every chain read a call can make, counted from here on. */
function chainReads() {
  return {
    epochTimes: vi.spyOn(chain, 'getEpochTimes'),
    subscription: vi.spyOn(chain, 'getSubscription'),
    budgets: vi.spyOn(chain, 'getBudgets'),
    budgetLeft: vi.spyOn(chain, 'budgetLeft'),
    grantEnd: vi.spyOn(chain, 'grantEnd'),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-seller-reads-'));
  const mock = new MockChainAdapter('mock:31337', SELLER.address);
  mock.setMockACKSigner(SELLER);
  await mock.ensureProfile();
  chain = marketplaceChainOf(mock)!;
  domain = (await chain.getMarketplaceContracts()).requestDomain;
  startsAt = (await chain.getEpochTimes()).startsAt;
  clock = 3_600;
  calls = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => (startsAt + clock) * 1_000);
  const { epoch } = await chain.getEpochTimes();
  await chain.approveServiceSubscriptionsWallet(10n ** 24n, { from: BUYER });
  subscriptionId = (await chain.fundFromWallet({
    epoch, sessionKey: SESSION.address, planDigest: ethers.ZeroHash,
    budgets: [{ serviceId: A, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 6n, maxPricePerUnit: 100n }],
  }, { from: BUYER })).subscriptionId;
  seller = new Seller({
    chain, dir, signer: SELLER.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
    services: [MODEL_A, MODEL_B].map((model) => ({
      model, serviceId: serviceIdOf(model), pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed' as const, connector,
    })),
  });
  await seller.load();
  await seller.tick();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('a call that is not the subscription\'s', () => {
  it('reads nothing from chain when its signature is not a low-s signature', async () => {
    const reads = chainReads();
    const valid = wire(requestFor());
    // The same r, with an s above half the curve order: no key signed this.
    const highS = `${valid.signature.slice(0, 66)}${'7f'.padEnd(64, 'f')}`;
    expect(codeOf(await seller.serve({ ...valid, signature: highS }, STRANGER_PEER))).toBe('BadSignature');
    for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled();
  });

  it('signed by another key, reads the subscription once and its budgets never', async () => {
    const reads = chainReads();
    for (let nonce = 0n; nonce < 20n; nonce++) {
      expect(codeOf(await seller.serve(wire(requestFor({ nonce }), OTHER_KEY), STRANGER_PEER))).toBe('BadSignature');
    }
    expect(reads.subscription).toHaveBeenCalledTimes(1);
    expect(reads.epochTimes).not.toHaveBeenCalled();
    expect(reads.budgets).not.toHaveBeenCalled();
    expect(reads.budgetLeft).not.toHaveBeenCalled();
    expect(calls).toBe(0);
  });

  it('naming a subscription id with no subscription, reads it once while it is kept as missing', async () => {
    const reads = chainReads();
    const missing = `0x${'ab'.repeat(32)}`;
    for (let nonce = 0n; nonce < 10n; nonce++) {
      expect(codeOf(await seller.serve(wire(requestFor({ subscriptionId: missing, nonce })), STRANGER_PEER))).toBe('SubscriptionNotFound');
    }
    expect(reads.subscription).toHaveBeenCalledTimes(1);
    clock += 31;
    expect(codeOf(await seller.serve(wire(requestFor({ subscriptionId: missing, nonce: 10n })), STRANGER_PEER))).toBe('SubscriptionNotFound');
    expect(reads.subscription).toHaveBeenCalledTimes(2);
  });

  it('naming subscription ids not kept, starts only so many reads per peer', async () => {
    const reads = chainReads();
    const missing = (i: number) => ethers.zeroPadValue(ethers.toBeHex(i + 1), 32);
    const codes: string[] = [];
    for (let i = 0; i < 40; i++) {
      codes.push(codeOf(await seller.serve(wire(requestFor({ subscriptionId: missing(i) })), STRANGER_PEER)));
    }
    expect(reads.subscription).toHaveBeenCalledTimes(32);
    expect(codes.slice(0, 32).every((code) => code === 'SubscriptionNotFound')).toBe(true);
    // Refused without a read, as the seller's: retried later.
    expect(codes.slice(32).every((code) => code === 'Unavailable')).toBe(true);
    // This peer's allowance comes back with time, one read a second, and another peer has its own.
    clock += 3;
    for (let i = 40; i < 45; i++) await seller.serve(wire(requestFor({ subscriptionId: missing(i) })), STRANGER_PEER);
    expect(reads.subscription).toHaveBeenCalledTimes(32 + 3);
    expect(codeOf(await seller.serve(wire(requestFor()), BUYER_PEER))).toBe('ok');
    expect(reads.subscription).toHaveBeenCalledTimes(32 + 3 + 1);
  });

  it('issued after the seller\'s time, reads the chain\'s time again only within its peer\'s allowance', async () => {
    const reads = chainReads();
    const far = startsAt + clock + 10_000;
    for (let nonce = 0n; nonce < 50n; nonce++) {
      const request = requestFor({ nonce, issuedAt: far, expiry: far + 600 });
      expect(codeOf(await seller.serve(wire(request, OTHER_KEY), STRANGER_PEER))).toBe('NotYetValid');
    }
    expect(reads.epochTimes).toHaveBeenCalledTimes(32);
    expect(reads.subscription).not.toHaveBeenCalled();
  });
});

describe('quotes', () => {
  it('read nothing from chain', async () => {
    const { epoch } = await chain.getEpochTimes();
    const reads = chainReads();
    for (let i = 0; i < 10; i++) {
      const quote = await seller.quote({ services: [A] });
      expect(quote).toMatchObject({ epoch, offers: [{ serviceId: A, available: true }] });
    }
    expect(reads.epochTimes).not.toHaveBeenCalled();
  });
});

describe('the buyer\'s calls', () => {
  it('read its subscription and budgets once', async () => {
    const reads = chainReads();
    for (let nonce = 0n; nonce < 3n; nonce++) {
      expect(codeOf(await seller.serve(wire(requestFor({ nonce })), BUYER_PEER))).toBe('ok');
    }
    expect(reads.subscription).toHaveBeenCalledTimes(1);
    expect(reads.budgets).toHaveBeenCalledTimes(1);
    expect(calls).toBe(3);
  });

  it('are served for a service a top-up added after the budgets were read', async () => {
    expect(codeOf(await seller.serve(wire(requestFor()), BUYER_PEER))).toBe('ok');
    expect(codeOf(await seller.serve(wire(requestFor({ nonce: 1n, serviceId: B })), BUYER_PEER))).toBe('ServiceNotFunded');
    await chain.topUpFromWallet(subscriptionId, [{ serviceId: B, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 6n, maxPricePerUnit: 100n }], ethers.ZeroHash, { from: BUYER });
    expect(codeOf(await seller.serve(wire(requestFor({ nonce: 2n, serviceId: B })), BUYER_PEER))).toBe('ok');
  });

  it('are refused near the epoch\'s end by the tick\'s time and the host\'s clock', async () => {
    const { endsAt } = await chain.getEpochTimes();
    const reads = chainReads();
    clock = endsAt - startsAt - 180;
    expect(codeOf(await seller.serve(wire(requestFor()), BUYER_PEER))).toBe('EpochEnding');
    expect(reads.epochTimes).not.toHaveBeenCalled();
    expect(calls).toBe(0);
  });
});
