// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace routes' request handling against MockChainAdapter: who may
 * write, and who may read the access keys and their calls, how a refusal maps
 * to its status, input that is refused before the chain is asked, the daemon's
 * buyer at boot, and the `dkg marketplace` commands. The routes, the buyer and
 * the contracts together are tested on Hardhat in
 * marketplace-buyer.evm.test.ts.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ethers } from 'ethers';
import { ChainRpcTransportError, MockChainAdapter, marketplaceChainOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import { AccessKeys, Buyer, BuyerStore, Gateway, Router, Seller, parsePlan, signServiceOffer } from '@origintrail-official/dkg-marketplace';
import { ApiClient } from '../src/api-client.js';
import { registerMarketplaceCommand } from '../src/commands/marketplace.js';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { startMarketplaceBuyer, startMarketplaceGateway } from '../src/daemon/marketplace-buyer.js';
import { offerAssetsIn, subscribeWhenAdmitted } from '../src/daemon/marketplace-context-graph.js';
import { handleMarketplaceRoutes } from '../src/daemon/routes/marketplace.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const TRAC = 10n ** 18n;
const SIGNER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const OTHER = ethers.getAddress(`0x${'0c'.repeat(20)}`);
const A = `0x${'0a'.repeat(32)}`;
const plan = {
  services: [{ serviceId: A, serviceClass: 'inference', value: String(10n * TRAC), maxPricePerUnit: '1000' }],
  source: { kind: 'wallet' },
  renew: true,
  renewUntilEpoch: 3,
};

let dir: string;
let chain: MarketplaceChainAdapter;
let mock: MockChainAdapter;
let buyer: Buyer | undefined;
let gateway: Gateway | undefined;
let seller: Seller | undefined;

async function api(
  method: string,
  path: string,
  body?: unknown,
  authentication = requestAuthentication({ kind: 'nodeOperator' }),
): Promise<{ status: number; body: any; claimed: boolean; headers?: Record<string, string> }> {
  // Emitters, as the gateway listens for a client that goes away.
  const res: any = Object.assign(new EventEmitter(), { statusCode: 0, body: '', writableEnded: false });
  res.writeHead = (status: number, headers?: Record<string, string>) => { res.statusCode = status; res.headers = headers; };
  res.setHeader = () => undefined;
  res.end = (text: string) => { res.body = text; res.writableEnded = true; };
  const req: any = Object.assign(new EventEmitter(), { method, url: path });
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const url = new URL(`http://127.0.0.1${path}`);
  await handleMarketplaceRoutes({
    req, res, url, path: url.pathname, marketplace: buyer, marketplaceGateway: gateway, marketplaceSeller: seller, actor: { authentication },
  } as unknown as RequestContext);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, claimed: res.writableEnded, headers: res.headers };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-routes-'));
  mock = new MockChainAdapter('mock:31337', SIGNER.address);
  mock.setMockACKSigner(SIGNER);
  chain = marketplaceChainOf(mock)!;
  buyer = new Buyer({
    chain,
    store: new BuyerStore(dir),
    config: { enabled: true, buyerWallet: SIGNER.address, prefundLeadSeconds: 7_200, tickSeconds: 300 },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  gateway = undefined;
  seller = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('the gateway routes', () => {
  const chat = { model: 'urn:test:model:none', messages: [{ role: 'user', content: 'synthetic question' }] };
  const agentToken = requestAuthentication({ kind: 'agent', agentAddress: OTHER });
  const bearer = (presentedToken: string | undefined) => requestAuthentication({ kind: 'anonymous', mode: 'public', presentedToken });

  beforeEach(async () => {
    gateway = new Gateway({
      chain, buyerWallet: SIGNER.address, store: buyer!.store, keys: new AccessKeys(dir), dir,
      router: new Router({ chain, offers: async () => [], quote: async () => { throw new Error('no sellers'); } }),
      send: async () => { throw new Error('no sellers'); },
    });
    await gateway.load();
  });

  it('refuse a caller without a live key with 401, before reading the body or asking the chain', async () => {
    const reads = vi.spyOn(chain, 'getEpochTimes');
    const now = Math.floor(Date.now() / 1000);
    const { secret: revoked, key } = await gateway!.keys.make({ label: 'gone', budget: 1n, services: null, rps: 5, expiresAt: null }, now);
    await gateway!.keys.revoke(key.keyId, now);
    const { secret: expired } = await gateway!.keys.make({ label: 'old', budget: 1n, services: null, rps: 5, expiresAt: now - 1 }, now);
    // The body's bytes are never read: a request without them would fail if they were.
    // A node or agent token is not a key, nor is the node admin's.
    for (const auth of [bearer(undefined), bearer(`dkgmk_${'00'.repeat(24)}`), bearer(revoked), bearer(expired), agentToken, requestAuthentication({ kind: 'nodeOperator' })]) {
      const answer = await api('POST', '/api/marketplace/v1/chat/completions', undefined, auth);
      expect(answer.status).toBe(401);
    }
    expect(reads).not.toHaveBeenCalled();
    expect((await api('GET', '/api/marketplace/v1/models', undefined, bearer(revoked))).status).toBe(401);
  });

  it("serve a key holder, and answer the gateway's own refusals", async () => {
    const { secret } = await gateway!.keys.make({ label: 'agent', budget: 10n ** 18n, services: null, rps: 100, expiresAt: null }, 0);
    expect(await api('GET', '/api/marketplace/v1/models', undefined, bearer(secret))).toMatchObject({ status: 200, body: { object: 'list', data: [] } });
    expect(await api('POST', '/api/marketplace/v1/chat/completions', chat, bearer(secret))).toMatchObject({ status: 402, body: { error: { code: 'no_subscription' } } });
    expect(await api('POST', '/api/marketplace/v1/chat/completions', 'not json', bearer(secret))).toMatchObject({ status: 400 });
    const times = await chain.getEpochTimes();
    vi.spyOn(chain, 'getEpochTimes').mockResolvedValue({ ...times, now: times.endsAt - 60 });
    const gap = await api('POST', '/api/marketplace/v1/chat/completions', chat, bearer(secret));
    expect(gap).toMatchObject({ status: 503, body: { error: { code: 'epoch_ending' } }, headers: { 'Retry-After': '60' } });
    gateway = undefined;
    expect((await api('GET', '/api/marketplace/v1/models', undefined, bearer(secret))).status).toBe(503);
  });

  it('make and revoke keys for the node admin only, and show them without their secrets', async () => {
    expect(await api('POST', '/api/marketplace/keys', { label: 'x', budget: '1' }, agentToken)).toMatchObject({ status: 403, body: { code: 'NodeAdminRequired' } });
    const made = await api('POST', '/api/marketplace/keys', { label: 'test-agent', budget: '1000', rps: 2 });
    expect(made).toMatchObject({ status: 200, body: { label: 'test-agent', budget: '1000', spent: '0', reserved: '0', rps: 2, revoked: false } });
    expect(made.body.secret).toMatch(/^dkgmk_[0-9a-f]{48}$/);
    // Their labels and budgets are the admin's business.
    expect(await api('GET', '/api/marketplace/keys', undefined, agentToken)).toMatchObject({ status: 403, body: { code: 'NodeAdminRequired' } });
    // What a call not yet settled holds of the key's budget is shown beside what its calls cost.
    expect(await gateway!.keys.reserve(made.body.keyId, 400n)).toBe(true);
    const listed = await api('GET', '/api/marketplace/keys');
    expect(listed.body.keys).toEqual([expect.objectContaining({ keyId: made.body.keyId, budget: '1000', spent: '0', reserved: '400' })]);
    gateway!.keys.release(made.body.keyId, 400n);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.secret);
    expect(await api('POST', `/api/marketplace/keys/${made.body.keyId}/revoke`, {}, agentToken)).toMatchObject({ status: 403 });
    expect(await api('POST', `/api/marketplace/keys/${made.body.keyId}/revoke`, {})).toMatchObject({ status: 200, body: { revoked: true } });
    expect(await api('POST', '/api/marketplace/keys/dkgmk_none/revoke', {})).toMatchObject({ status: 404, body: { code: 'KeyNotFound' } });
    for (const bad of [{ label: '', budget: '1' }, { label: 'x', budget: '0' }, { label: 'x', budget: '1', rps: 0 }, { label: 'x', budget: '1', services: ['0x01'] }, { label: 'x', budget: '1', expiresAt: -5 }]) {
      expect((await api('POST', '/api/marketplace/keys', bad)).status).toBe(400);
    }
  });

  it("answer the reconciliation of an epoch, this one's by default, to any reader", async () => {
    mock.__advanceEpoch();
    const { epoch } = await chain.getEpochTimes();
    expect(await api('GET', '/api/marketplace/reconciliation', undefined, agentToken)).toMatchObject({ status: 200, body: { epoch, final: false, rows: [] } });
    expect(await api('GET', `/api/marketplace/reconciliation?epoch=${epoch - 1}`)).toMatchObject({ status: 200, body: { epoch: epoch - 1, final: true } });
    expect(await api('GET', '/api/marketplace/reconciliation?epoch=soon')).toMatchObject({ status: 400, body: { code: 'InvalidRequest' } });
    gateway = undefined;
    expect(await api('GET', '/api/marketplace/reconciliation')).toMatchObject({ status: 503, body: { code: 'MarketplaceOff' } });
  });
});

describe('the catalog routes', () => {
  const agent = requestAuthentication({ kind: 'agent', agentAddress: OTHER });
  let own: bigint;

  beforeEach(async () => {
    await mock.ensureProfile();
    own = await chain.getIdentityId();
    const { epoch } = await chain.getEpochTimes();
    const offers = [await signServiceOffer(chain, SIGNER.address, (await chain.getMarketplaceContracts()).requestDomain, {
      seller: own, serviceId: A, serviceClass: 1, unit: 'token', model: 'urn:test:model:a', provenance: 'upstream-claimed', capacity: null,
      peerId: 'seller-peer', pricePerUnit: 10n, priceEpoch: epoch, validUntilEpoch: epoch + 12, withdrawn: false, signedAt: 1,
    })];
    gateway = new Gateway({
      chain, buyerWallet: SIGNER.address, store: buyer!.store, keys: new AccessKeys(dir), dir,
      router: new Router({ chain, offers: async () => offers, quote: async () => { throw new Error('no sellers'); } }),
      send: async () => { throw new Error('no sellers'); },
    });
    await gateway.load();
  });

  it('answer the catalog, a service and a storefront to any reader, and the activity to the node admin only', async () => {
    const { epoch } = await chain.getEpochTimes();
    expect(await api('GET', '/api/marketplace/catalog', undefined, agent)).toMatchObject({
      status: 200, body: { epoch, fx: { tracUsd: null, source: 'none' }, services: [{ serviceId: A, label: 'urn:test:model:a', priceMin: '10', offers: [{ seller: Number(own), available: null }] }] },
    });
    expect(await api('GET', `/api/marketplace/services/${A}`, undefined, agent)).toMatchObject({ status: 200, body: { serviceId: A, sellers: [{ identityId: Number(own) }] } });
    expect(await api('GET', `/api/marketplace/services/0x${'99'.repeat(32)}`)).toMatchObject({ status: 404, body: { code: 'ServiceNotFound' } });
    expect((await api('GET', '/api/marketplace/services/a-model')).status).toBe(404);
    expect(await api('GET', `/api/marketplace/sellers/${own}`, undefined, agent)).toMatchObject({ status: 200, body: { identityId: Number(own), gate: { profile: true }, offers: [{ serviceId: A }] } });
    vi.spyOn(chain, 'profileExists').mockResolvedValue(false);
    expect(await api('GET', '/api/marketplace/sellers/77')).toMatchObject({ status: 404, body: { code: 'SellerNotFound' } });
    // Each access key's calls are the node admin's business, as the keys are: refused before the chain is asked.
    const reads = vi.spyOn(chain, 'getEpochTimes');
    expect(await api('GET', '/api/marketplace/activity', undefined, agent)).toMatchObject({ status: 403, body: { code: 'NodeAdminRequired' } });
    expect(await api('GET', '/api/marketplace/activity?epoch=soon', undefined, agent)).toMatchObject({ status: 403, body: { code: 'NodeAdminRequired' } });
    expect(reads).not.toHaveBeenCalled();
    expect(await api('GET', '/api/marketplace/activity')).toMatchObject({ status: 200, body: { calls: [] } });
    expect(await api('GET', '/api/marketplace/activity?key=dkgmk_none&epoch=current')).toMatchObject({ status: 200, body: { calls: [] } });
    expect(await api('GET', '/api/marketplace/activity?epoch=soon')).toMatchObject({ status: 400, body: { code: 'InvalidRequest' } });
    gateway = undefined;
    expect(await api('GET', '/api/marketplace/catalog')).toMatchObject({ status: 503, body: { code: 'MarketplaceOff' } });
  });

  it("show each budget's held value as the gateway counts it", async () => {
    const { epoch } = await chain.getEpochTimes();
    await chain.approveServiceSubscriptionsWallet(10n ** 24n);
    await chain.fundFromWallet({
      epoch, sessionKey: OTHER, planDigest: ethers.ZeroHash,
      budgets: [{ serviceId: A, serviceClass: 1, value: 10n ** 6n, maxPricePerUnit: 100n }],
    });
    vi.spyOn(gateway!, 'heldValue').mockReturnValue(7n);
    expect((await api('GET', '/api/marketplace/subscriptions?epoch=current')).body.subscriptions[0].budgets[0]).toMatchObject({ held: '7', left: String(10n ** 6n) });
    gateway = undefined;
    expect((await api('GET', '/api/marketplace/subscriptions?epoch=current')).body.subscriptions[0].budgets[0]).toMatchObject({ held: '0' });
  });

  it('take the reference rate from the settings when the gateway starts, and none when it is not a rate', async () => {
    const agentStub = { sendMarketplaceMessage: vi.fn(), subscribeToContextGraph: vi.fn(), query: vi.fn(async () => ({ bindings: [] })) };
    const log = vi.fn();
    const started = await startMarketplaceGateway({ config: { marketplace: { fx: { tracUsd: 0.5 } } }, agent: agentStub, buyer: buyer!, dataDir: dir, log });
    expect(started.fx).toEqual({ tracUsd: 0.5, source: 'config', asOf: null });
    await started.stop();
    const refused = await startMarketplaceGateway({ config: { marketplace: { fx: { tracUsd: 'a lot' } } }, agent: agentStub, buyer: buyer!, dataDir: dir, log });
    expect(refused.fx).toEqual({ tracUsd: null, source: 'none', asOf: null });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/tracUsd .*no USD/));
    await refused.stop();
  });
});

