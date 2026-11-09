// SPDX-License-Identifier: Apache-2.0
/**
 * The gateway under load and when calls go wrong, against MockChainAdapter
 * with the real seller in the same process:
 *   - a budget's queue and the gateway's are bounded, and refused at once;
 *   - a call whose client goes away before it is sent is never signed, sent
 *     or charged;
 *   - no call is sent that cannot live long enough before the stop time;
 *   - a refused or unanswered call counts at its most value, against the
 *     budget until it is seen landed and against its key until the epoch is
 *     made final, through a restart, and a refusal not to retry demotes the
 *     seller;
 *   - a key's budget holds across its calls on two services at once.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  MIN_REQUEST_SECONDS,
  PEER_LIMITS,
  Router,
  Seller,
  decodeMessage,
  encodeMessage,
  serviceIdOf,
  signOffer,
  type AccessKey,
  type Connector,
  type GatewayAnswer,
  type GatewayDeps,
  type QuoteResponse,
  type ServeResponse,
} from '../src/index.js';

const NODE = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const MODEL = 'urn:test:model:gateway-calls';
const OTHER_MODEL = 'urn:test:model:gateway-calls-two';
const SERVICE = serviceIdOf(MODEL);
const PRICE = 10n;
const CHAT = { model: MODEL, messages: [{ role: 'user', content: 'synthetic question' }], max_tokens: 20 };
/** What CHAT may cost at PRICE: 62 units (18 bytes, 24 of allowance, 20 tokens). */
const MOST = 620n;
/** What CHAT costs when served: 12 units. */
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
/** Every `serve` the gateway sent, and, while set, a gate each one waits on. */
let sends: number;
let gate: Promise<void> | undefined;

