// SPDX-License-Identifier: Apache-2.0
/**
 * `POST /api/marketplace/v1/chat/completions` while its budget is busy,
 * against MockChainAdapter with the real seller in the same process: a call
 * whose client closes while it waits is never sent and gets no answer
 * written, and a call with no room in its budget's queue gets 429 with
 * `Retry-After`, at once.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, marketplaceChainOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import {
  AccessKeys,
  Buyer,
  BuyerStore,
  Gateway,
  Router,
  Seller,
  decodeMessage,
  encodeMessage,
  serviceIdOf,
  signServiceOffer,
  type QuoteResponse,
} from '@origintrail-official/dkg-marketplace';
import { handleMarketplaceRoutes } from '../src/daemon/routes/marketplace.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const NODE = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const MODEL = 'urn:test:model:gateway-route';
const CHAT = { model: MODEL, messages: [{ role: 'user', content: 'synthetic question' }], max_tokens: 20 };
const PATH = '/api/marketplace/v1/chat/completions';

let dir: string;
let chain: MarketplaceChainAdapter;
let gateway: Gateway;
let keys: AccessKeys;
let secret: string;
let sends: number;
let gate: Promise<void> | undefined;

/** A request through the route, and its response as a client would see it; `res` closes as a client that goes away. */
function request(body: unknown) {
  const res: any = Object.assign(new EventEmitter(), { statusCode: 0, body: '', writableEnded: false, destroyed: false });
  res.writeHead = (status: number, headers?: Record<string, string>) => { res.statusCode = status; res.headers = headers; };
  res.setHeader = () => undefined;
  res.end = (text: string) => { res.body = text; res.writableEnded = true; };
  const req: any = Object.assign(new EventEmitter(), { method: 'POST', url: PATH, __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)) });
  const url = new URL(`http://127.0.0.1${PATH}`);
  const done = handleMarketplaceRoutes({
    req, res, url, path: url.pathname, marketplaceGateway: gateway,
    actor: { authentication: requestAuthentication({ kind: 'anonymous', mode: 'public', presentedToken: secret }) },
  } as unknown as RequestContext);
  const close = () => { res.destroyed = true; res.emit('close'); };
  return { res, done, close };
}

const turnsOf = () => (gateway as unknown as { turns: { size: number } }).turns.size;
const waitingOf = () => (gateway as unknown as { turns: { waiting: number } }).turns.waiting;

async function setUp(turns?: { waitingPerKey: number; calls: number }): Promise<void> {
  const mock = new MockChainAdapter('mock:31337', NODE.address);
  mock.setMockACKSigner(NODE);
  chain = marketplaceChainOf(mock)!;
  await mock.ensureProfile();
  const store = new BuyerStore(join(dir, 'buyer'));
  const buyer = new Buyer({ chain, store, config: { enabled: true, buyerWallet: NODE.address, prefundLeadSeconds: 7_200, tickSeconds: 300 } });
  const { epoch } = await chain.getEpochTimes();
  await buyer.fund({ epoch, source: { kind: 'wallet' }, services: [{ serviceId: serviceIdOf(MODEL), serviceClass: 1, value: 10n ** 6n, maxPricePerUnit: 100n }] });
  const seller = new Seller({
    chain, dir: join(dir, 'seller'), signer: NODE.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
    services: [{
      model: MODEL, serviceId: serviceIdOf(MODEL), pricePerUnit: 10n, capacity: null, provenance: 'upstream-claimed',
      connector: { kind: 'openai', complete: async () => ({ content: 'synthetic answer', promptTokens: 7, completionTokens: 5 }) },
    }],
  });
  await seller.load();
  await seller.tick();
  const offers = [await signServiceOffer(chain, NODE.address, (await chain.getMarketplaceContracts()).requestDomain, {
    seller: seller.gate.identityId, serviceId: serviceIdOf(MODEL), serviceClass: 1, unit: 'token', model: MODEL, provenance: 'upstream-claimed',
    capacity: null, peerId: 'seller-peer', pricePerUnit: 10n, priceEpoch: epoch, validUntilEpoch: epoch + 12, withdrawn: false, signedAt: 1,
  })];
  keys = new AccessKeys(join(dir, 'buyer'));
  gateway = new Gateway({
    chain, buyerWallet: NODE.address, store, keys, dir: join(dir, 'buyer'),
    router: new Router({ chain, offers: async () => offers, quote: async (_peer, services) => seller.quote({ services }) as Promise<QuoteResponse> }),
    send: async (_peer, payload) => {
      sends++;
      await gate;
      return encodeMessage(await seller.serve(decodeMessage(payload), 'buyer-peer'));
    },
    ...(turns ? { turns } : {}),
  });
  await gateway.load();
  ({ secret } = await keys.make({ label: 'test-agent', budget: 10n ** 18n, services: null, rps: 1_000, expiresAt: null }, 0));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-route-gateway-'));
  sends = 0;
  gate = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the chat route while its budget is busy', () => {
  it('never sends a call whose client closed while it waited, and writes it no answer', async () => {
    await setUp();
    let open!: () => void;
    gate = new Promise<void>((resolve) => { open = resolve; });
    const running = request(CHAT);
    await vi.waitFor(() => expect(sends).toBe(1));
    const leaving = request(CHAT);
    await vi.waitFor(() => expect(waitingOf()).toBe(1));
    leaving.close();
    await leaving.done;
    expect(leaving.res).toMatchObject({ statusCode: 0, writableEnded: false });
    expect(turnsOf()).toBe(1);
    open();
    await running.done;
    expect(running.res.statusCode).toBe(200);
    expect(JSON.parse(running.res.body)).toMatchObject({ object: 'chat.completion' });
    expect(sends).toBe(1);
    expect((await keys.list())[0]!.spent).toBe('120');
  });

  it('answers 429 with Retry-After at once when the budget has no room for one more', async () => {
    await setUp({ waitingPerKey: 0, calls: 16 });
    let open!: () => void;
    gate = new Promise<void>((resolve) => { open = resolve; });
    const running = request(CHAT);
    await vi.waitFor(() => expect(sends).toBe(1));
    const refused = request(CHAT);
    await refused.done;
    expect(refused.res).toMatchObject({ statusCode: 429, headers: expect.objectContaining({ 'Retry-After': '5' }) });
    expect(JSON.parse(refused.res.body)).toMatchObject({ error: { code: 'budget_busy', type: 'marketplace' } });
    open();
    await running.done;
    expect(running.res.statusCode).toBe(200);
  });

  it('answers a request that takes no listeners, as a stand-in for one, without watching for its client', async () => {
    await setUp();
    const res: any = { statusCode: 0, body: '' };
    res.writeHead = (status: number) => { res.statusCode = status; };
    res.setHeader = () => undefined;
    res.end = (text: string) => { res.body = text; res.writableEnded = true; };
    const req: any = { method: 'POST', url: PATH, __dkgPrebufferedBody: Buffer.from(JSON.stringify(CHAT)) };
    const url = new URL(`http://127.0.0.1${PATH}`);
    await handleMarketplaceRoutes({
      req, res, url, path: url.pathname, marketplaceGateway: gateway,
      actor: { authentication: requestAuthentication({ kind: 'anonymous', mode: 'public', presentedToken: secret }) },
    } as unknown as RequestContext);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ object: 'chat.completion' });
  });
});
