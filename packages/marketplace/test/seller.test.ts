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
  receiptFromWire,
  receiptSignerOf,
  requestToWire,
  resultCommitmentOf,
  serviceIdOf,
  serviceOfferSignerOf,
  serviceOffersFromBindings,
  type Completion,
  type Connector,
  type OfferAssets,
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
// A short question: its input bound, 25 units, is under the smallest cap a case sets (30 units).
const BODY = { messages: [{ role: 'user' as const, content: 'q' }], max_tokens: 50 };

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
let backend: { next: Completion | Error; calls: number };
/** Each publish's name and quads; `failing` makes the next ones throw. */
let published: Array<{ name: string; quads: OfferQuad[] }>;
let failing: Error | undefined;
/** Each asset's id by its name, put on the mock chain at its first publish. */
let kaIds: Map<string, bigint>;
const offers: OfferAssets = {
  contextGraphId: 'test-marketplace',
  publish: async (name, quads) => {
    if (failing) throw failing;
    published.push({ name, quads });
    let kaId = kaIds.get(name);
    if (kaId === undefined) {
      kaIds.set(name, kaId = BigInt(kaIds.size + 1));
      const { epoch } = await chain.getEpochTimes();
      mock.__registerKC({ kaId, contextGraphId: 1n, merkleRootHex: ethers.ZeroHash, chunks: [], startEpoch: BigInt(epoch), endEpoch: BigInt(epoch + 12) });
    }
    return { kaId };
  },
  recover: async () => undefined,
};

const connector: Connector = {
  kind: 'openai',
  async complete() {
    backend.calls++;
    if (backend.next instanceof Error) throw backend.next;
    return backend.next;
  },
};

function serviceOf(model: string, pricePerUnit = PRICE): SellerService {
  return { model, serviceId: serviceIdOf(model), pricePerUnit, capacity: 4, provenance: 'upstream-claimed', connector };
}

/** A seller of A and B; with `offers`, one that publishes them. */
function sellerWith(over: { stopServingSeconds?: number; price?: bigint; offers?: boolean } = {}): Seller {
  return new Seller({
    chain,
    dir,
    services: [serviceOf(MODEL_A, over.price), serviceOf(MODEL_B, over.price)],
    signer: SELLER.address,
    peerId: 'seller-peer',
    stopServingSeconds: over.stopServingSeconds ?? 180,
    tickSeconds: 300,
    ...(over.offers ? { offers } : {}),
  });
}

/** The offer a publish's quads hold, read back as a buyer's query returns it. */
function offerIn(quads: OfferQuad[]) {
  const row: Record<string, string> = { offer: quads[0]!.subject };
  for (const q of quads) if (q.predicate.startsWith(MARKETPLACE_NS)) row[q.predicate.slice(MARKETPLACE_NS.length)] = q.object;
  return serviceOffersFromBindings([row])[0]!;
}

/** A tick, then a run of the offer job once the tick's own run is done. */
async function settle(seller: Seller): Promise<void> {
  await seller.tick();
  await seller.offers!.run();
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
  published = [];
  failing = undefined;
  kaIds = new Map();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the gate, quotes and offers', () => {
  it('serves nothing before its first tick, nor while it is not a Core Node, and publishes no offer then', async () => {
    const seller = sellerWith({ offers: true });
    await seller.load();
    const id = await fund();
    expect(codeOf(await seller.serve(wire(await requestFor(id))))).toBe('NotServing');
    vi.spyOn(chain, 'isShardingTableMember').mockResolvedValue(false);
    await settle(seller);
    expect(seller.gate.open).toBe(false);
    expect(published).toEqual([]);
    expect((await seller.quote({ services: [A] })).offers[0]!.available).toBe(false);
  });

  it('publishes an offer per service, signed and naming its peer, and quotes its frozen price', async () => {
    const seller = sellerWith({ offers: true });
    await seller.load();
    await settle(seller);
    await settle(seller);
    const { epoch } = await chain.getEpochTimes();
    expect(published.map((p) => p.name).sort()).toEqual([`offer-${A}`, `offer-${B}`].sort());
    for (const { quads } of published) {
      const o = offerIn(quads);
      expect(o).toMatchObject({ seller: seller.gate.identityId, pricePerUnit: PRICE, priceEpoch: epoch, capacity: 4, peerId: 'seller-peer' });
      expect(serviceOfferSignerOf(domain, o)).toBe(SELLER.address);
    }
    expect(await seller.quote({ services: [A, `0x${'99'.repeat(32)}`] })).toEqual({
      seller: String(seller.gate.identityId), epoch, offers: [{ serviceId: A, pricePerUnit: '10', available: true, capacity: 4 }],
    });

    // A new price applies from the next epoch: this one's stays frozen, on disk, and the offer says both.
    const repriced = sellerWith({ price: 20n, offers: true });
    await repriced.load();
    await settle(repriced);
    expect((await repriced.quote({ services: [A] })).offers[0]!.pricePerUnit).toBe('10');
    expect(published.slice(2).map((p) => offerIn(p.quads)).map((o) => [o.pricePerUnit, o.nextPricePerUnit])).toEqual([[10n, 20n], [10n, 20n]]);
    await expect(repriced.quote({ services: ['0x01'] })).rejects.toThrow(/32 bytes/);
  });

  it('publishes each offer once when two ticks run at once', async () => {
    const seller = sellerWith({ offers: true });
    await seller.load();
    await Promise.all([seller.tick(), seller.tick()]);
    await seller.offers!.run();
    expect(published).toHaveLength(2);
  });
});