describe('the seller routes', () => {
  const SERVICE = `0x${'0b'.repeat(32)}`;
  const agent = requestAuthentication({ kind: 'agent', agentAddress: OTHER });

  beforeEach(async () => {
    await mock.ensureProfile();
    seller = new Seller({
      chain, dir: join(dir, 'seller'), signer: SIGNER.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
      services: [{
        model: 'urn:test:model:b', serviceId: SERVICE, pricePerUnit: 10n, capacity: null, provenance: 'upstream-claimed',
        connector: { kind: 'openai', complete: async () => ({ content: 'synthetic answer', promptTokens: 1, completionTokens: 1 }) },
      }],
    });
    await seller.load();
    await seller.tick();
  });

  it('show Operate to any reader, and land or set the next price for the node admin only', async () => {
    const { epoch, startsAt, endsAt } = await chain.getEpochTimes();
    expect(await api('GET', '/api/marketplace/seller', undefined, agent)).toMatchObject({
      status: 200,
      body: {
        epoch, startsAt, endsAt, gate: { profile: true, shardingTable: true }, scoredThisEpoch: true,
        offerings: [{ serviceId: SERVICE, connector: 'up', price: '10', nextPrice: '10' }], batches: [],
      },
    });
    expect(await api('POST', '/api/marketplace/seller/land', {}, agent)).toMatchObject({ status: 403, body: { code: 'NodeAdminRequired' } });
    expect(await api('POST', '/api/marketplace/seller/land', {})).toMatchObject({ status: 200, body: { batches: [], stopped: 'nothing-ready' } });
    const price = `/api/marketplace/seller/offerings/${SERVICE}/price`;
    expect(await api('PUT', price, { price: '25' }, agent)).toMatchObject({ status: 403, body: { code: 'NodeAdminRequired' } });
    expect(await api('PUT', price, { price: '25' })).toMatchObject({ status: 200, body: { serviceId: SERVICE, price: '10', nextPrice: '25' } });
    for (const bad of [{ price: '0' }, { price: 25 }, {}]) expect(await api('PUT', price, bad)).toMatchObject({ status: 400, body: { code: 'InvalidRequest' } });
    expect(await api('PUT', `/api/marketplace/seller/offerings/0x${'99'.repeat(32)}/price`, { price: '5' })).toMatchObject({ status: 404, body: { code: 'ServiceNotFound' } });
    expect((await api('GET', '/api/marketplace/seller/elsewhere')).status).toBe(404);
  });

  it('refuse a next price with 409 once its epoch has started, and keep the price that epoch froze', async () => {
    const stale = await chain.getEpochTimes();
    mock.__advanceEpoch();
    expect((await api('GET', '/api/marketplace/seller')).body.offerings).toMatchObject([{ price: '10', nextPrice: '10' }]);
    // The setting's first read is from before the epoch turned.
    vi.spyOn(chain, 'getEpochTimes').mockResolvedValueOnce(stale);
    const price = `/api/marketplace/seller/offerings/${SERVICE}/price`;
    expect(await api('PUT', price, { price: '25' })).toMatchObject({
      status: 409, body: { code: 'EpochStarted', args: [SERVICE, String(stale.epoch + 1)], retryable: false },
    });
    expect((await api('GET', '/api/marketplace/seller')).body.offerings).toMatchObject([{ price: '10', nextPrice: '10' }]);
    expect(await api('PUT', price, { price: '25' })).toMatchObject({ status: 200, body: { price: '10', nextPrice: '25' } });
  });

  it('answer for a node that sells without buying, and 503 while selling is off', async () => {
    buyer = undefined;
    expect((await api('GET', '/api/marketplace/seller')).status).toBe(200);
    expect(await api('GET', '/api/marketplace/plan')).toMatchObject({ status: 503, body: { code: 'MarketplaceOff' } });
    seller = undefined;
    expect(await api('GET', '/api/marketplace/seller')).toMatchObject({ status: 503, body: { code: 'MarketplaceOff', retryable: true } });
    expect(await api('POST', '/api/marketplace/seller/land', {})).toMatchObject({ status: 503, body: { code: 'MarketplaceOff' } });
  });
});

