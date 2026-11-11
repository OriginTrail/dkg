// SPDX-License-Identifier: Apache-2.0
/**
 * What the buyer's gateway and access keys keep on disk, seen through what
 * they answer, against MockChainAdapter with the real seller in the same
 * process:
 *   - a restarted node reads back every call, key reservation, key total and
 *     nonce counter as the node left them;
 *   - an epoch made final leaves the same key totals and reconciliation after
 *     a restart;
 *   - a write that fails mid-call leaves what the node had applied before it:
 *     a nonce taken stays taken, a call not written down is not sent, and a
 *     receipt counted before its write stays counted, its key not charged.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  marketplaceChainOf,
  subscriptionIdOf,
  type MarketplaceChainAdapter,
} from '@origintrail-official/dkg-chain';
import {
  AccessKeys,
  Buyer,
  BuyerStore,
  DEFAULT_STOP_SERVING_SECONDS,
  Gateway,
  Router,
  Seller,
  decodeMessage,
  encodeMessage,
  serviceIdOf,
  signServiceOffer,
  type AccessKey,
  type Connector,
  type GatewayDeps,
  type QuoteResponse,
  type ServeResponse,
} from '../src/index.js';
import { Journal } from '../src/journal.js';

const NODE = new ethers.Wallet(`0x${'33'.repeat(32)}`);
const MODEL = 'urn:test:model:gateway-durability';
const PRICE = 10n;
const CHAT = { model: MODEL, messages: [{ role: 'user', content: 'synthetic question' }], max_tokens: 20 };
/** What CHAT may cost at PRICE, and what it costs when served. */
const MOST = 620n;
const COST = 120n;

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let seller: Seller;
let keys: AccessKeys;
let deps: GatewayDeps;
let gateway: Gateway;
let caller: { key: AccessKey };
let tamper: ((answer: ServeResponse) => ServeResponse) | undefined;
/** The nonce of every request the gateway sent, in order. */
let nonces: string[];
let routerOf: () => Router;

const backend: Connector = { kind: 'openai', complete: async () => ({ content: 'synthetic answer', promptTokens: 7, completionTokens: 5 }) };
const call = (g: Gateway = gateway) => g.chatCompletion(caller, CHAT);

