// SPDX-License-Identifier: Apache-2.0
/**
 * The buyer's gateway, router and access keys against MockChainAdapter, with
 * the real seller in the same process as the far end (`send` calls it), and a
 * stub backend: a call through to its receipt, the soft ceiling, the boundary,
 * a bad receipt taking its seller out of routing, the router's order and its
 * memory, the keys' scopes, and what landed: the held value at the gateway's
 * tick, reconciliation, and an ended epoch made final.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  hashQueryInferenceReceipt,
  marketplaceChainOf,
  requestDomain,
  subscriptionIdOf,
  type MarketplaceChainAdapter,
  type MarketplaceContracts,
  type MarketplaceDomain,
} from '@origintrail-official/dkg-chain';
import {
  AccessKeys,
  BUYER_LEDGER_FILE,
  Buyer,
  BuyerStore,
  Gateway,
  Router,
  Seller,
  decodeMessage,
  encodeMessage,
  SIGNER_TTL_MS,
  UNREACHABLE_MS,
  hashServiceOffer,
  receiptFromWire,
  serviceIdOf,
  signServiceOffer,
  type Connector,
  type AccessKey,
  type GatewayAnswer,
  type GatewayDeps,
  type ServeResponse,
  type ServiceOffer,
} from '../src/index.js';

const NODE = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const MODEL = 'urn:test:model:gateway';
const SERVICE = serviceIdOf(MODEL);
const PRICE = 10n;
const CHAT = { model: MODEL, messages: [{ role: 'user', content: 'synthetic question' }], max_tokens: 20 };

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let seller: Seller;
let router: Router;
let gateway: Gateway;
let gatewayDeps: GatewayDeps;
let keys: AccessKeys;
let offers: ServiceOffer[];
let tamper: ((answer: ServeResponse) => ServeResponse) | undefined;
let reachable: boolean;
let DOMAIN: MarketplaceDomain | undefined;
let caller: { key: AccessKey };
const call = (chat: unknown = CHAT, g: Gateway = gateway) => g.chatCompletion(caller, chat);

const backend: Connector = { kind: 'openai', complete: async () => ({ content: 'synthetic answer', promptTokens: 7, completionTokens: 5 }) };
const body = (a: GatewayAnswer) => a.body as any;
/** The ledger's records of one kind, oldest first. */
const ledgerLines = async (type: string) => (await readFile(join(dir, 'buyer', BUYER_LEDGER_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  .filter((e) => e.type === type);

async function setUp(value = 10n ** 6n, models: string[] = [MODEL]): Promise<void> {
  // One mock chain for both ends: the node's wallet buys, and its identity sells.
  await mock.ensureProfile();
  const buyer = new Buyer({ chain, store: new BuyerStore(join(dir, 'buyer')), config: { enabled: true, buyerWallet: NODE.address, prefundLeadSeconds: 7_200, tickSeconds: 300 } });
  const { epoch } = await chain.getEpochTimes();
  await buyer.fund({ epoch, source: { kind: 'wallet' }, services: models.map((m) => ({ serviceId: serviceIdOf(m), serviceClass: 1, value, maxPricePerUnit: 100n })) });
  seller = new Seller({
    chain, dir: join(dir, 'seller'), signer: NODE.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
    services: models.map((m) => ({ model: m, serviceId: serviceIdOf(m), pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed' as const, connector: backend })),
  });
  await seller.load();
  await seller.tick();
  const domain = (await chain.getMarketplaceContracts()).requestDomain;
  offers = await Promise.all(models.map((m) => signServiceOffer(chain, NODE.address, domain, {
    seller: seller.gate.identityId, serviceId: serviceIdOf(m), serviceClass: 1, unit: 'token', model: m, provenance: 'upstream-claimed',
    capacity: null, peerId: 'seller-peer', pricePerUnit: PRICE, priceEpoch: epoch, validUntilEpoch: epoch + 12, withdrawn: false, signedAt: 1,
  })));
  router = new Router({
    chain,
    offers: async () => offers,
    quote: async (_peer, services) => {
      if (!reachable) throw new Error('unreachable');
      return seller.quote({ services });
    },
  });
  keys = new AccessKeys(join(dir, 'buyer'));
  gatewayDeps = {
    chain, buyerWallet: NODE.address, store: buyer.store, router, keys,
    send: async (_peer, payload) => {
      if (!reachable) throw new Error('unreachable');
      const answer = await seller.serve(decodeMessage(payload));
      return encodeMessage(tamper ? tamper(answer) : answer);
    },
    modelOf: async (serviceId) => offers.find((o) => o.serviceId === serviceId)?.model,
  };
  gateway = new Gateway(gatewayDeps);
  await gateway.load();
  caller = { key: (await keys.make({ label: 'test-agent', budget: 10n ** 30n, services: null, rps: 1_000, expiresAt: null }, 0)).key };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-gateway-'));
  mock = new MockChainAdapter('mock:31337', NODE.address);
  mock.setMockACKSigner(NODE);
  chain = marketplaceChainOf(mock)!;
  tamper = undefined;
  reachable = true;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('a call through the gateway', () => {
  it('is served by the routed seller, its receipt checked and kept, and the answer is OpenAI-shaped', async () => {
    await setUp();
    expect(body(await gateway.models())).toEqual({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'dkg-marketplace', service_id: SERVICE }] });
    const answer = await call();
    expect(answer.status).toBe(200);
    expect(body(answer)).toMatchObject({
      object: 'chat.completion', model: MODEL, choices: [{ message: { role: 'assistant', content: 'synthetic answer' } }], usage: { total_tokens: 12 },
      marketplace: { serviceId: SERVICE, seller: Number(seller.gate.identityId), units: 12, value: '120' },
    });
    // The next call gets the next nonce; a restart remembers it.
    const restarted = new Gateway({ ...gatewayDeps, keys: new AccessKeys(join(dir, 'buyer')) });
    await restarted.load();
    expect((await call(CHAT, restarted)).status).toBe(200);
  });

  it('runs calls on two services of one subscription at once, each with its own nonce', async () => {
    const other = 'urn:test:model:gateway-two';
    await setUp(10n ** 6n, [MODEL, other]);
    const answers = await Promise.all([call(), call({ ...CHAT, model: other })]);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    const nonces = (await ledgerLines('nonce')).map((l) => l.nonce);
    expect(nonces.sort()).toEqual(['0', '1']);
  });

  it('answers without a subscription, at the soft ceiling, and in the boundary gap', async () => {
    // 700 wei: the soft ceiling is 665, and a call reserves 62 units (18 bytes, 24 of allowance, 20 tokens) × 10 wei.
    await setUp(700n);
    expect(body(await call({ ...CHAT, model: 'urn:test:model:none' })).error.code).toBe('no_subscription');
    const first = await call();
    expect(first.status).toBe(200);
    const ceiling = await call();
    expect(ceiling.status).toBe(402);
    expect(body(ceiling)).toMatchObject({ error: { code: 'soft_ceiling' }, serviceId: SERVICE, fork: { topUp: true } });

    const times = await chain.getEpochTimes();
    vi.spyOn(chain, 'getEpochTimes').mockResolvedValue({ ...times, now: times.endsAt - 100 });
    const gap = await call();
    expect(gap).toMatchObject({ status: 503, headers: { 'Retry-After': '100' } });
    expect(body(gap).error.code).toBe('epoch_ending');
  });

  it('takes a seller whose receipt over-reports out of routing for the epoch', async () => {
    await setUp();
    tamper = (answer) => (answer.ok ? { ...answer, receipt: { ...answer.receipt, units: '100000', valueWei: '1000000' } } : answer);
    const bad = await call();
    expect(bad.status).toBe(502);
    expect(body(bad)).toMatchObject({ error: { code: 'bad_receipt' }, problem: 'units_over_max' });
    tamper = undefined;
    expect(body(await call()).error.code).toBe('no_seller');
  });

  it.each([
    ['result_mismatch', (a: ServeResponse) => (a.ok ? { ...a, result: { content: 'another answer' } } : a)],
    ['other_request', (a: ServeResponse) => (a.ok ? { ...a, receipt: { ...a.receipt, requestDigest: ethers.ZeroHash } } : a)],
    ['bad_signature', (a: ServeResponse) => (a.ok ? { ...a, receiptSignature: '0x00' } : a)],
    ['value_mismatch', (a: ServeResponse) => (a.ok ? { ...a, receipt: { ...a.receipt, valueWei: '1' } } : a)],
    ['other_budget', (a: ServeResponse) => (a.ok ? { ...a, budgetIndex: 3 } : a)],
    ['malformed', (a: ServeResponse) => (a.ok ? { ...a, receipt: { ...a.receipt, units: 12 as unknown as string } } : a)],
    ['not_a_seller_key', (a: ServeResponse) => {
      if (!a.ok) return a;
      const stranger = new ethers.Wallet(`0x${'66'.repeat(32)}`);
      return { ...a, receiptSignature: stranger.signingKey.sign(hashQueryInferenceReceipt(DOMAIN!, receiptFromWire(a.receipt))).serialized };
    }],
  ])('refuses a receipt with %s', async (problem, t) => {
    await setUp();
    DOMAIN = (await chain.getMarketplaceContracts()).requestDomain;
    tamper = t;
    expect(body(await call())).toMatchObject({ problem });
  });

  it.each([
    ['a result without text', (a: ServeResponse) => ({ ...a, result: { content: 7 } })],
    ['a refusal with an unknown code', () => ({ ok: false, code: 'NoSuchCode', retry: true })],
    ['no ok', () => ({ answer: 'synthetic answer' })],
  ])('takes an answer with %s as no answer: the call stays held, and the seller is left out', async (_what, t) => {
    await setUp();
    tamper = t as unknown as (a: ServeResponse) => ServeResponse;
    expect(await call()).toMatchObject({ status: 503, body: { error: { code: 'seller_unreachable' } } });
    expect(gateway.heldValue(subscriptionIdOf(NODE.address, (await chain.getEpochTimes()).epoch), 0)).toBe(620n);
    tamper = undefined;
    expect(body(await call()).error.code).toBe('no_seller');
  });

  it("keeps a receipt whose signer the chain could not check, and retries a lost answer once", async () => {
    await setUp();
    vi.spyOn(chain, 'verifyACKIdentityDetailed').mockResolvedValueOnce({ valid: false, reason: 'rpc-error' });
    expect((await call()).status).toBe(200);
    const send = gatewayDeps.send;
    let first = true;
    gatewayDeps.send = async (peer, payload, messageId) => {
      if (first) { first = false; return new TextEncoder().encode('RESPONSE_GONE'); }
      expect(messageId.endsWith(':1')).toBe(true);
      return send(peer, payload, messageId);
    };
    expect((await call()).status).toBe(200);
  });

  it('asks for a new quote after a price change, and answers without the session key', async () => {
    await setUp();
    tamper = () => ({ ok: false, code: 'WrongPrice', retry: true });
    expect(body(await call())).toMatchObject({ sellerCode: 'WrongPrice' });
    tamper = () => ({ ok: false, code: 'EpochEnding', retry: true });
    expect(body(await call())).toMatchObject({ sellerCode: 'EpochEnding' });
    tamper = undefined;
    // A gateway that has not opened the subscription's session key, which this node does not hold.
    const fresh = new Gateway(gatewayDeps);
    vi.spyOn(gatewayDeps.store, 'sessionKeyAddress').mockResolvedValueOnce(null);
    expect(await call(CHAT, fresh)).toMatchObject({ status: 500, body: { error: { code: 'session_key_missing' } } });
    expect(fresh.keys).toBe(keys);
    // Without a subscription, no models.
    vi.spyOn(chain, 'subscriptionExists').mockResolvedValueOnce(false);
    expect(body(await gateway.models()).data).toEqual([]);
  });

  it('moves on from a seller that does not answer', async () => {
    await setUp();
    reachable = false;
    expect(body(await call()).error.code).toBe('no_seller');
    reachable = true;
    // Left out for ten minutes.
    expect(body(await call()).error.code).toBe('no_seller');
  });

  it('answers 503 when the quoted seller does not answer the call', async () => {
    await setUp();
    gatewayDeps.send = async () => { throw new Error('timed out'); };
    expect(await call()).toMatchObject({ status: 503, body: { error: { code: 'seller_unreachable' } } });
  });

  it("passes on a seller's refusal", async () => {
    await setUp();
    tamper = () => ({ ok: false, code: 'UpstreamError', retry: true });
    expect(body(await call())).toMatchObject({ error: { code: 'seller_refused' }, sellerCode: 'UpstreamError', retry: true });
  });

  it('refuses a bad body, and a call larger than a seller takes without blaming the seller', async () => {
    await setUp(10n ** 12n);
    for (const bad of [{ ...CHAT, model: '' }, { ...CHAT, stream: true }, { ...CHAT, messages: [] }, null]) {
      expect((await call(bad)).status).toBe(400);
    }
    const large = await call({ ...CHAT, messages: [{ role: 'user', content: 'x'.repeat(600 * 1024) }] });
    expect(large).toMatchObject({ status: 413, body: { error: { code: 'request_too_large' } } });
    expect((await call()).status).toBe(200);
  });
});

describe('access keys', () => {
  /** A call as the gateway's route makes it: the caller checked first, then the body. */
  const callWith = async (token: string | undefined, chat: unknown = CHAT): Promise<GatewayAnswer> => {
    const checked = await gateway.callerOf(token);
    return 'answer' in checked ? checked.answer : gateway.chatCompletion(checked.caller, chat);
  };

  it('are shown once, kept hashed, and hold their scopes: services, budget, rate, expiry, revocation', async () => {
    await setUp();
    const now = Math.floor(Date.now() / 1000);
    const { secret, key } = await keys.make({ label: 'test-agent', budget: 700n, services: [SERVICE], rps: 1, expiresAt: now + 3_600 }, now);
    expect(secret).toMatch(/^dkgmk_[0-9a-f]{48}$/);
    // The id is the secret's first 16 hex digits after the prefix: 64 bits.
    expect(key).toMatchObject({ keyId: secret.slice(0, 22), label: 'test-agent', budget: '700', spent: '0', revoked: false });
    expect(JSON.stringify(await keys.list())).not.toContain(secret.slice(14));

    // Refused before the body is looked at: no key, a key of another node, a node or agent token.
    for (const token of [undefined, `dkgmk_${'00'.repeat(24)}`, 'a-node-or-agent-token']) {
      expect(await callWith(token, null)).toMatchObject({ status: 401 });
    }
    expect((await callWith(secret)).status).toBe(200);
    expect((await keys.list()).find((k) => k.keyId === key.keyId)!.spent).toBe('120');
    // One call a second.
    expect(body(await callWith(secret)).error.code).toBe('key_rate');
    await new Promise((r) => setTimeout(r, 1_050));
    // Out of its services, before any chain read.
    const reads = vi.spyOn(chain, 'getEpochTimes');
    expect(await callWith(secret, { ...CHAT, model: 'urn:test:model:other' })).toMatchObject({ status: 401, body: { error: { code: 'service_not_allowed' } } });
    expect(reads).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 1_050));
    // Its budget: 700 wei, 120 spent, and a call may cost 620.
    expect(body(await callWith(secret)).error.code).toBe('key_budget');

    expect(await keys.check(secret, now + 3_600)).toMatchObject({ ok: false, code: 'expired_key' });
    await keys.revoke(key.keyId, now);
    expect(await keys.check(secret, now)).toMatchObject({ ok: false, code: 'revoked_key' });
    expect(await keys.revoke('dkgmk_none', now)).toBeNull();
    await expect(keys.make({ label: 'x', budget: 1n, services: null, rps: 0, expiresAt: null }, now)).rejects.toThrow(/rps/);
  });
});

describe('the router', () => {
  const domain = requestDomain(31337, ethers.Wallet.createRandom().address);
  /** Each seller's operational wallet, made at runtime; the chain below maps it to the seller. */
  const wallets = new Map<bigint, ethers.HDNodeWallet>();
  const walletOf = (seller: bigint) => wallets.get(seller) ?? wallets.set(seller, ethers.Wallet.createRandom()).get(seller)!;
  /** An offer of `seller` from epoch 1 on, naming `peer-<seller>`, signed at 1 by the seller's wallet. */
  const offer = (seller: bigint, price: bigint, over: { epoch?: number; by?: ethers.HDNodeWallet; peerId?: string; signedAt?: number } = {}): ServiceOffer => {
    const unsigned = {
      seller, serviceId: SERVICE, serviceClass: 1, unit: 'token' as const, model: MODEL, provenance: 'upstream-claimed' as const, capacity: null,
      peerId: over.peerId ?? `peer-${seller}`, pricePerUnit: price, priceEpoch: over.epoch ?? 1, validUntilEpoch: 12, withdrawn: false,
      signedAt: over.signedAt ?? 1,
    };
    return { ...unsigned, signature: (over.by ?? walletOf(seller)).signingKey.sign(hashServiceOffer(domain, unsigned)).serialized };
  };
  let clock: number;
  let quoted: string[];
  /** The epoch the sellers quote for. */
  let quotedEpoch: number;
  let list: ServiceOffer[];
  /** The wallets the chain was asked about, in order; while `chainDown`, every read fails. */
  let identityReads: string[];
  let chainDown: boolean;
  const routerWith = (pinned: bigint[] = []) => new Router({
    chain: {
      isShardingTableMember: async (id) => id !== 9n,
      getMarketplaceContracts: async () => ({ requestDomain: domain }) as MarketplaceContracts,
      getIdentityIdForAddress: async (address) => {
        identityReads.push(address);
        if (chainDown) throw new Error('socket hang up');
        return [...wallets].find(([, w]) => w.address === address)?.[0] ?? 0n;
      },
    },
    offers: async () => list,
    quote: async (peer, services) => {
      quoted.push(peer);
      if (peer === 'peer-3') throw new Error('unreachable');
      if (peer === 'peer-11') return { seller: '11', epoch: 1, offers: 'none' };
      const id = peer.slice(5);
      return { seller: id, epoch: quotedEpoch, offers: services.map((s) => ({ serviceId: s, pricePerUnit: String(list.find((o) => String(o.seller) === id)!.pricePerUnit), available: true, capacity: null })) };
    },
    pinned: async () => pinned,
    clock: () => clock,
  });

  beforeEach(() => { clock = 0; quoted = []; quotedEpoch = 1; list = []; identityReads = []; chainDown = false; wallets.clear(); });

  it('keeps only the offers an operational wallet of their seller signed, asking the chain once per wallet for five minutes', async () => {
    const stranger = ethers.Wallet.createRandom();
    list = [
      offer(1n, 30n),
      offer(2n, 20n, { by: stranger }),
      offer(3n, 10n, { by: walletOf(1n) }),
      { ...offer(4n, 10n), signature: '0x' },
      { ...offer(5n, 10n), pricePerUnit: 9n },
    ];
    const router = routerWith();
    expect((await router.offersOf([1])).map((o) => o.seller)).toEqual([1n]);
    // A wallet of no node, a wallet of another node, no signature, and a field changed after signing are all left out.
    expect(identityReads).toHaveLength(3);
    expect(identityReads.filter((a) => a === walletOf(1n).address)).toHaveLength(1);
    expect(identityReads).toContain(stranger.address);
    expect(await router.pick(SERVICE, 1, 100n)).toEqual({ seller: 1n, peerId: 'peer-1', pricePerUnit: 30n });
    expect(quoted).toEqual(['peer-1']);
    expect(identityReads).toHaveLength(3);

    // Five minutes on, the chain is asked again, and what it says now applies: the wallet is no longer one of the seller's.
    clock += SIGNER_TTL_MS - 1;
    await router.offersOf([1]);
    expect(identityReads).toHaveLength(3);
    wallets.delete(1n);
    clock += 1;
    expect(await router.offersOf([1])).toEqual([]);
    expect(identityReads).toHaveLength(6);
  });

  it('leaves out an offer while the chain cannot say who signed it, and asks again at the next read', async () => {
    list = [offer(1n, 30n)];
    const router = routerWith();
    chainDown = true;
    expect(await router.offersOf([1])).toEqual([]);
    expect(await router.pick(SERVICE, 1, 100n)).toBeNull();
    expect(quoted).toEqual([]);
    chainDown = false;
    expect((await router.offersOf([1])).map((o) => o.seller)).toEqual([1n]);
    expect(identityReads).toHaveLength(3);
  });

  it("keeps a seller's newest offer for a service and epoch, among those its wallet signed", async () => {
    // The newer copy's price is over the cap: routing goes by it, and asks no quote.
    list = [offer(1n, 30n, { signedAt: 5 }), offer(1n, 500n, { signedAt: 6 })];
    const router = routerWith();
    expect((await router.offersOf([1])).map((o) => o.pricePerUnit)).toEqual([500n]);
    expect(await router.pick(SERVICE, 1, 100n)).toBeNull();
    expect(quoted).toEqual([]);
    // A newer copy someone else signed hides nothing; of two copies signed at once, the higher signature is kept.
    const tied = [offer(2n, 20n, { signedAt: 5 }), offer(2n, 21n, { signedAt: 5 })];
    list = [offer(1n, 30n, { signedAt: 5 }), offer(1n, 10n, { signedAt: 9, by: ethers.Wallet.createRandom() }), ...tied];
    const newest = tied[0]!.signature.localeCompare(tied[1]!.signature) > 0 ? tied[0]! : tied[1]!;
    const kept = (await router.offersOf([1])).sort((a, b) => Number(a.seller - b.seller));
    expect(kept.map((o) => [o.seller, o.pricePerUnit])).toEqual([[1n, 30n], [2n, newest.pricePerUnit]]);
  });

  it("dials the peer an offer names, and routes only when it answers as the offer's seller", async () => {
    list = [offer(8n, 10n, { peerId: 'peer-2' }), offer(2n, 20n)];
    expect(await routerWith().pick(SERVICE, 1, 100n)).toEqual({ seller: 2n, peerId: 'peer-2', pricePerUnit: 20n });
    expect(quoted).toEqual(['peer-2', 'peer-2']);
  });

  it('orders by pin, price and latency, keeps to sellers in the table under the cap, and stays with the one that answered', async () => {
    list = [offer(1n, 30n), offer(2n, 20n), offer(9n, 1n), offer(4n, 500n), offer(5n, 10n, { by: walletOf(8n) }), offer(6n, 20n, { epoch: 2 })];
    const router = routerWith();
    router.measured(1n, 5);
    expect(await router.pick(SERVICE, 1, 100n)).toEqual({ seller: 2n, peerId: 'peer-2', pricePerUnit: 20n });
    expect(await routerWith([1n]).pick(SERVICE, 1, 100n)).toMatchObject({ seller: 1n });
    // Sticky: the cheaper seller that appears later does not take over.
    list.push(offer(7n, 15n));
    expect(await router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 2n });
    // Quotes are kept five minutes.
    expect(quoted.filter((p) => p === 'peer-2')).toHaveLength(1);
    clock += 5 * 60_000;
    await router.pick(SERVICE, 1, 100n);
    expect(quoted.filter((p) => p === 'peer-2')).toHaveLength(2);
  });

  it("asks again right after an epoch's boundary, while the last epoch's quote is within its five minutes", async () => {
    // One offer prices both epochs.
    list = [offer(2n, 20n)];
    const router = routerWith();
    expect(await router.pick(SERVICE, 1, 100n)).toEqual({ seller: 2n, peerId: 'peer-2', pricePerUnit: 20n });
    // A minute on, the next epoch starts: the quote for epoch 1 is kept for epoch 1 only.
    clock += 60_000;
    quotedEpoch = 2;
    expect(await router.pick(SERVICE, 2, 100n)).toEqual({ seller: 2n, peerId: 'peer-2', pricePerUnit: 20n });
    expect(quoted).toEqual(['peer-2', 'peer-2']);
    // Within its five minutes, the new quote is kept.
    expect(await router.pick(SERVICE, 2, 100n)).toMatchObject({ seller: 2n });
    expect(quoted).toEqual(['peer-2', 'peer-2']);
  });

  it('leaves out for ten minutes a seller whose quote does not read as one', async () => {
    list = [offer(11n, 10n)];
    const router = routerWith();
    expect(await router.pick(SERVICE, 1, 100n)).toBeNull();
    expect(await router.pick(SERVICE, 1, 100n)).toBeNull();
    expect(quoted).toEqual(['peer-11']);
    clock += UNREACHABLE_MS;
    expect(await router.pick(SERVICE, 1, 100n)).toBeNull();
    expect(quoted).toEqual(['peer-11', 'peer-11']);
  });

  it('routes a call past a seller whose quote does not read as one, to the next seller', async () => {
    list = [offer(11n, 10n), offer(2n, 20n)];
    const router = routerWith();
    expect((await router.pick(SERVICE, 1, 100n))?.seller).toBe(2n);
    expect(quoted).toEqual(['peer-11', 'peer-2']);
  });

  it('leaves out an unreachable seller for ten minutes and a failed one for the epoch', async () => {
    list = [offer(3n, 10n), offer(2n, 20n)];
    const router = routerWith();
    expect(await router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 2n });
    clock += 10 * 60_000;
    expect(quoted.filter((p) => p === 'peer-3')).toHaveLength(1);
    router.failed(2n, 1);
    expect(await router.pick(SERVICE, 1, 100n)).toBeNull();
    expect(await routerWith().pick(SERVICE, 1, 10n)).toBeNull();
  });
});

describe('landing, reconciliation and pruning', () => {
  /** The chain's time 31 seconds on, past the seller's margin for receipts just completed. */
  function laterBy(seconds: number): void {
    const real = chain.getEpochTimes.bind(chain);
    vi.spyOn(chain, 'getEpochTimes').mockImplementation(async () => {
      const t = await real();
      return { ...t, now: t.now + seconds };
    });
  }
  async function landAll(): Promise<void> {
    seller.lander.landNow();
    expect(await seller.lander.tick()).toMatchObject({ sent: [expect.anything()] });
  }

  it('takes the receipts that landed out of the held value at its tick, and matches them to what landed', async () => {
    // 1,000 wei: the soft ceiling is 950, and a call costs 120 and may cost 620.
    await setUp(1_000n);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    laterBy(31);
    await landAll();
    // Landed, and still held until the tick: 240 used, 240 held and 620 is over 950.
    expect(body(await call()).error.code).toBe('soft_ceiling');
    await gateway.tick();
    expect((await call()).status).toBe(200);

    const { epoch } = await chain.getEpochTimes();
    const reconciled = await gateway.reconciliation();
    expect(reconciled).toMatchObject({ epoch, final: false });
    expect(reconciled.rows).toEqual([{
      subscriptionId: expect.any(String), budgetIndex: 0, serviceId: SERVICE, seller: Number(seller.gate.identityId),
      held: { count: 1, value: '120', valueTrac: '0.00000000000000012' },
      landed: { count: 2, matched: 2, value: '240', valueTrac: '0.00000000000000024', counted: '240', countedTrac: '0.00000000000000024', txs: [expect.any(String)] },
    }]);
    // Read on from where it ended: the next read finds the same groups once.
    expect((await gateway.reconciliation()).rows[0]!.landed.count).toBe(2);
    expect((await gateway.reconciliation(epoch + 5)).rows).toEqual([]);

    // The calls, newest first: the two that landed, and the one still held, whose value the held value counts.
    const { subscriptionId } = reconciled.rows[0]!;
    expect(gateway.heldValue(subscriptionId.toUpperCase().replace('0X', '0x'), 0)).toBe(120n);
    const { calls } = await gateway.activity();
    expect(calls.map((c) => c.state)).toEqual(['held', 'landed', 'landed']);
    expect(calls[0]).toMatchObject({ serviceId: SERVICE, seller: Number(seller.gate.identityId), keyId: caller.key.keyId, units: 12, value: '120' });
    expect((await gateway.activity(undefined, 'dkgmk_none')).calls).toEqual([]);
    // Once the epoch ends, what did not land is missed.
    mock.__advanceEpoch();
    expect((await gateway.activity(epoch)).calls.map((c) => c.state)).toEqual(['missed', 'landed', 'landed']);
  });

  it('reads what landed from the block its subscription was funded in', async () => {
    await setUp();
    expect((await call()).status).toBe(200);
    const { epoch } = await chain.getEpochTimes();
    const subscriptionId = subscriptionIdOf(NODE.address, epoch);
    const funded = await gatewayDeps.store.fundingBlock(subscriptionId);
    expect(funded).toBeGreaterThan(0);
    const reads = vi.spyOn(chain, 'listReceiptsLanded');
    await gateway.reconciliation();
    expect(reads).toHaveBeenCalledWith(subscriptionId, funded);
    // Without the record, from the settlement's deployment.
    const elsewhere = new Gateway({ ...gatewayDeps, store: new BuyerStore(join(dir, 'elsewhere')) });
    await elsewhere.reconciliation();
    expect(reads).toHaveBeenLastCalledWith(subscriptionId, undefined);
  });

  it("does not match a receipt it refused, and makes an epoch final once the next one ends", async () => {
    await setUp();
    expect((await call()).status).toBe(200);
    // The seller keeps and lands its own receipt of a call whose answer the node refused.
    tamper = (answer) => (answer.ok ? { ...answer, receiptSignature: '0x00' } : answer);
    expect(body(await call())).toMatchObject({ problem: 'bad_signature' });
    tamper = undefined;
    laterBy(31);
    await landAll();
    await gateway.tick();
    const { epoch } = await chain.getEpochTimes();
    const rows = (await gateway.reconciliation()).rows;
    expect(rows).toMatchObject([{ held: { count: 0 }, landed: { count: 2, matched: 0, value: '240' } }]);

    mock.__advanceEpoch();
    expect(await gateway.reconciliation(epoch)).toEqual({ epoch, final: true, rows });
    await gateway.tick();
    // Two calls, each with its record from before it was sent and what came back in its place.
    const records = await ledgerLines('call');
    expect(records.map((r) => r.state)).toEqual(['open', 'held', 'open', 'refused']);
    expect(new Set(records.map((r) => r.callId)).size).toBe(2);
    mock.__advanceEpoch();
    await gateway.tick();
    // Its rows kept, its receipts and nonce counters gone, and the keys' costs folded in. The call whose receipt the
    // node refused landed too: its key is charged the most its request allowed (620), all the node can tell of it.
    expect(await ledgerLines('final')).toEqual([{ type: 'final', epoch, rows }]);
    expect(await ledgerLines('call')).toEqual([]);
    expect(await ledgerLines('nonce')).toEqual([]);
    expect(await ledgerLines('key')).toMatchObject([{ type: 'key', spent: '740' }]);
    expect((await keys.list())[0]).toMatchObject({ spent: '740', lastUsedAt: expect.any(Number) });
    const restarted = new Gateway({ ...gatewayDeps, keys: new AccessKeys(join(dir, 'buyer')) });
    await restarted.load();
    expect(await restarted.reconciliation(epoch)).toEqual({ epoch, final: true, rows });
  });

  it('runs its job at start and on a timer, and logs a tick that fails', async () => {
    await setUp();
    const logs: string[] = [];
    const job = new Gateway({ ...gatewayDeps, log: (m) => logs.push(m) });
    await job.load();
    vi.spyOn(chain, 'getEpochTimes').mockRejectedValueOnce(new Error('socket hang up'));
    job.start(3_600);
    job.start(3_600);
    await vi.waitFor(() => expect(logs).toEqual([expect.stringMatching(/gateway tick failed: socket hang up/)]));
    await job.stop();
    await job.stop();
  });

  it('keeps a revocation when it folds the keys', async () => {
    await setUp();
    const { key } = await keys.make({ label: 'revoked', budget: 1n, services: null, rps: 1, expiresAt: null }, 5);
    expect((await call()).status).toBe(200);
    await keys.revoke(key.keyId, 9);
    const before = await keys.list();
    // The keys are folded when an epoch is made final.
    mock.__advanceEpoch();
    mock.__advanceEpoch();
    await gateway.tick();
    expect(await keys.list()).toEqual(before);
    expect((await ledgerLines('key')).map((l) => l.keyId)).toEqual([caller.key.keyId, key.keyId]);
    expect((await ledgerLines('revoke')).map((l) => l.keyId)).toEqual([key.keyId]);
    expect(await new AccessKeys(join(dir, 'buyer')).list()).toEqual(before);
  });
});