describe('the marketplace routes', () => {
  it('leave other paths alone, and answer 503 while the marketplace is off', async () => {
    expect((await api('GET', '/api/pca')).claimed).toBe(false);
    expect((await api('GET', '/api/marketplacex')).claimed).toBe(false);
    buyer = undefined;
    expect(await api('GET', '/api/marketplace/plan')).toMatchObject({ status: 503, body: { code: 'MarketplaceOff', retryable: true } });
  });

  it('let any caller read, and only the node admin write', async () => {
    const agent = requestAuthentication({ kind: 'agent', agentAddress: OTHER });
    expect((await api('GET', '/api/marketplace/subscriptions', undefined, agent)).status).toBe(200);
    expect(await api('PUT', '/api/marketplace/plan', plan, agent)).toMatchObject({ status: 403, body: { code: 'NodeAdminRequired' } });
    expect(await buyer!.store.readPlan()).toBeNull();
  });

  it('keep the standing plan', async () => {
    expect(await api('GET', '/api/marketplace/plan')).toMatchObject({ status: 404, body: { code: 'PlanNotFound', retryable: false } });
    const put = await api('PUT', '/api/marketplace/plan', plan);
    expect(put).toMatchObject({ status: 200, body: { renew: true, renewUntilEpoch: 3, next: { epoch: 1 } } });
    // The same plan; the next renewal's time is the chain's now, read again.
    expect({ ...(await api('GET', '/api/marketplace/plan')).body, next: undefined }).toEqual({ ...put.body, next: undefined });
    expect(await api('PUT', '/api/marketplace/plan', { ...plan, renewUntilEpoch: undefined }))
      .toMatchObject({ status: 400, body: { code: 'InvalidRequest', error: expect.stringContaining('renewUntilEpoch') } });
  });

  it('refuse bad input before asking the chain', async () => {
    const sends = vi.spyOn(chain, 'fundFromWallet');
    for (const [method, path, body] of [
      ['POST', '/api/marketplace/subscriptions', 'not json'],
      ['POST', '/api/marketplace/subscriptions', { epoch: 'later', source: { kind: 'wallet' }, services: plan.services }],
      ['POST', '/api/marketplace/accounts/0/service-spending', { enabled: true }],
      ['POST', '/api/marketplace/accounts/1/service-spending', { enabled: 'yes' }],
      ['POST', '/api/marketplace/accounts/1/buyers', { maxCostPerEpoch: '1', expiresAt: 'soon' }],
      ['POST', '/api/marketplace/accounts/1/buyers', { maxCostPerEpoch: '1', expiresAt: 10, buyerSignature: 7 }],
      ['POST', '/api/marketplace/accounts/1/buyers/not-an-address/limits', { maxCostPerEpoch: '1', expiresAt: 10 }],
      ['GET', '/api/marketplace/accounts/%E0%A4%A', undefined],
    ] as const) {
      expect(await api(method, path, body), `${method} ${path}`).toMatchObject({ status: 400, body: { code: 'InvalidRequest' } });
    }
    expect(sends).not.toHaveBeenCalled();
    expect(await api('GET', '/api/marketplace/nothing-here')).toMatchObject({ status: 404 });
  });

  it('map refusals to their status, and keep the contract error name and arguments', async () => {
    const funding = { epoch: 'current', source: { kind: 'wallet' }, services: plan.services };
    expect((await api('POST', '/api/marketplace/subscriptions', funding)).status).toBe(200);
    expect(await api('POST', '/api/marketplace/subscriptions', funding)).toMatchObject({ status: 409, body: { code: 'SubscriptionAlreadyFunded', retryable: false } });
    expect(await api('POST', `/api/marketplace/subscriptions/0x${'ab'.repeat(32)}/top-up`, { services: plan.services }))
      .toMatchObject({ status: 404, body: { code: 'SubscriptionNotFound', args: [`0x${'ab'.repeat(32)}`] } });
    expect(await api('POST', '/api/marketplace/accounts/9/service-spending', { enabled: true }))
      .toMatchObject({ status: 404, body: { code: 'ERC721NonexistentToken' } });
    const { accountId } = await mock.createPublishingConvictionAccount(1_000n * TRAC);
    const foreign = new Buyer({
      chain, store: new BuyerStore(dir), nodeWallets: [OTHER],
      config: { enabled: true, buyerWallet: OTHER, prefundLeadSeconds: 7_200, tickSeconds: 300 },
    });
    buyer = foreign;
    expect(await api('DELETE', `/api/marketplace/accounts/${accountId}/buyers/${OTHER}`))
      .toMatchObject({ status: 403, body: { code: 'NotAccountOwner', args: [String(accountId), SIGNER.address] } });
    vi.spyOn(chain, 'batchState').mockResolvedValue({ activationEpoch: 1, paused: true, maxGroups: 32, maxItems: 256 });
    expect(await api('POST', '/api/marketplace/subscriptions', { ...funding, epoch: 'next' }))
      .toMatchObject({ status: 503, body: { code: 'QueryInferencePaused', retryable: true } });
  });

  it('dry-run a top-up for the node admin: its cost at the account discount and the refusal it would meet, sending nothing', async () => {
    const { accountId } = await mock.createPublishingConvictionAccount(120_000n * TRAC);
    await chain.setServiceSpending(accountId, true);
    const { epoch, now } = await chain.getEpochTimes();
    await chain.addBuyer({ accountId, buyer: SIGNER.address, maxCostPerEpoch: 100_000n * TRAC, expiresAt: now + 90 * 86_400, nonce: await chain.grantNonce(accountId) }, '0x', '0x');
    const funded = await api('POST', '/api/marketplace/subscriptions', { epoch: 'current', source: { kind: 'account', accountId: String(accountId) }, services: plan.services });
    const subscriptionId = funded.body.subscription.subscriptionId;
    const sends = (['topUpFromAccount', 'topUpFromWallet', 'approveServiceSubscriptionsWallet'] as const).map((name) => vi.spyOn(chain, name));
    const preview = `/api/marketplace/subscriptions/${subscriptionId}/top-up/preview`;

    expect(await api('POST', preview, { services: plan.services })).toMatchObject({
      status: 200,
      body: { epoch, source: { kind: 'account', accountId: String(accountId), discountBps: 3000 }, value: String(10n * TRAC), cost: String(7n * TRAC), costTrac: '7.0', discountBps: 3000 },
    });
    const window = await chain.currentWindowAllowance(accountId);
    const over = await api('POST', preview, { services: [{ ...plan.services[0], value: String(20_000n * TRAC) }] });
    expect(over).toMatchObject({ status: 200, body: { cost: String(14_000n * TRAC) } });
    expect(over.body.refusal).toEqual({
      code: 'InsufficientAllowance', args: [String(accountId), String(epoch), String(14_000n * TRAC), String(window.baseRemaining + window.topUpBuffer)],
    });
    const agent = requestAuthentication({ kind: 'agent', agentAddress: OTHER });
    expect(await api('POST', preview, { services: plan.services }, agent)).toMatchObject({ status: 403, body: { code: 'NodeAdminRequired' } });
    expect(await api('POST', preview, { services: [] })).toMatchObject({ status: 400, body: { code: 'InvalidRequest' } });
    expect(await api('POST', `/api/marketplace/subscriptions/0x${'ab'.repeat(32)}/top-up/preview`, { services: plan.services }))
      .toMatchObject({ status: 404, body: { code: 'SubscriptionNotFound' } });

    for (const send of sends) expect(send).not.toHaveBeenCalled();
    expect((await api('GET', '/api/marketplace/subscriptions?epoch=current')).body.subscriptions[0]).toMatchObject({ value: String(10n * TRAC), cost: String(7n * TRAC) });
  });

  it('answer a funding that was sent as sent, even while the read of its subscription lags', async () => {
    vi.spyOn(chain, 'getSubscription').mockResolvedValueOnce(null);
    const sent = await api('POST', '/api/marketplace/subscriptions', { epoch: 'next', source: { kind: 'wallet' }, services: plan.services });
    expect(sent).toMatchObject({ status: 200, body: { subscription: null } });
    expect(sent.body.txHash).toBeTruthy();
  });

  it('answer a chain outage as retryable, a missing contract as off, and anything else as 500', async () => {
    const times = vi.spyOn(chain, 'getEpochTimes');
    times.mockRejectedValueOnce(new ChainRpcTransportError('RPC_TIMEOUT', 'timed out after 30000ms'));
    expect(await api('GET', '/api/marketplace/subscriptions')).toMatchObject({ status: 504, body: { code: 'TIMEOUT', retryable: true } });
    times.mockRejectedValueOnce(Object.assign(new Error('Contract "Chronos" not found in Hub'), { name: 'HubContractNotFoundError' }));
    expect(await api('GET', '/api/marketplace/subscriptions')).toMatchObject({ status: 503, body: { code: 'MarketplaceOff' } });
    times.mockRejectedValueOnce(new Error('call failed at https://rpc.example/key'));
    const failed = await api('GET', '/api/marketplace/subscriptions');
    expect(failed).toMatchObject({ status: 500, body: { code: 'Error', retryable: false } });
    expect(failed.body.error).not.toContain('rpc.example');
  });

  it('serve the funding, accounts and contracts views and the owner actions', async () => {
    const { accountId } = await mock.createPublishingConvictionAccount(1_000n * TRAC);
    expect((await api('GET', '/api/marketplace/funding')).body.accounts.map((a: any) => a.accountId)).toEqual([String(accountId)]);
    expect((await api('GET', '/api/marketplace/accounts')).body.accounts).toHaveLength(1);
    expect((await api('GET', '/api/marketplace/accounts/contracts')).body.buyerWallet).toBe(SIGNER.address);
    expect((await api('POST', `/api/marketplace/accounts/${accountId}/service-spending`, { enabled: true })).body).toHaveProperty('txHash');
    const { now } = await chain.getEpochTimes();
    const limits = { maxCostPerEpoch: String(5n * TRAC), expiresAt: now + 86_400 };
    expect((await api('POST', `/api/marketplace/accounts/${accountId}/buyer-consent`, limits)).body.terms.buyer).toBe(SIGNER.address);
    expect((await api('POST', `/api/marketplace/accounts/${accountId}/buyers`, limits)).status).toBe(200);
    expect((await api('POST', `/api/marketplace/accounts/${accountId}/buyers/${SIGNER.address}/limits`, { ...limits, maxCostPerEpoch: String(6n * TRAC) })).status).toBe(200);
    expect((await api('DELETE', `/api/marketplace/accounts/${accountId}/buyers/${SIGNER.address}`)).status).toBe(200);
    expect((await chain.getGrant(accountId, SIGNER.address))!.revokedAt).toBeGreaterThan(0);
  });

  it('answer an account-list read that failed after the wait as pending, with the RPC URLs of its error stripped', async () => {
    const listBuyerAccounts = chain.listBuyerAccounts.bind(chain);
    const fails: Array<(err: Error) => void> = [];
    chain.listBuyerAccounts = () => new Promise<bigint[]>((_resolve, reject) => { fails.push(reject); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // The first view stops waiting after 5 s; the read then fails with an error that names a keyed RPC URL.
      const first = api('GET', '/api/marketplace/funding');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await first).toMatchObject({ status: 200, body: { accountsPending: true } });
      fails[0]!(new Error('RPC_ENDPOINTS_EXHAUSTED: every endpoint failed (https://rpc.example/v2/PRIVATE_KEY_123, https://backup.example/key/SECOND_KEY)'));
      await vi.advanceTimersByTimeAsync(0);

      // The next views cannot wait either: they say the last read failed, without the URLs.
      for (const path of ['/api/marketplace/funding', '/api/marketplace/accounts']) {
        const answer = api('GET', path);
        await vi.advanceTimersByTimeAsync(5_000);
        const { status, body } = await answer;
        expect(status).toBe(200);
        expect(body.accountsPending).toBe(true);
        expect(body.accountsError).toContain('RPC_ENDPOINTS_EXHAUSTED');
        expect(body.accountsError).toContain('[rpc]');
        expect(JSON.stringify(body)).not.toMatch(/PRIVATE_KEY_123|SECOND_KEY|rpc\.example|backup\.example/);
      }
    } finally {
      vi.useRealTimers();
      chain.listBuyerAccounts = listBuyerAccounts;
    }
  });
});

