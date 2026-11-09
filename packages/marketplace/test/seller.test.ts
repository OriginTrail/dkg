// SPDX-License-Identifier: Apache-2.0
/**
 * The seller against MockChainAdapter's marketplace, with a stub backend: its
 * gate, quotes, offers and frozen prices, and each call's checks in their
 * order, the cut to the request's units, the signed receipt, the
 * ledger, and a repeat answered from it.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  SERVICE_CLASS_INFERENCE,
  hashBuyerGrant,
  hashServiceRequest,
  marketplaceChainOf,
  signServiceRequest,
  subscriptionIdOf,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import {
  MARKETPLACE_NS,
  Seller,
  UpstreamError,
  cutTo,
  inputUnitsBound,
  offerSignerOf,
  offerSubject,
  offersFromBindings,
  receiptFromWire,
  receiptSignerOf,
  requestToWire,
  resultCommitmentOf,
  serviceIdOf,
  type Completion,
  type Connector,
  type Offer,
  type OfferQuad,
  type SellerService,
  type ServeAnswer,
  type ServeResponse,
} from '../src/index.js';

const SELLER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const SESSION = new ethers.Wallet(`0x${'33'.repeat(32)}`);
const BUYER = ethers.getAddress(`0x${'b1'.repeat(20)}`);
const MODEL_A = 'urn:test:model:a';
const MODEL_B = 'urn:test:model:b';
const A = serviceIdOf(MODEL_A);
const B = serviceIdOf(MODEL_B);
const PRICE = 10n;
const BODY = { messages: [{ role: 'user' as const, content: 'synthetic question' }], max_tokens: 50 };

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
/** The stub backend: its next answer, how many calls it took, and what it does first, given the call's signal. */
let backend: { next: Completion | Error; calls: number; during?: (signal: AbortSignal) => Promise<void> };
let shared: OfferQuad[][];

const connector: Connector = {
  kind: 'openai',
  async complete({ signal }) {
    backend.calls++;
    await backend.during?.(signal!);
    if (backend.next instanceof Error) throw backend.next;
    return backend.next;
  },
};

function serviceOf(model: string, pricePerUnit = PRICE): SellerService {
  return { model, serviceId: serviceIdOf(model), pricePerUnit, capacity: 4, provenance: 'upstream-claimed', connector };
}

function sellerWith(over: { stopServingSeconds?: number; price?: bigint } = {}): Seller {
  return new Seller({
    chain,
    dir,
    services: [serviceOf(MODEL_A, over.price), serviceOf(MODEL_B, over.price)],
    signer: SELLER.address,
    peerId: 'seller-peer',
    stopServingSeconds: over.stopServingSeconds ?? 180,
    tickSeconds: 300,
    shareOffer: async (quads) => { shared.push(quads); },
  });
}

/** The offers among shared quads, read back as a buyer's query returns them: a row per subject. */
function offersIn(quads: OfferQuad[]): Offer[] {
  const rows = new Map<string, Record<string, string>>();
  for (const q of quads) {
    const row = rows.get(q.subject) ?? { offer: q.subject };
    if (q.predicate.startsWith(MARKETPLACE_NS)) row[q.predicate.slice(MARKETPLACE_NS.length)] = q.object;
    rows.set(q.subject, row);
  }
  return offersFromBindings([...rows.values()]);
}

/** Fund the current epoch (or the next) for `buyer`, with `budgets` of A and B. */
async function fund(buyer = BUYER, opts: { epochOffset?: number; services?: string[]; cap?: bigint } = {}): Promise<string> {
  const { epoch } = await chain.getEpochTimes();
  await chain.approveServiceSubscriptionsWallet(10n ** 24n, { from: buyer });
  const budgets = (opts.services ?? [A]).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
    .map((serviceId) => ({ serviceId, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 6n, maxPricePerUnit: opts.cap ?? 100n }));
  const funded = await chain.fundFromWallet({ epoch: epoch + (opts.epochOffset ?? 0), sessionKey: SESSION.address, planDigest: ethers.ZeroHash, budgets }, { from: buyer });
  return funded.subscriptionId;
}

