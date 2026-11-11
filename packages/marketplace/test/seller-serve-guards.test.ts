// SPDX-License-Identifier: Apache-2.0
/**
 * The seller's guards on a call, against MockChainAdapter's marketplace, on a
 * clock the tests move: a request is taken only while its backend's longest
 * answer still comes before the request expires, after any wait for the calls
 * before it, and a receipt is never signed past the request's expiry; a
 * stored answer goes again only to the peer it was served to; a unit cap the
 * input could use up is refused before the backend runs, the backend is asked
 * for no more output than the cap pays for, and a call whose backend ran but
 * gave nothing to sign is not run again.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  SERVICE_CLASS_INFERENCE,
  hashServiceRequest,
  marketplaceChainOf,
  signServiceRequest,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import {
  Seller,
  UpstreamError,
  receiptFromWire,
  requestToWire,
  serviceIdOf,
  unitsBound,
  type Completion,
  type Connector,
  type InferenceBody,
  type ServeAnswer,
  type ServeResponse,
} from '../src/index.js';
import { inputUnitsBound } from '../src/seller-bounds.js';

const SELLER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const SESSION = new ethers.Wallet(`0x${'33'.repeat(32)}`);
const BUYER = ethers.getAddress(`0x${'b1'.repeat(20)}`);
const MODEL = 'urn:test:model:guards';
const A = serviceIdOf(MODEL);
const PRICE = 10n;
const BODY: InferenceBody = { messages: [{ role: 'user', content: 'synthetic question' }], max_tokens: 50 };
const BUYER_PEER = 'buyer-peer';
const STRANGER_PEER = 'stranger-peer';
/** The backend's time limit in these tests: a call needs it, and 5 seconds more, before its request expires. */
const BACKEND_TIMEOUT_MS = 10_000;

let dir: string;
let chain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
let seller: Seller;
let subscriptionId: string;
/** Seconds from the epoch's start: the chain's time and the host's clock both read it. */
let clock: number;
let startsAt: number;
let backend: {
  next: Completion | Error;
  calls: number;
  maxTokens: number[];
  /** Seconds each answer takes. */
  takes: number;
  /** Holds each answer until it resolves; `entered` is called as a call reaches it. */
  hold?: Promise<void>;
  entered?: () => void;
};

const connector: Connector = {
  kind: 'openai',
  async complete({ maxTokens }) {
    backend.calls++;
    backend.maxTokens.push(maxTokens);
    backend.entered?.();
    if (backend.hold) await backend.hold;
    clock += backend.takes;
    if (backend.next instanceof Error) throw backend.next;
    return backend.next;
  },
};

function sellerWith(): Seller {
  return new Seller({
    chain, dir, signer: SELLER.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
    services: [{
      model: MODEL, serviceId: A, pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed', connector, backendTimeoutMs: BACKEND_TIMEOUT_MS,
    }],
  });
}

async function requestFor(over: Partial<ServiceRequest> = {}): Promise<ServiceRequest> {
  const now = startsAt + clock;
  return {
    subscriptionId, serviceId: A, seller: seller.gate.identityId, nonce: 0n, pricePerUnit: PRICE,
    maxUnits: 1_000n, maxValueWei: 10_000n, issuedAt: now, expiry: now + 600, ...over,
  };
}

function wire(request: ServiceRequest, body: InferenceBody = BODY) {
  return { request: requestToWire(request), signature: signServiceRequest(SESSION.privateKey, domain, request), body };
}

const codeOf = (r: ServeResponse) => (r.ok ? 'ok' : r.code);