describe("the daemon's buyer at boot", () => {
  const base = () => ({ agent: { marketplaceChain: () => chain }, wallets: [SIGNER.address], dataDir: dir, dashDb: { insertNotification: vi.fn() }, log: vi.fn() });

  it('stays off unless enabled, on a chain with the marketplace and a buyer wallet of the node', () => {
    expect(startMarketplaceBuyer({ ...base(), config: {} })).toBeUndefined();
    const noChain = { ...base(), agent: { marketplaceChain: () => null }, config: { marketplace: { enabled: true } } };
    expect(startMarketplaceBuyer(noChain)).toBeUndefined();
    expect(noChain.log).toHaveBeenCalledWith(expect.stringContaining('stays off'));
    const foreign = { ...base(), config: { marketplace: { enabled: true, buyerWallet: OTHER } } };
    expect(startMarketplaceBuyer(foreign)).toBeUndefined();
    expect(foreign.log).toHaveBeenCalledWith(expect.stringContaining('not one of this node'));
  });

  it('starts the job, and records a failed renewal as a notification', async () => {
    const options = { ...base(), config: { marketplace: { enabled: true, tickSeconds: 3_600 } } };
    const started = startMarketplaceBuyer(options)!;
    expect(started.buyerWallet).toBe(SIGNER.address);
    await started.stop();
    const { accountId } = await mock.createPublishingConvictionAccount(1_000n * TRAC);
    await started.store.writePlan(parsePlan({ ...plan, source: { kind: 'account', accountId: String(accountId) } }));
    options.dashDb.insertNotification.mockImplementationOnce(() => { throw new Error('database is locked'); });
    await started.tick();
    await started.tick();
    expect(options.dashDb.insertNotification).toHaveBeenCalledTimes(1);
    vi.spyOn(chain, 'getServiceSpending').mockRejectedValue(new Error('socket hang up'));
    await started.tick();
    expect(options.dashDb.insertNotification).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'marketplace_renewal_failed', source: 'marketplace' }));
  });
});