const backend: Connector = { kind: 'openai', complete: async () => ({ content: 'synthetic answer', promptTokens: 7, completionTokens: 5 }) };
const body = (a: GatewayAnswer) => a.body as any;
const call = (chat: unknown = CHAT, signal?: AbortSignal, g: Gateway = gateway) => g.chatCompletion(caller, chat, { signal });
const nonceLines = async () => (await readFile(join(dir, 'buyer', 'buyer-nonces.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
/** The calls the gateway has taken, running or waiting. */
const turnsOf = (g: Gateway) => (g as unknown as { turns: { size: number } }).turns.size;

/** A gate that holds every send until `open()`. */
function holdSends(): () => void {
  let open!: () => void;
  gate = new Promise<void>((resolve) => { open = resolve; });
  return () => { gate = undefined; open(); };
}

async function setUp(options: { value?: bigint; models?: string[]; keyBudget?: bigint; turns?: GatewayDeps['turns']; clock?: () => number } = {}): Promise<void> {
  const models = options.models ?? [MODEL];
  await mock.ensureProfile();
  const buyer = new Buyer({ chain, store: new BuyerStore(join(dir, 'buyer')), config: { enabled: true, buyerWallet: NODE.address, prefundLeadSeconds: 7_200, tickSeconds: 300 } });
  const { epoch } = await chain.getEpochTimes();
  await buyer.fund({
    epoch, source: { kind: 'wallet' },
    services: models.map((m) => ({ serviceId: serviceIdOf(m), serviceClass: 1, value: options.value ?? 10n ** 6n, maxPricePerUnit: 100n })),
  });
  seller = new Seller({
    chain, dir: join(dir, 'seller'), signer: NODE.address, peerId: 'seller-peer', stopServingSeconds: DEFAULT_STOP_SERVING_SECONDS, tickSeconds: 300,
    services: models.map((m) => ({ model: m, serviceId: serviceIdOf(m), pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed' as const, connector: backend })),
  });
  await seller.load();
  await seller.tick();
  const domain = (await chain.getMarketplaceContracts()).requestDomain;
  const offers = await Promise.all(models.map((m) => signOffer(chain, NODE.address, domain, {
    seller: seller.gate.identityId, serviceId: serviceIdOf(m), serviceClass: 1, unit: 'token', pricePerUnit: PRICE, epoch, capacity: null,
    model: m, provenance: 'upstream-claimed', peerId: 'seller-peer', signedAt: 1,
  })));
  const router = new Router({ chain, offers: async () => offers, quote: async (_peer, services) => seller.quote({ services }) as Promise<QuoteResponse> });
  keys = new AccessKeys(join(dir, 'buyer'));
  deps = {
    chain, buyerWallet: NODE.address, store: buyer.store, router, keys, dir: join(dir, 'buyer'),
    ...(options.turns ? { turns: options.turns } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    send: async (_peer, payload) => {
      sends++;
      await gate;
      const answer = await seller.serve(decodeMessage(payload));
      return encodeMessage(tamper ? tamper(answer) : answer);
    },
  };
  gateway = new Gateway(deps);
  await gateway.load();
  caller = { key: (await keys.make({ label: 'test-agent', budget: options.keyBudget ?? 10n ** 30n, services: null, rps: 1_000, expiresAt: null }, 0)).key };
}

/** The gateway and the keys as a restarted node reads them. */
async function restart(): Promise<void> {
  keys = new AccessKeys(join(dir, 'buyer'));
  deps = { ...deps, keys };
  gateway = new Gateway(deps);
  await gateway.load();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-gateway-calls-'));
  mock = new MockChainAdapter('mock:31337', NODE.address);
  mock.setMockACKSigner(NODE);
  chain = marketplaceChainOf(mock)!;
  tamper = undefined;
  sends = 0;
  gate = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('calls waiting for their turn', () => {
  it("refuse a call at once when its budget's queue is full, and run the rest in turn", async () => {
    await setUp({ turns: { waitingPerKey: 2, calls: 16 } });
    const open = holdSends();
    const running = call();
    await vi.waitFor(() => expect(sends).toBe(1));
    const waiting = [call(), call()];
    await vi.waitFor(() => expect(turnsOf(gateway)).toBe(3));
    const refused = await call();
    expect(refused).toMatchObject({ status: 429, headers: { 'Retry-After': '5' }, body: { error: { code: 'budget_busy' }, serviceId: SERVICE } });
    open();
    expect((await Promise.all([running, ...waiting])).map((a) => a.status)).toEqual([200, 200, 200]);
    expect(sends).toBe(3);
    expect((await keys.list())[0]!.spent).toBe(String(3n * COST));
  });

  it('refuse a call with 503 once the gateway has as many calls as it takes, over every budget', async () => {
    await setUp({ models: [MODEL, OTHER_MODEL], turns: { waitingPerKey: 4, calls: 2 } });
    const open = holdSends();
    const running = [call(), call({ ...CHAT, model: OTHER_MODEL })];
    await vi.waitFor(() => expect(sends).toBe(2));
    expect(await call()).toMatchObject({ status: 503, headers: { 'Retry-After': '5' }, body: { error: { code: 'gateway_busy' } } });
    open();
    expect((await Promise.all(running)).map((a) => a.status)).toEqual([200, 200]);
  });

  it('never sign, send or charge a call whose client went away while it waited', async () => {
    await setUp();
    const open = holdSends();
    const running = call();
    await vi.waitFor(() => expect(sends).toBe(1));
    const client = new AbortController();
    const leaving = call(CHAT, client.signal);
    const after = call();
    await vi.waitFor(() => expect(turnsOf(gateway)).toBe(3));
    client.abort();
    expect(await leaving).toMatchObject({ status: 499, body: { error: { code: 'client_gone' } } });
    expect(turnsOf(gateway)).toBe(2);
    open();
    expect((await running).status).toBe(200);
    expect((await after).status).toBe(200);
    // Two calls signed and sent, two nonces taken, two charged.
    expect(sends).toBe(2);
    expect(await nonceLines()).toHaveLength(2);
    expect((await keys.list())[0]!.spent).toBe(String(2n * COST));
    expect(keys.reservedOf(caller.key.keyId)).toBe(0n);
    expect(gateway.heldValue(subscriptionIdOf(NODE.address, (await chain.getEpochTimes()).epoch), 0)).toBe(2n * COST);
  });

  it('stop a call whose client goes away while its seller is picked, before a nonce is taken', async () => {
    await setUp();
    const client = new AbortController();
    const pick = deps.router.pick.bind(deps.router);
    vi.spyOn(deps.router, 'pick').mockImplementationOnce(async (...args) => {
      const route = await pick(...args);
      client.abort();
      return route;
    });
    expect(await call(CHAT, client.signal)).toMatchObject({ status: 499 });
    expect(sends).toBe(0);
    expect(await nonceLines()).toEqual([]);
    expect(keys.reservedOf(caller.key.keyId)).toBe(0n);
    expect((await keys.list())[0]!.spent).toBe('0');
    // A client gone before the call came: refused before anything else.
    expect(await call(CHAT, AbortSignal.abort())).toMatchObject({ status: 499 });
    expect(sends).toBe(0);
  });
});

describe('the end of the epoch', () => {
  it('sends no call that cannot live long enough before the stop time for its receipt to land', async () => {
    // The gateway's clock stands still: the call waits no time by it.
    await setUp({ clock: () => 0 });
    const times = await chain.getEpochTimes();
    const lastSend = times.endsAt - DEFAULT_STOP_SERVING_SECONDS - MIN_REQUEST_SECONDS;
    expect(MIN_REQUEST_SECONDS).toBeGreaterThanOrEqual(PEER_LIMITS.serveTimeoutMs / 1_000);
    const at = vi.spyOn(chain, 'getEpochTimes').mockResolvedValue({ ...times, now: lastSend + 1 });
    const late = await call();
    expect(late).toMatchObject({ status: 503, body: { error: { code: 'epoch_ending' } }, headers: { 'Retry-After': String(times.endsAt - lastSend - 1) } });
    expect(sends).toBe(0);
    at.mockResolvedValue({ ...times, now: lastSend });
    const inTime = await call();
    expect(inTime.status).toBe(200);
    // The request it sent lives as long as the gateway waits for its answer, and its receipt was completed in it.
    const kept = JSON.parse((await readFile(join(dir, 'buyer', 'buyer-receipts.jsonl'), 'utf8')).trim());
    expect(kept.request.expiry - kept.request.issuedAt).toBe(MIN_REQUEST_SECONDS);
    expect(kept.receipt.completedAt).toBeLessThanOrEqual(kept.request.expiry);
  });

  it('sends no call whose turn came too near the stop time, however long it waited for it', async () => {
    let ms = 0;
    await setUp({ clock: () => ms });
    const times = await chain.getEpochTimes();
    const open = holdSends();
    const running = call();
    await vi.waitFor(() => expect(sends).toBe(1));
    const waiting = call();
    await vi.waitFor(() => expect(turnsOf(gateway)).toBe(2));
    // By the time its turn comes, the chain's time has passed the last moment a call may be sent.
    ms = (times.endsAt - DEFAULT_STOP_SERVING_SECONDS - MIN_REQUEST_SECONDS - times.now + 1) * 1_000;
    open();
    expect((await running).status).toBe(200);
    expect(await waiting).toMatchObject({ status: 503, body: { error: { code: 'epoch_ending' } } });
    expect(sends).toBe(1);
    expect(await nonceLines()).toHaveLength(1);
    expect(keys.reservedOf(caller.key.keyId)).toBe(0n);
  });
});

describe('refused and unanswered calls', () => {
  it('count at their most value against the budget and the key, through a restart, until known', async () => {
    await setUp();
    const { epoch } = await chain.getEpochTimes();
    const subscriptionId = subscriptionIdOf(NODE.address, epoch);
    // Refused for good: its nonce 0 may still land.
    tamper = () => ({ ok: false, code: 'BudgetExhausted', retry: false });
    expect(await call()).toMatchObject({ status: 502, body: { error: { code: 'seller_refused' }, sellerCode: 'BudgetExhausted', retry: false } });
    tamper = undefined;
    expect(gateway.heldValue(subscriptionId, 0)).toBe(MOST);
    expect(keys.reservedOf(caller.key.keyId)).toBe(MOST);
    // Unanswered: its nonce 1 may land too.
    const send = deps.send;
    deps.send = async () => { throw new Error('timed out'); };
    expect(await call()).toMatchObject({ status: 503, body: { error: { code: 'seller_unreachable' } } });
    deps.send = send;
    expect(gateway.heldValue(subscriptionId, 0)).toBe(2n * MOST);
    expect(keys.reservedOf(caller.key.keyId)).toBe(2n * MOST);

    // A restart counts them again.
    await restart();
    expect(gateway.heldValue(subscriptionId, 0)).toBe(2n * MOST);
    expect(keys.reservedOf(caller.key.keyId)).toBe(2n * MOST);
    expect((await keys.list())[0]!.spent).toBe('0');

    // The seller lands the refused one: the chain shows nonce 0 used.
    vi.spyOn(chain, 'nonceWord').mockResolvedValue(1n);
    await gateway.tick();
    expect(gateway.heldValue(subscriptionId, 0)).toBe(MOST);
    expect(keys.reservedOf(caller.key.keyId)).toBe(2n * MOST);
    // The epoch ends: the unanswered one never landed, and its key's reservation goes.
    mock.__advanceEpoch();
    await gateway.tick();
    expect(keys.reservedOf(caller.key.keyId)).toBe(MOST);
    // Made final: the one that landed is charged at its most value, the other nothing.
    mock.__advanceEpoch();
    await gateway.tick();
    expect(keys.reservedOf(caller.key.keyId)).toBe(0n);
    expect((await keys.list())[0]!.spent).toBe(String(MOST));
    const receipts = (await readFile(join(dir, 'buyer', 'buyer-receipts.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(receipts).toEqual([expect.objectContaining({ type: 'final', epoch })]);
  });

  it('count a receipt that fails a check at its most value, not at what it claims', async () => {
    await setUp();
    tamper = (a) => (a.ok ? { ...a, receiptSignature: '0x00' } : a);
    expect(body(await call())).toMatchObject({ error: { code: 'bad_receipt' }, problem: 'bad_signature' });
    const { epoch } = await chain.getEpochTimes();
    expect(gateway.heldValue(subscriptionIdOf(NODE.address, epoch), 0)).toBe(MOST);
    expect(keys.reservedOf(caller.key.keyId)).toBe(MOST);
  });

  it('keep the soft ceiling with refused calls counted', async () => {
    // 1,500 wei: the soft ceiling is 1,425; two refused calls hold 1,240, and a third may cost 620.
    await setUp({ value: 1_500n });
    tamper = () => ({ ok: false, code: 'BudgetExhausted', retry: false });
    expect((await call()).status).toBe(502);
    tamper = () => ({ ok: false, code: 'WrongPrice', retry: true });
    expect((await call()).status).toBe(502);
    tamper = undefined;
    expect(await call()).toMatchObject({ status: 402, body: { error: { code: 'soft_ceiling' } } });
  });
});

describe('a seller that refuses for good', () => {
  it('is demoted by the gateway on a refusal not to retry, and kept on one to retry', async () => {
    await setUp();
    const demote = vi.spyOn(deps.router, 'demote');
    const unreachable = vi.spyOn(deps.router, 'unreachable');
    tamper = () => ({ ok: false, code: 'BadSignature', retry: false });
    await call();
    expect(demote).toHaveBeenCalledWith(seller.gate.identityId);
    tamper = () => ({ ok: false, code: 'EpochEnding', retry: true });
    await call();
    expect(demote).toHaveBeenCalledTimes(1);
    expect(unreachable).not.toHaveBeenCalled();
  });
});

describe("a key's budget", () => {
  it('holds across its calls on two services at once', async () => {
    // The key's 1,000 wei: one call may cost 620, so two at once may not.
    await setUp({ models: [MODEL, OTHER_MODEL], keyBudget: 1_000n });
    const answers = await Promise.all([call(), call({ ...CHAT, model: OTHER_MODEL })]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 402]);
    expect(body(answers.find((a) => a.status === 402)!).error.code).toBe('key_budget');
    expect(sends).toBe(1);
    expect(keys.reservedOf(caller.key.keyId)).toBe(0n);
    // Settled at 120, the next call fits: 120 spent and 620 more is within 1,000.
    expect((await call({ ...CHAT, model: OTHER_MODEL })).status).toBe(200);
    expect((await keys.list())[0]!.spent).toBe(String(2n * COST));
  });
});