/** Wait until `done`, for 5 seconds at most: the calls write and sync files on the way. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-seller-guards-'));
  const mock = new MockChainAdapter('mock:31337', SELLER.address);
  mock.setMockACKSigner(SELLER);
  await mock.ensureProfile();
  chain = marketplaceChainOf(mock)!;
  domain = (await chain.getMarketplaceContracts()).requestDomain;
  startsAt = (await chain.getEpochTimes()).startsAt;
  clock = 3_600;
  vi.spyOn(Date, 'now').mockImplementation(() => (startsAt + clock) * 1_000);
  backend = { next: { content: 'synthetic answer', promptTokens: 12, completionTokens: 8 }, calls: 0, maxTokens: [], takes: 1 };
  const { epoch } = await chain.getEpochTimes();
  await chain.approveServiceSubscriptionsWallet(10n ** 24n, { from: BUYER });
  subscriptionId = (await chain.fundFromWallet({
    epoch, sessionKey: SESSION.address, planDigest: ethers.ZeroHash,
    budgets: [{ serviceId: A, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 6n, maxPricePerUnit: 100n }],
  }, { from: BUYER })).subscriptionId;
  seller = sellerWith();
  await seller.load();
  await seller.tick();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('a request near its expiry', () => {
  it('is refused before its backend runs when the backend could answer after it expires', async () => {
    // The backend may take 10 seconds, and the receipt needs a few more: 14 seconds left is too few.
    const now = startsAt + clock;
    expect(codeOf(await seller.serve(wire(await requestFor({ expiry: now + 14 })), BUYER_PEER))).toBe('Expired');
    expect(codeOf(await seller.serve(wire(await requestFor({ nonce: 1n, expiry: now + 1 })), BUYER_PEER))).toBe('Expired');
    expect(backend.calls).toBe(0);
    const answer = await seller.serve(wire(await requestFor({ nonce: 2n, expiry: now + 15 })), BUYER_PEER) as ServeAnswer;
    expect(answer.ok).toBe(true);
    expect(receiptFromWire(answer.receipt).completedAt).toBeLessThanOrEqual(now + 15);
  });

  it('gets no receipt, and no answer, when its backend answers after it expired; a repeat does not run it again', async () => {
    const now = startsAt + clock;
    const request = await requestFor({ expiry: now + 20 });
    backend.takes = 30;
    expect(await seller.serve(wire(request), BUYER_PEER)).toEqual({ ok: false, code: 'Expired', retry: false });
    expect(seller.ledger.served(hashServiceRequest(domain, request))).toBeUndefined();
    expect(seller.ledger.inState('served')).toEqual([]);
    expect(codeOf(await seller.serve(wire(request), BUYER_PEER))).toBe('Expired');
    expect(backend.calls).toBe(1);
  });

  it('is checked again after it waited for the calls before it on its subscription', async () => {
    const now = startsAt + clock;
    let release!: () => void;
    backend.hold = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    backend.entered = () => { entered = true; };
    backend.takes = 20;
    const budgets = vi.spyOn(chain, 'getBudgets');
    const first = seller.serve(wire(await requestFor({ nonce: 0n })), BUYER_PEER);
    await until(() => entered);
    // Taken while the first runs: 30 seconds left then, 10 once the first is done.
    const second = seller.serve(wire(await requestFor({ nonce: 1n, expiry: now + 30 })), BUYER_PEER);
    await until(() => budgets.mock.calls.length === 2);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    expect(codeOf(await first)).toBe('ok');
    expect(codeOf(await second)).toBe('Expired');
    expect(backend.calls).toBe(1);
  });
});

describe('a repeat of a call served', () => {
  it('gets the stored answer only from the peer it was served to, after a restart too', async () => {
    const request = await requestFor();
    const answer = await seller.serve(wire(request), BUYER_PEER) as ServeAnswer;
    expect(answer).toMatchObject({ ok: true, result: { content: 'synthetic answer' } });
    // The request and its signature are public once its receipt lands: a stranger who sends them gets nothing.
    expect(await seller.serve(wire(request), STRANGER_PEER)).toEqual({ ok: false, code: 'NonceUsed', retry: false });
    expect(await seller.serve(wire(request), BUYER_PEER)).toEqual(answer);
    const restarted = sellerWith();
    await restarted.load();
    await restarted.tick();
    expect(codeOf(await restarted.serve(wire(request), STRANGER_PEER))).toBe('NonceUsed');
    expect(await restarted.serve(wire(request), BUYER_PEER)).toEqual(answer);
    expect(backend.calls).toBe(1);
  });

  it('that came in while the call it repeats was served gets its answer, not NonceUsed', async () => {
    const request = await requestFor();
    let release!: () => void;
    backend.hold = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    backend.entered = () => { entered = true; };
    const budgets = vi.spyOn(chain, 'getBudgets');
    const first = seller.serve(wire(request), BUYER_PEER);
    await until(() => entered);
    const retry = seller.serve(wire(request), BUYER_PEER);
    await until(() => budgets.mock.calls.length === 2);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const answer = await first;
    expect(answer.ok).toBe(true);
    expect(await retry).toEqual(answer);
    expect(backend.calls).toBe(1);
  });
});

describe("a request's unit cap", () => {
  const long: InferenceBody = { messages: [{ role: 'system', content: 'rules '.repeat(50) }, { role: 'user', content: 'é'.repeat(400) }], max_tokens: 50 };

  it('the buyer gateway sets is served, and one the input could use up is refused before the backend runs', async () => {
    // The gateway's cap: the input's bound and `max_tokens`. The seller's bound is the same.
    expect(unitsBound(long)).toBe(inputUnitsBound(long) + 50n);
    expect(inputUnitsBound(long)).toBe(BigInt(300 + 800 + 2 * 8 + 16));
    const at = (maxUnits: bigint, nonce: bigint) => requestFor({ nonce, maxUnits, maxValueWei: maxUnits * PRICE });
    expect(codeOf(await seller.serve(wire(await at(1n, 0n), long), BUYER_PEER))).toBe('UnitsTooFew');
    expect(codeOf(await seller.serve(wire(await at(inputUnitsBound(long), 0n), long), BUYER_PEER))).toBe('UnitsTooFew');
    // A value cap that leaves too few units is refused the same way.
    expect(codeOf(await seller.serve(wire(await requestFor({ maxUnits: 10_000n, maxValueWei: inputUnitsBound(long) * PRICE }), long), BUYER_PEER))).toBe('UnitsTooFew');
    expect(backend.calls).toBe(0);
    expect(codeOf(await seller.serve(wire(await at(unitsBound(long), 0n), long), BUYER_PEER))).toBe('ok');
    expect(backend.maxTokens).toEqual([50]);
  });

  it('asks the backend for no more output than the cap pays for after the most the input could take', async () => {
    const cap = inputUnitsBound(long) + 5n;
    expect(codeOf(await seller.serve(wire(await requestFor({ maxUnits: cap, maxValueWei: cap * PRICE }), long), BUYER_PEER))).toBe('ok');
    expect(backend.maxTokens).toEqual([5]);
  });

  it('is not run again when its backend failed, or counted more input than the cap allows', async () => {
    backend.next = new UpstreamError('the backend answered 500');
    const failed = wire(await requestFor({ nonce: 0n }));
    expect(codeOf(await seller.serve(failed, BUYER_PEER))).toBe('UpstreamError');
    expect(codeOf(await seller.serve(failed, BUYER_PEER))).toBe('UpstreamError');
    expect(codeOf(await seller.serve(failed, STRANGER_PEER))).toBe('UpstreamError');
    expect(backend.calls).toBe(1);
    // A backend that counts more input than the bound: the call was run, its cap used up, and it is not run again.
    backend.next = { content: 'x', promptTokens: 5_000, completionTokens: 1 };
    const over = wire(await requestFor({ nonce: 1n }));
    expect(codeOf(await seller.serve(over, BUYER_PEER))).toBe('UnitsTooFew');
    expect(codeOf(await seller.serve(over, BUYER_PEER))).toBe('UnitsTooFew');
    expect(backend.calls).toBe(2);
    // Neither took its nonce: a new request with it is served.
    backend.next = { content: 'synthetic answer', promptTokens: 12, completionTokens: 8 };
    expect(codeOf(await seller.serve(wire(await requestFor({ nonce: 0n, maxUnits: 999n })), BUYER_PEER))).toBe('ok');
  });
});