describe('the Marketplace Context Graph at boot', () => {
  /** A node whose admission reads answer `answers` in turn, as the subscribe route reads them. */
  const nodeAnswering = (...answers: Array<{ outcome: string; onChainId?: bigint }>) => ({
    findLocalAgentForContextGraph: async () => undefined,
    listLocalAgents: () => [],
    getDefaultAgentAddress: () => OTHER,
    resolveContextGraphSubscriptionBootstrapAuthority: vi.fn(async () => answers.shift() ?? { outcome: 'unavailable' }),
    subscribeToContextGraph: vi.fn(),
    reconcileRfc64CatalogResponsibilityV1: vi.fn(async () => undefined),
  });
  afterEach(() => { vi.useRealTimers(); });

  it('asks again while the admission cannot be read, then subscribes as the graph admits it', async () => {
    vi.useFakeTimers();
    const node = nodeAnswering({ outcome: 'unavailable' }, { outcome: 'allowed', onChainId: 7n }, { outcome: 'allowed', onChainId: 7n });
    node.subscribeToContextGraph.mockImplementationOnce(() => { throw new Error('the node is stopping'); });
    const onAdmitted = vi.fn();
    subscribeWhenAdmitted(node as unknown as DKGAgent, 'graph', { onAdmitted });
    await vi.advanceTimersByTimeAsync(0);
    expect(node.subscribeToContextGraph).not.toHaveBeenCalled();
    // The readiness repeat's delays: 15 s, then 30 s.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(node.subscribeToContextGraph).toHaveBeenCalledTimes(1);
    expect(onAdmitted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(node.subscribeToContextGraph).toHaveBeenLastCalledWith('graph', { syncMode: 'always-on', onChainId: '7' });
    expect(node.reconcileRfc64CatalogResponsibilityV1).toHaveBeenCalledWith('graph');
    expect(onAdmitted).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(node.resolveContextGraphSubscriptionBootstrapAuthority).toHaveBeenCalledTimes(3);
  });

  it('subscribes to no graph that refuses the node, and asks no more once stopped', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const refusing = nodeAnswering({ outcome: 'denied' });
    subscribeWhenAdmitted(refusing as unknown as DKGAgent, 'graph', { log });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(refusing.resolveContextGraphSubscriptionBootstrapAuthority).toHaveBeenCalledTimes(1);
    expect(refusing.subscribeToContextGraph).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('does not admit this node'));
    const waiting = nodeAnswering({ outcome: 'unavailable' }, { outcome: 'allowed' });
    const stop = subscribeWhenAdmitted(waiting as unknown as DKGAgent, 'graph');
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(waiting.resolveContextGraphSubscriptionBootstrapAuthority).toHaveBeenCalledTimes(1);
    expect(waiting.subscribeToContextGraph).not.toHaveBeenCalled();
  });

  it("publishes an offer's asset once the graph admits the node, reopening and rewriting a sealed one whole, and finishes a catalog record", async () => {
    const quads = [{ subject: 'urn:test:offer', predicate: 'urn:test:p', object: '"1"', graph: '' }];
    const steps: string[] = [];
    let state: string | undefined;
    let status = 'confirmed';
    const step = (name: string) => vi.fn(async (...args: unknown[]) => { steps.push(`${name}${args[2] === 'swm' || args[2] === 'vm' ? `:${args[2]}` : ''}`); });
    const node = {
      assertion: {
        history: vi.fn(async () => (state === undefined ? null : { state })),
        pullFrom: step('pullFrom'), discard: step('discard'), create: step('create'), write: step('write'), promote: step('promote'),
      },
      publishFromFinalizedAssertion: vi.fn(async () => ({ status, kaId: 42n })),
      recoverRfc64ConfirmedCatalogObligationV1: vi.fn(async () => undefined),
    };
    let admitted = false;
    const assets = offerAssetsIn(node as unknown as DKGAgent, 'graph', () => admitted);
    // The graph names the target, so the seller keeps what it published by graph.
    expect(assets.contextGraphId).toBe('graph');
    await expect(assets.publish('offer-a', quads)).rejects.toMatchObject({ code: 'MARKETPLACE_NOT_ADMITTED' });
    admitted = true;
    const published: Record<string, string[]> = {};
    for (const each of [undefined, 'promoted', 'published', 'finalized', 'created', 'discarded']) {
      state = each;
      steps.length = 0;
      expect(await assets.publish('offer-a', quads)).toEqual({ kaId: 42n });
      published[String(each)] = [...steps];
    }
    expect(published).toEqual({
      undefined: ['create', 'write', 'promote'],
      promoted: ['pullFrom:swm', 'discard', 'create', 'write', 'promote'],
      published: ['pullFrom:vm', 'discard', 'create', 'write', 'promote'],
      finalized: ['pullFrom:vm', 'discard', 'create', 'write', 'promote'],
      created: ['discard', 'create', 'write', 'promote'],
      discarded: ['create', 'write', 'promote'],
    });
    expect(node.assertion.write).toHaveBeenLastCalledWith('graph', 'offer-a', quads);
    status = 'tentative';
    await expect(assets.publish('offer-a', quads)).rejects.toThrow(/not confirmed on chain \(tentative\)/);
    await assets.recover({ version: 1 });
    expect(node.recoverRfc64ConfirmedCatalogObligationV1).toHaveBeenCalledWith({ version: 1 });
  });

  it('finishes a promote an earlier publish left unfinished, then stages the offer anew and publishes it', async () => {
    const quads = [{ subject: 'urn:test:offer', predicate: 'urn:test:p', object: '"2"', graph: '' }];
    const steps: string[] = [];
    // A promote that failed after its intent was kept: the draft is frozen until the promote runs again.
    let state = 'created';
    let unfinished = true;
    const mutation = (name: string) => vi.fn(async (...args: unknown[]) => {
      if (unfinished) {
        throw Object.assign(new Error('Assertion "offer-a" has an unfinished promote; retry assertionPromote before mutating its draft'), { code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
      }
      steps.push(`${name}${args[2] === 'swm' ? ':swm' : ''}`);
    });
    const node = {
      assertion: {
        history: vi.fn(async () => ({ state })),
        pullFrom: mutation('pullFrom'), discard: mutation('discard'), create: mutation('create'), write: mutation('write'),
        promote: vi.fn(async () => {
          steps.push(unfinished ? 'promote, finishing the one left' : 'promote');
          unfinished = false;
          state = 'promoted';
        }),
      },
      publishFromFinalizedAssertion: vi.fn(async () => ({ status: 'confirmed', kaId: 42n })),
      recoverRfc64ConfirmedCatalogObligationV1: vi.fn(async () => undefined),
    };
    const assets = offerAssetsIn(node as unknown as DKGAgent, 'graph', () => true);
    expect(await assets.publish('offer-a', quads)).toEqual({ kaId: 42n });
    expect(steps).toEqual(['promote, finishing the one left', 'pullFrom:swm', 'discard', 'create', 'write', 'promote']);
    expect(node.assertion.write).toHaveBeenLastCalledWith('graph', 'offer-a', quads);
    // Any other error fails the publish as it is.
    node.assertion.discard.mockRejectedValueOnce(Object.assign(new Error('store unavailable'), { code: 'STORE_UNAVAILABLE' }));
    await expect(assets.publish('offer-a', quads)).rejects.toThrow('store unavailable');
  });
});

describe('dkg marketplace', () => {
  it('sends each command to its route and prints the answer', async () => {
    const calls: unknown[][] = [];
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({
      marketplace: async (...args: unknown[]) => { calls.push(args); return { ok: true }; },
    } as unknown as ApiClient);
    const print = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = async (...argv: string[]) => {
      const program = new Command();
      program.exitOverride();
      registerMarketplaceCommand(program);
      await program.parseAsync(['node', 'dkg', 'marketplace', ...argv]);
    };
    await run('subscriptions', '--epoch', 'next');
    await run('plan');
    await run('spending', '7', 'on');
    await run('add-buyer', '7', '--max-cost', '2.5', '--expires-at', '1900000000', '--buyer', OTHER);
    await run('limits', '7', OTHER, '--max-cost', '1', '--expires-at', '1900000000');
    await run('remove-buyer', '7', OTHER);
    await run('keys');
    await run('keys', 'make', '--label', 'test-agent', '--budget', '1', '--service', `0x${'0a'.repeat(32)}`, '--expires-at', '1900000000');
    await run('keys', 'revoke', 'dkgmk_0011aabb');
    await run('reconciliation', '--epoch', '41');
    await run('reconciliation');
    await run('catalog');
    await run('service', A);
    await run('storefront', '7');
    await run('activity', '--epoch', '4', '--key', 'dkgmk_0011aabb');
    await run('activity');
    await run('seller');
    await run('seller', 'land');
    await run('seller', 'price', A, '25');
    const additions = join(dir, 'additions.json');
    await writeFile(additions, JSON.stringify({ services: plan.services }));
    await run('top-up', `0x${'ab'.repeat(32)}`, additions, '--dry-run');
    await run('top-up', `0x${'ab'.repeat(32)}`, additions);
    expect(calls).toEqual([
      ['GET', '/subscriptions?epoch=next', undefined],
      ['GET', '/plan', undefined],
      ['POST', '/accounts/7/service-spending', { enabled: true }],
      ['POST', '/accounts/7/buyers', { maxCostPerEpoch: String(25n * 10n ** 17n), expiresAt: 1_900_000_000, buyer: OTHER }],
      ['POST', `/accounts/7/buyers/${OTHER}/limits`, { maxCostPerEpoch: String(TRAC), expiresAt: 1_900_000_000 }],
      ['DELETE', `/accounts/7/buyers/${OTHER}`, undefined],
      ['GET', '/keys', undefined],
      ['POST', '/keys', { label: 'test-agent', budget: String(TRAC), rps: 5, services: [`0x${'0a'.repeat(32)}`], expiresAt: 1_900_000_000 }],
      ['POST', '/keys/dkgmk_0011aabb/revoke', undefined],
      ['GET', '/reconciliation?epoch=41', undefined],
      ['GET', '/reconciliation', undefined],
      ['GET', '/catalog', undefined],
      ['GET', `/services/${A}`, undefined],
      ['GET', '/sellers/7', undefined],
      ['GET', '/activity?epoch=4&key=dkgmk_0011aabb', undefined],
      ['GET', '/activity', undefined],
      ['GET', '/seller', undefined],
      ['POST', '/seller/land', undefined],
      ['PUT', `/seller/offerings/${A}/price`, { price: '25' }],
      ['POST', `/subscriptions/0x${'ab'.repeat(32)}/top-up/preview`, { services: plan.services }],
      ['POST', `/subscriptions/0x${'ab'.repeat(32)}/top-up`, { services: plan.services }],
    ]);
    expect(print).toHaveBeenCalledWith(JSON.stringify({ ok: true }, null, 2));
  });

  it('prints the refusal code and exits 1', async () => {
    const refusal = Object.assign(new Error('LimitExceeded(maxCostPerEpoch, 1, 2)'), { httpStatus: 409, responseBody: { code: 'LimitExceeded' } });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ marketplace: async () => { throw refusal; } } as unknown as ApiClient);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit);
    const program = new Command();
    program.exitOverride();
    registerMarketplaceCommand(program);
    await expect(program.parseAsync(['node', 'dkg', 'marketplace', 'funding'])).rejects.toThrow('exit 1');
    expect(errors).toHaveBeenCalledWith('LimitExceeded: LimitExceeded(maxCostPerEpoch, 1, 2)');
  });

  it('refuses a bad amount or a missing file before it connects', async () => {
    const connect = vi.spyOn(ApiClient, 'connect');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit);
    for (const argv of [['consent', '7', '--max-cost', 'lots', '--expires-at', '1'], ['fund', join(dir, 'missing.json')]]) {
      const program = new Command();
      program.exitOverride();
      registerMarketplaceCommand(program);
      await expect(program.parseAsync(['node', 'dkg', 'marketplace', ...argv])).rejects.toThrow('exit 1');
    }
    expect(errors).toHaveBeenCalledTimes(2);
    expect(connect).not.toHaveBeenCalled();
  });
});