async function requestFor(subscriptionId: string, over: Partial<ServiceRequest> = {}): Promise<ServiceRequest> {
  const { now } = await chain.getEpochTimes();
  const s = (await chain.getSubscription(subscriptionId))!;
  return {
    subscriptionId, serviceId: A, seller: await chain.getIdentityId(), nonce: 0n, pricePerUnit: PRICE,
    maxUnits: 1_000n, maxValueWei: 10_000n, issuedAt: Math.max(now, s.startsAt), expiry: now + 600, ...over,
  };
}

function wire(request: ServiceRequest, key: ethers.Wallet = SESSION, body: unknown = BODY) {
  return { request: requestToWire(request), signature: signServiceRequest(key.privateKey, domain, request), body };
}

const codeOf = (r: ServeResponse) => (r.ok ? 'ok' : r.code);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-seller-'));
  mock = new MockChainAdapter('mock:31337', SELLER.address);
  mock.setMockACKSigner(SELLER);
  await mock.ensureProfile();
  chain = marketplaceChainOf(mock)!;
  domain = (await chain.getMarketplaceContracts()).requestDomain;
  backend = { next: { content: 'synthetic answer', promptTokens: 12, completionTokens: 8 }, calls: 0 };
  shared = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the gate, quotes and offers', () => {
  it('serves nothing before its first tick, nor while it is not a Core Node', async () => {
    const seller = sellerWith();
    await seller.load();
    const id = await fund();
    expect(codeOf(await seller.serve(wire(await requestFor(id))))).toBe('NotServing');
    vi.spyOn(chain, 'isShardingTableMember').mockResolvedValue(false);
    await seller.tick();
    expect(seller.gate.open).toBe(false);
    expect(shared).toEqual([]);
    expect((await seller.quote({ services: [A] })).offers[0]!.available).toBe(false);
  });

  it('shares an offer per service for this epoch and the next, once, signed and naming its peer, and quotes its frozen price', async () => {
    const seller = sellerWith();
    await seller.load();
    await seller.tick();
    await seller.tick();
    // A share per offer, each of one subject.
    expect(shared).toHaveLength(4);
    const { epoch } = await chain.getEpochTimes();
    const offers = shared.map((quads) => offersIn(quads)[0]!);
    expect(offers.map((o) => `${o.serviceId}:${o.epoch}`).sort()).toEqual([`${A}:${epoch}`, `${A}:${epoch + 1}`, `${B}:${epoch}`, `${B}:${epoch + 1}`].sort());
    expect(shared.map((quads) => [...new Set(quads.map((q) => q.subject))])).toEqual(offers.map((o) => [offerSubject(o.signature)]));
    for (const o of offers) {
      expect(o).toMatchObject({ seller: seller.gate.identityId, pricePerUnit: PRICE, capacity: 4, peerId: 'seller-peer' });
      expect(offerSignerOf(domain, o)).toBe(SELLER.address);
    }
    expect(await seller.quote({ services: [A, `0x${'99'.repeat(32)}`] })).toEqual({
      seller: String(seller.gate.identityId), epoch, offers: [{ serviceId: A, pricePerUnit: '10', available: true, capacity: 4 }],
    });

    // A new price applies from the next epoch: this one's stays frozen, on disk.
    const repriced = sellerWith({ price: 20n });
    await repriced.load();
    await repriced.tick();
    expect((await repriced.quote({ services: [A] })).offers[0]!.pricePerUnit).toBe('10');
    expect(offersIn(shared.slice(4).flat()).filter((o) => o.serviceId === A).map((o) => String(o.pricePerUnit)).sort()).toEqual(['10', '20']);
    await expect(repriced.quote({ services: ['0x01'] })).rejects.toThrow(/32 bytes/);
  });

  it('shares an offer again when its price changes, back to an earlier one too, each copy signed later than the last', async () => {
    const seller = sellerWith();
    await seller.load();
    await seller.tick();
    const { epoch, startsAt } = await chain.getEpochTimes();
    const nextOfA = (quads: OfferQuad[]) => offersIn(quads).filter((o) => o.serviceId === A && o.epoch === epoch + 1);
    await seller.setNextPrice(A, 30n);
    await seller.tick();
    await seller.setNextPrice(A, PRICE);
    await seller.tick();
    await seller.tick();
    // Only A's next offer was shared again, once per change.
    expect(shared).toHaveLength(6);
    const copies = shared.flatMap(nextOfA);
    expect(copies.map((o) => o.pricePerUnit)).toEqual([PRICE, 30n, PRICE]);
    expect(copies[0]!.signedAt).toBeGreaterThanOrEqual(startsAt);
    expect(copies[1]!.signedAt).toBeGreaterThan(copies[0]!.signedAt);
    expect(copies[2]!.signedAt).toBeGreaterThan(copies[1]!.signedAt);
  });

  it('shares its offers again half an epoch after their last copies, which shared memory keeps for a limited time', async () => {
    const seller = sellerWith();
    await seller.load();
    await seller.tick();
    const real = chain.getEpochTimes.bind(chain);
    const { startsAt, endsAt } = await real();
    const half = (endsAt - startsAt) / 2;
    const first = offersIn(shared[0]!)[0]!.signedAt;
    const at = (now: number) => vi.spyOn(chain, 'getEpochTimes').mockImplementation(async () => ({ ...(await real()), now }));
    at(first + half - 1);
    await seller.tick();
    expect(shared).toHaveLength(4);
    at(first + half);
    await seller.tick();
    expect(shared).toHaveLength(8);
    expect(offersIn(shared.slice(4).flat()).map((o) => o.signedAt)).toEqual([first + half, first + half, first + half, first + half]);
  });

  it('keeps the offers shared before one that fails, and the next tick shares the rest', async () => {
    let calls = 0;
    const seller = new Seller({
      chain, dir, services: [serviceOf(MODEL_A), serviceOf(MODEL_B)], signer: SELLER.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
      shareOffer: async (quads) => {
        if (++calls === 3) throw new Error('the graph is away');
        shared.push(quads);
      },
    });
    await seller.load();
    await seller.tick();
    expect(shared).toHaveLength(2);
    await seller.tick();
    expect(shared).toHaveLength(4);
    const { epoch } = await chain.getEpochTimes();
    expect(shared.map((quads) => `${offersIn(quads)[0]!.serviceId}:${offersIn(quads)[0]!.epoch}`).sort())
      .toEqual([`${A}:${epoch}`, `${A}:${epoch + 1}`, `${B}:${epoch}`, `${B}:${epoch + 1}`].sort());
  });

  it('shares each offer once when two ticks run at once', async () => {
    const seller = sellerWith();
    await seller.load();
    await Promise.all([seller.tick(), seller.tick()]);
    expect(shared).toHaveLength(4);
    expect(new Set(shared.map((quads) => quads[0]!.subject)).size).toBe(4);
  });
});