describe('the job', () => {
  it('ticks at start and stops', async () => {
    const seller = sellerWith({ offers: true });
    await seller.load();
    seller.start();
    seller.start();
    await seller.stop();
    expect(seller.gate.open).toBe(true);
    expect(published).toHaveLength(2);
    expect(receiptSignerOf(domain, { requestDigest: ethers.ZeroHash, resultCommitment: ethers.ZeroHash, units: 1n, valueWei: 1n, completedAt: 1 }, '0x00')).toBeNull();
  });

  it('lands even when its offers fail, logs what failed, and goes on to the next tick', async () => {
    const logs: string[] = [];
    failing = new Error('the graph is away');
    const seller = new Seller({
      chain, dir, services: [serviceOf(MODEL_A)], signer: SELLER.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
      offers, log: (m) => logs.push(m),
    });
    await seller.load();
    const landing = vi.spyOn(seller.lander, 'tick').mockRejectedValueOnce(new Error('no chain'));
    expect(await seller.tick()).toBeGreaterThan(0);
    await seller.offers!.run();
    expect(logs).toContainEqual(expect.stringMatching(/landing failed: no chain/));
    expect(logs).toContainEqual(expect.stringMatching(/offer of .* was not kept \(error\), tried again in 300 s: the graph is away/));
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

  it.each([40, 60])('serves a request that lasts %i days, its receipt completed before it expires', async (days) => {
    // No timer runs to a request's expiry: one past the longest a timer can wait (about 24.8 days) fires after 1 ms.
    // So the backend answers only after 50 ms, and a call cut short by such a timer would have failed by then.
    const id = await fund();
    const { now } = await chain.getEpochTimes();
    const request = await requestFor(id, { expiry: now + days * 86_400 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const complete = connector.complete.bind(connector);
    const backendCall = vi.spyOn(connector, 'complete').mockImplementationOnce(async (input) => {
      await held;
      return complete(input);
    });
    const serving = seller.serve(wire(request));
    await vi.waitFor(() => expect(backendCall).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const answer = await serving as ServeAnswer;
    backendCall.mockRestore();
    expect(answer.ok).toBe(true);
    expect(receiptFromWire(answer.receipt).completedAt).toBeLessThanOrEqual(request.expiry);
    expect(backend.calls).toBe(1);
  });

  it('cuts an overrun to the units the request allows, and refuses an input that leaves none', async () => {
    const id = await fund();
    backend.next = { content: 'abcdefghij', promptTokens: 10, completionTokens: 100 };
    const cut = await seller.serve(wire(await requestFor(id, { maxUnits: 60n }))) as ServeAnswer;
    expect(cut.result.content).toBe('abcde');
    expect(receiptFromWire(cut.receipt)).toMatchObject({ units: 60n, valueWei: 600n, resultCommitment: resultCommitmentOf('abcde') });
    // A value cap lower than its units allow cuts too.
    const capped = await seller.serve(wire(await requestFor(id, { nonce: 1n, maxUnits: 1_000n, maxValueWei: 300n }))) as ServeAnswer;
    expect(receiptFromWire(capped.receipt).units).toBe(30n);
    backend.next = { content: 'x', promptTokens: 60, completionTokens: 1 };
    expect(codeOf(await seller.serve(wire(await requestFor(id, { nonce: 2n, maxUnits: 60n }))))).toBe('UnitsTooFew');
    expect(cutTo('héllo wörld', 10, 5)).toBe('héllo');
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