async function setUp(): Promise<void> {
  await mock.ensureProfile();
  const buyer = new Buyer({ chain, store: new BuyerStore(join(dir, 'buyer')), config: { enabled: true, buyerWallet: NODE.address, prefundLeadSeconds: 7_200, tickSeconds: 300 } });
  const { epoch } = await chain.getEpochTimes();
  await buyer.fund({ epoch, source: { kind: 'wallet' }, services: [{ serviceId: serviceIdOf(MODEL), serviceClass: 1, value: 10n ** 6n, maxPricePerUnit: 100n }] });
  seller = new Seller({
    chain, dir: join(dir, 'seller'), signer: NODE.address, peerId: 'seller-peer', stopServingSeconds: DEFAULT_STOP_SERVING_SECONDS, tickSeconds: 300,
    services: [{ model: MODEL, serviceId: serviceIdOf(MODEL), pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed' as const, connector: backend }],
  });
  await seller.load();
  await seller.tick();
  const domain = (await chain.getMarketplaceContracts()).requestDomain;
  const offers = [await signServiceOffer(chain, NODE.address, domain, {
    seller: seller.gate.identityId, serviceId: serviceIdOf(MODEL), serviceClass: 1, unit: 'token', model: MODEL, provenance: 'upstream-claimed',
    capacity: null, peerId: 'seller-peer', pricePerUnit: PRICE, priceEpoch: epoch, validUntilEpoch: epoch + 12, withdrawn: false, signedAt: 1,
  })];
  routerOf = () => new Router({ chain, offers: async () => offers, quote: async (_peer, services) => seller.quote({ services }) as Promise<QuoteResponse> });
  keys = new AccessKeys(join(dir, 'buyer'));
  deps = {
    chain, buyerWallet: NODE.address, store: buyer.store, router: routerOf(), keys,
    send: async (_peer, payload) => {
      const message = decodeMessage(payload) as { request: { nonce: string } };
      nonces.push(message.request.nonce);
      const answer = await seller.serve(message as never, 'buyer-peer');
      return encodeMessage(tamper ? tamper(answer) : answer);
    },
  };
  gateway = new Gateway(deps);
  await gateway.load();
  caller = { key: (await keys.make({ label: 'test-agent', budget: 10n ** 30n, services: null, rps: 1_000, expiresAt: null }, 0)).key };
}

/** A restarted node: keys and gateway read back from disk, with a router of its own. */
async function restart(): Promise<void> {
  keys = new AccessKeys(join(dir, 'buyer'));
  deps = { ...deps, keys, router: routerOf() };
  gateway = new Gateway(deps);
  await gateway.load();
}

/** What the node answers about its calls and keys: the keys, what each reserves, the budget's held value, the calls. */
async function stateOf() {
  const { epoch } = await chain.getEpochTimes();
  const list = await keys.list();
  return {
    keys: list,
    reserved: Object.fromEntries(list.map((k) => [k.keyId, keys.reservedOf(k.keyId)])),
    held: gateway.heldValue(subscriptionIdOf(NODE.address, epoch), 0),
    calls: (await gateway.activity()).calls,
  };
}

/** Fail the `n`th append to a buyer's journal from now, once, as a full disk would. The seller's journals are its own. */
function failAppend(n: number): void {
  const append = Journal.prototype.append;
  let seen = 0;
  vi.spyOn(Journal.prototype, 'append').mockImplementation(function (this: Journal<unknown>, entry: unknown) {
    if (this.file.startsWith(join(dir, 'buyer')) && ++seen === n) return Promise.reject(new Error('disk full'));
    return append.call(this, entry);
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-gateway-durability-'));
  mock = new MockChainAdapter('mock:31337', NODE.address);
  mock.setMockACKSigner(NODE);
  chain = marketplaceChainOf(mock)!;
  tamper = undefined;
  nonces = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('a restarted node', () => {
  it('reads back every call, key reservation, key total and nonce counter as the node left them', async () => {
    await setUp();
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    // Refused for good by the seller: open, at its most value.
    tamper = () => ({ ok: false, code: 'BudgetExhausted', retry: false });
    expect((await call()).status).toBe(502);
    deps.router = routerOf();
    // Unanswered: open too.
    tamper = () => { throw new Error('timed out'); };
    expect((await call()).status).toBe(503);
    deps.router = routerOf();
    // A receipt that fails a check: refused.
    tamper = (a) => (a.ok ? { ...a, receiptSignature: '0x00' } : a);
    expect((await call()).status).toBe(502);
    tamper = undefined;
    const other = (await keys.make({ label: 'revoked', budget: 5n, services: null, rps: 1, expiresAt: 99 }, 7)).key;
    await keys.revoke(other.keyId, 8);
    const before = await stateOf();
    expect(before.keys.find((k) => k.keyId === caller.key.keyId)).toMatchObject({ spent: String(2n * COST) });
    expect(before.reserved[caller.key.keyId]).toBe(3n * MOST);
    expect(before.held).toBe(2n * COST + 3n * MOST);
    expect(nonces).toEqual(['0', '1', '2', '3', '4']);

    await restart();
    expect(await stateOf()).toEqual(before);
    // The next request takes the next nonce.
    expect((await call()).status).toBe(200);
    expect(nonces.at(-1)).toBe('5');
  });

  it('keeps the key totals and the reconciliation of an epoch made final', async () => {
    await setUp();
    const { epoch } = await chain.getEpochTimes();
    expect((await call()).status).toBe(200);
    tamper = () => ({ ok: false, code: 'BudgetExhausted', retry: false });
    expect((await call()).status).toBe(502);
    tamper = undefined;
    // Both requests land: the refused one is charged its most value once its epoch is made final.
    vi.spyOn(chain, 'nonceWord').mockResolvedValue(3n);
    await gateway.tick();
    mock.__advanceEpoch();
    await gateway.tick();
    mock.__advanceEpoch();
    await gateway.tick();
    const reconciled = await gateway.reconciliation(epoch);
    expect(reconciled.final).toBe(true);
    const totals = await keys.list();
    expect(totals[0]).toMatchObject({ spent: String(COST + MOST) });
    expect(keys.reservedOf(caller.key.keyId)).toBe(0n);

    await restart();
    expect(await gateway.reconciliation(epoch)).toEqual(reconciled);
    expect(await keys.list()).toEqual(totals);
    expect(keys.reservedOf(caller.key.keyId)).toBe(0n);
    // A tick of the restarted node makes nothing final again, nor charges again.
    await gateway.tick();
    expect(await keys.list()).toEqual(totals);
  });
});

describe('a write that fails mid-call', () => {
  it('leaves a nonce taken when its own write fails: the call is not sent, and the next takes the one after', async () => {
    await setUp();
    failAppend(1);
    await expect(call()).rejects.toThrow('disk full');
    vi.restoreAllMocks();
    expect(nonces).toEqual([]);
    expect(keys.reservedOf(caller.key.keyId)).toBe(0n);
    const { epoch } = await chain.getEpochTimes();
    expect(gateway.heldValue(subscriptionIdOf(NODE.address, epoch), 0)).toBe(0n);
    expect((await call()).status).toBe(200);
    expect(nonces).toEqual(['1']);
  });

  it('sends nothing when the call cannot be written down before it goes, and gives back its key reservation', async () => {
    await setUp();
    failAppend(2);
    await expect(call()).rejects.toThrow('disk full');
    vi.restoreAllMocks();
    expect(nonces).toEqual([]);
    expect(keys.reservedOf(caller.key.keyId)).toBe(0n);
    const { epoch } = await chain.getEpochTimes();
    expect(gateway.heldValue(subscriptionIdOf(NODE.address, epoch), 0)).toBe(0n);
    expect((await gateway.activity()).calls).toEqual([]);
    // Its nonce was on disk before it failed: a restarted node goes on after it.
    await restart();
    expect((await call()).status).toBe(200);
    expect(nonces).toEqual(['1']);
  });

  it("counts a served call whose receipt cannot be written, without charging its key, until a restart reads the call's first record", async () => {
    await setUp();
    const { epoch } = await chain.getEpochTimes();
    const subscriptionId = subscriptionIdOf(NODE.address, epoch);
    failAppend(3);
    await expect(call()).rejects.toThrow('disk full');
    vi.restoreAllMocks();
    expect(nonces).toEqual(['0']);
    expect(gateway.heldValue(subscriptionId, 0)).toBe(COST);
    expect((await keys.list())[0]).toMatchObject({ spent: '0' });
    expect(keys.reservedOf(caller.key.keyId)).toBe(MOST);
    // On disk the call is the record written before it was sent.
    await restart();
    expect(gateway.heldValue(subscriptionId, 0)).toBe(MOST);
    expect((await keys.list())[0]).toMatchObject({ spent: '0' });
    expect(keys.reservedOf(caller.key.keyId)).toBe(MOST);
    expect((await gateway.activity()).calls).toMatchObject([{ problem: 'sent', value: String(MOST) }]);
  });
});