describe('the job', () => {
  it('ticks at start and stops', async () => {
    const seller = sellerWith();
    await seller.load();
    seller.start();
    seller.start();
    await seller.stop();
    expect(seller.gate.open).toBe(true);
    expect(shared).toHaveLength(4);
    expect(receiptSignerOf(domain, { requestDigest: ethers.ZeroHash, resultCommitment: ethers.ZeroHash, units: 1n, valueWei: 1n, completedAt: 1 }, '0x00')).toBeNull();
  });

  it('lands even when its offers fail to share, logs what failed, and goes on to the next tick', async () => {
    const logs: string[] = [];
    const seller = new Seller({
      chain, dir, services: [serviceOf(MODEL_A)], signer: SELLER.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
      shareOffer: async () => { throw new Error('the graph is away'); },
      log: (m) => logs.push(m),
    });
    await seller.load();
    const landing = vi.spyOn(seller.lander, 'tick').mockRejectedValueOnce(new Error('no chain'));
    expect(await seller.tick()).toBeGreaterThan(0);
    expect(logs).toEqual([expect.stringMatching(/offers were not shared: the graph is away/), expect.stringMatching(/landing failed: no chain/)]);
    expect(landing).toHaveBeenCalledWith(true);

    // The job: a tick that fails as a whole is logged and tried again soon; one that runs sets the next too.
    vi.spyOn(chain, 'getEpochTimes').mockRejectedValueOnce(new Error('socket hang up'));
    seller.start();
    await vi.waitFor(() => expect(logs.at(-1)).toMatch(/seller tick failed, tried again in 30 s: socket hang up/));
    await seller.stop();
    seller.start();
    await vi.waitFor(() => expect(seller.lastLanding).toEqual({ stopped: 'not-due' }));
    await seller.stop();
  });

  it('keeps its ticks on time however long one takes', async () => {
    const seller = sellerWith();
    await seller.load();
    const times = await chain.getEpochTimes();
    vi.spyOn(chain, 'getEpochTimes').mockResolvedValue({ ...times, now: times.startsAt + 100 });
    // The tick took 40 seconds: the next one, 200 seconds from its start, is 160 from its end.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(40_000);
    expect(await seller.tick()).toBe(160);
  });

  it('refuses to start on a price file it cannot read', async () => {
    await mkdir(join(dir, 'seller-prices.json'));
    await expect(sellerWith().load()).rejects.toThrow();
  });
});

describe('a call', () => {
  let seller: Seller;
  beforeEach(async () => {
    seller = sellerWith();
    await seller.load();
    await seller.tick();
  });

  it('is served, with a receipt its operational wallet signed, and kept in the ledger', async () => {
    const id = await fund();
    const request = await requestFor(id);
    const answer = await seller.serve(wire(request)) as ServeAnswer;
    expect(answer).toMatchObject({ ok: true, result: { content: 'synthetic answer' }, budgetIndex: 0 });
    const receipt = receiptFromWire(answer.receipt);
    expect(receipt).toMatchObject({ requestDigest: hashServiceRequest(domain, request), resultCommitment: resultCommitmentOf('synthetic answer'), units: 20n, valueWei: 200n });
    expect(receiptSignerOf(domain, receipt, answer.receiptSignature)).toBe(SELLER.address);

    // A repeat is answered from the ledger, here and after a restart, and never runs twice.
    expect(await seller.serve(wire(request))).toEqual(answer);
    const restarted = sellerWith();
    await restarted.load();
    await restarted.tick();
    expect(await restarted.serve(wire(request))).toEqual(answer);
    expect(backend.calls).toBe(1);
    // The same nonce in another request is refused, after the restart too.
    expect(codeOf(await restarted.serve(wire({ ...request, maxUnits: 999n })))).toBe('NonceUsed');
  });

  it('cuts an overrun to the units the request allows, and refuses an input that leaves none', async () => {
    const id = await fund();
    backend.next = { content: 'abcdefghij', promptTokens: 10, completionTokens: 100 };
    const cut = await seller.serve(wire(await requestFor(id, { maxUnits: 60n }))) as ServeAnswer;
    expect(cut.result.content).toBe('abcde');
    expect(receiptFromWire(cut.receipt)).toMatchObject({ units: 60n, valueWei: 600n, resultCommitment: resultCommitmentOf('abcde') });
    // A value cap lower than its units allow cuts too.
    const capped = await seller.serve(wire(await requestFor(id, { nonce: 1n, maxUnits: 1_000n, maxValueWei: 500n }))) as ServeAnswer;
    expect(receiptFromWire(capped.receipt).units).toBe(50n);
    backend.next = { content: 'x', promptTokens: 60, completionTokens: 1 };
    expect(codeOf(await seller.serve(wire(await requestFor(id, { nonce: 2n, maxUnits: 60n }))))).toBe('UnitsTooFew');
    expect(cutTo('héllo wörld', 10, 5)).toBe('héllo');
  });

  it('never runs its backend for a signed request whose units cannot cover its input', async () => {
    const id = await fund();
    // A large prompt, and one unit at the price: valid, signed and funded, and again with each new nonce.
    const large = { messages: [{ role: 'user' as const, content: 'x'.repeat(64 * 1024) }], max_tokens: 1 };
    for (const nonce of [0n, 1n, 2n]) {
      expect(codeOf(await seller.serve(wire(await requestFor(id, { nonce, maxUnits: 1n, maxValueWei: PRICE }), SESSION, large)))).toBe('UnitsTooFew');
    }
    expect(backend.calls).toBe(0);
    // Its bound is 42 units: 18 bytes and an allowance of 8 for the message and 16 for the call. One unit more is served.
    expect(inputUnitsBound(BODY.messages)).toBe(42n);
    expect(codeOf(await seller.serve(wire(await requestFor(id, { nonce: 3n, maxUnits: 42n }))))).toBe('UnitsTooFew');
    expect(codeOf(await seller.serve(wire(await requestFor(id, { nonce: 4n, maxUnits: 1_000n, maxValueWei: 42n * PRICE }))))).toBe('UnitsTooFew');
    expect(backend.calls).toBe(0);
    expect(codeOf(await seller.serve(wire(await requestFor(id, { nonce: 5n, maxUnits: 43n }))))).toBe('ok');
    expect(backend.calls).toBe(1);
    // Nothing was kept for the calls refused.
    expect(seller.ledger.inState('served').map((c) => c.request.nonce)).toEqual(['5']);
  });

  it('refuses in the order of the checks', async () => {
    const id = await fund();
    const r = await requestFor(id);
    const refused = async (request: ServiceRequest, key?: ethers.Wallet) => codeOf(await seller.serve(wire(request, key)));
    expect(codeOf(await seller.serve({ request: requestToWire(r), signature: '0x12', body: BODY }))).toBe('BadRequest');
    // Only the 64-byte form a batch item carries: the same signature in 65 bytes is refused.
    const full = SESSION.signingKey.sign(hashServiceRequest(domain, r)).serialized;
    expect(ethers.getBytes(full)).toHaveLength(65);
    expect(await seller.serve({ request: requestToWire(r), signature: full, body: BODY })).toMatchObject({ ok: false, code: 'BadRequest', message: expect.stringMatching(/64 bytes/) });
    expect(codeOf(await seller.serve(wire(r, SESSION, { messages: [] })))).toBe('BadRequest');
    expect(await refused({ ...r, serviceId: `0x${'99'.repeat(32)}` })).toBe('UnknownService');
    expect(await refused({ ...r, pricePerUnit: 11n })).toBe('WrongPrice');
    expect(await refused({ ...r, subscriptionId: `0x${'ab'.repeat(32)}` })).toBe('SubscriptionNotFound');
    expect(await refused({ ...r, serviceId: B })).toBe('ServiceNotFunded');
    // Signed by another key, or for another seller: either recovers to another key.
    expect(await refused(r, new ethers.Wallet(`0x${'44'.repeat(32)}`))).toBe('BadSignature');
    expect(await refused({ ...r, seller: r.seller + 1n })).toBe('BadSignature');
    expect(await refused({ ...r, issuedAt: r.issuedAt + 3_600 })).toBe('NotYetValid');
    expect(await refused({ ...r, expiry: r.issuedAt })).toBe('Expired');
    expect(await refused({ ...r, maxValueWei: 10n ** 7n })).toBe('BudgetExhausted');
    expect(backend.calls).toBe(0);

    const next = await fund(ethers.getAddress(`0x${'b2'.repeat(20)}`), { epochOffset: 1 });
    expect(await refused({ ...r, subscriptionId: next })).toBe('NotCurrentEpoch');
    const capped = await fund(ethers.getAddress(`0x${'b3'.repeat(20)}`), { cap: 5n });
    expect(await refused(await requestFor(capped))).toBe('PriceOverCap');
  });

  it('takes one nonce once across budgets, however many calls come at once', async () => {
    const id = await fund(BUYER, { services: [A, B] });
    const r = await requestFor(id);
    const answers = await Promise.all([seller.serve(wire(r)), seller.serve(wire({ ...r, serviceId: B }))]);
    expect(answers.map(codeOf).sort()).toEqual(['NonceUsed', 'ok']);
  });

  it('counts the receipts it has not landed against what a budget has left', async () => {
    const id = await fund();
    // 10^6 wei funded: three calls of 400,000 wei at most each fit two.
    const call = (nonce: bigint) => requestFor(id, { nonce, maxUnits: 40_000n, maxValueWei: 400_000n });
    backend.next = { content: 'x', promptTokens: 30_000, completionTokens: 10_000 };
    expect(codeOf(await seller.serve(wire(await call(0n))))).toBe('ok');
    expect(codeOf(await seller.serve(wire(await call(1n))))).toBe('ok');
    expect(codeOf(await seller.serve(wire(await call(2n))))).toBe('BudgetExhausted');
  });

  it('refuses within the stop window, after its grant ended, and on a failing backend or chain', async () => {
    const id = await fund();
    const ending = sellerWith({ stopServingSeconds: 31 * 86_400 });
    await ending.load();
    await ending.tick();
    expect(codeOf(await ending.serve(wire(await requestFor(id))))).toBe('EpochEnding');

    backend.next = new UpstreamError('the backend answered 500');
    // The backend's detail stays with the seller.
    expect(await seller.serve(wire(await requestFor(id)))).toEqual({ ok: false, code: 'UpstreamError', retry: true });
    const later = wire(await requestFor(id, { nonce: 1n }));
    vi.spyOn(chain, 'getSubscription').mockRejectedValueOnce(new Error('socket hang up'));
    expect(await seller.serve(later)).toEqual({ ok: false, code: 'Unavailable', retry: true });
  });

  it('refuses work that ends after its request expired, and neither signs nor keeps it', async () => {
    const id = await fund();
    const request = await requestFor(id);
    // The backend answers 601 seconds on, past the request's ten minutes.
    const real = chain.getEpochTimes.bind(chain);
    backend.during = async () => {
      vi.spyOn(chain, 'getEpochTimes').mockImplementation(async () => {
        const times = await real();
        return { ...times, now: times.now + 601 };
      });
    };
    const sign = vi.spyOn(chain, 'signTypedDataAs');
    expect(await seller.serve(wire(request))).toEqual({ ok: false, code: 'Expired', retry: false });
    expect(sign).not.toHaveBeenCalled();
    expect(seller.ledger.served(hashServiceRequest(domain, request))).toBeUndefined();
    expect(seller.ledger.nonceUsed(id, '0')).toBe(false);
    expect(seller.backendOf(A)).toBe('up');
  });

  type Waited = (times: { now: number; endsAt: number }) => number;
  it.each<[string, Waited, string]>([
    ['its request expired', () => 601, 'Expired'],
    ["the epoch's stop time came", (times) => times.endsAt - times.now - 100, 'EpochEnding'],
  ])('refuses a call when %s while it waited for the one before it, without its backend', async (_when, waited, code) => {
    const id = await fund();
    const times = await chain.getEpochTimes();
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    const budgets = vi.spyOn(chain, 'getBudgets');
    let release!: () => void;
    const busy = new Promise<void>((resolve) => { release = resolve; });
    backend.during = () => busy;
    // The first call's request lasts to the epoch's end, the second's ten minutes.
    const first = seller.serve(wire(await requestFor(id, { expiry: times.endsAt })));
    await vi.waitFor(() => expect(backend.calls).toBe(1));
    const second = seller.serve(wire(await requestFor(id, { nonce: 1n })));
    // The second passes its checks and waits for the first, which takes `waited` seconds.
    await vi.waitFor(() => expect(budgets).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    skew = waited(times) * 1_000;
    release();
    expect(codeOf(await first)).toBe('ok');
    expect(await second).toMatchObject({ ok: false, code });
    expect(backend.calls).toBe(1);
  });

  it("stops its backend when the request expires, and does not count the backend as down", async () => {
    const id = await fund();
    const { now } = await chain.getEpochTimes();
    let reason: unknown;
    backend.during = (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reason = signal.reason; reject(new UpstreamError('the backend did not answer')); });
    });
    expect(await seller.serve(wire(await requestFor(id, { expiry: now + 2 })))).toEqual({ ok: false, code: 'Expired', retry: false });
    expect((reason as Error).name).toBe('TimeoutError');
    expect(seller.backendOf(A)).toBe('up');
  });

  it('refuses a call issued after the grant its subscription was funded under ended', async () => {
    const { accountId } = await mock.createPublishingConvictionAccount(120_000n * 10n ** 18n);
    await chain.setServiceSpending(accountId, true);
    const { now } = await chain.getEpochTimes();
    const terms = { accountId, buyer: BUYER, maxCostPerEpoch: 10n ** 24n, expiresAt: now + 86_400, nonce: 0n };
    const buyerKey = new ethers.Wallet(`0x${'55'.repeat(32)}`);
    const consent = buyerKey.signingKey.sign(hashBuyerGrant((await chain.getMarketplaceContracts()).grantDomain, { ...terms, buyer: buyerKey.address })).compactSerialized;
    await chain.addBuyer({ ...terms, buyer: buyerKey.address }, '0x', consent);
    const { epoch } = await chain.getEpochTimes();
    await chain.fundFromAccount({
      accountId, epoch, sessionKey: SESSION.address, planDigest: ethers.ZeroHash,
      budgets: [{ serviceId: A, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 6n, maxPricePerUnit: 100n }],
    }, { from: buyerKey.address });
    await chain.removeBuyer(accountId, buyerKey.address);
    const id = subscriptionIdOf(buyerKey.address, epoch);
    expect(codeOf(await seller.serve(wire(await requestFor(id))))).toBe('GrantEnded');
  });
});
