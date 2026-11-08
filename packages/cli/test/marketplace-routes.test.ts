// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace routes' request handling against MockChainAdapter: who may
 * write, how a refusal maps to its status, input that is refused before the
 * chain is asked, the daemon's buyer at boot, and the `dkg marketplace`
 * commands. The routes, the buyer and the contracts together are tested on
 * Hardhat in marketplace-buyer.evm.test.ts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ethers } from 'ethers';
import { ChainRpcTransportError, MockChainAdapter, marketplaceChainOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import { AccessKeys, Buyer, BuyerStore, Gateway, NO_SELLER_PEERS, Router, parsePlan } from '@origintrail-official/dkg-marketplace';
import { ApiClient } from '../src/api-client.js';
import { registerMarketplaceCommand } from '../src/commands/marketplace.js';
import { startMarketplaceBuyer } from '../src/daemon/marketplace-buyer.js';
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

async function api(
  method: string,
  path: string,
  body?: unknown,
  authentication = requestAuthentication({ kind: 'nodeOperator' }),
): Promise<{ status: number; body: any; claimed: boolean; headers?: Record<string, string> }> {
  const res: any = { statusCode: 0, body: '', writableEnded: false };
  res.writeHead = (status: number, headers?: Record<string, string>) => { res.statusCode = status; res.headers = headers; };
  res.setHeader = () => undefined;
  res.end = (text: string) => { res.body = text; res.writableEnded = true; };
  const req: any = { method, url: path };
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const url = new URL(`http://127.0.0.1${path}`);
  await handleMarketplaceRoutes({ req, res, url, path: url.pathname, marketplace: buyer, marketplaceGateway: gateway, actor: { authentication } } as unknown as RequestContext);
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
  await rm(dir, { recursive: true, force: true });
});

describe('the gateway routes', () => {
  const chat = { model: 'urn:test:model:none', messages: [{ role: 'user', content: 'synthetic question' }] };
  const agentToken = requestAuthentication({ kind: 'agent', agentAddress: OTHER });
  const bearer = (presentedToken: string | undefined) => requestAuthentication({ kind: 'anonymous', mode: 'public', presentedToken });

  beforeEach(async () => {
    gateway = new Gateway({
      chain, buyerWallet: SIGNER.address, store: buyer!.store, keys: new AccessKeys(dir), dir,
      router: new Router({ chain, offers: async () => [], quote: async () => { throw new Error('no sellers'); }, peers: NO_SELLER_PEERS }),
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
    expect(made).toMatchObject({ status: 200, body: { label: 'test-agent', budget: '1000', rps: 2, revoked: false } });
    expect(made.body.secret).toMatch(/^dkgmk_[0-9a-f]{48}$/);
    // Their labels and budgets are the admin's business.
    expect(await api('GET', '/api/marketplace/keys', undefined, agentToken)).toMatchObject({ status: 403, body: { code: 'NodeAdminRequired' } });
    const listed = await api('GET', '/api/marketplace/keys');
    expect(listed.body.keys).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.secret);
    expect(await api('POST', `/api/marketplace/keys/${made.body.keyId}/revoke`, {}, agentToken)).toMatchObject({ status: 403 });
    expect(await api('POST', `/api/marketplace/keys/${made.body.keyId}/revoke`, {})).toMatchObject({ status: 200, body: { revoked: true } });
    expect(await api('POST', '/api/marketplace/keys/dkgmk_none/revoke', {})).toMatchObject({ status: 404, body: { code: 'KeyNotFound' } });
    for (const bad of [{ label: '', budget: '1' }, { label: 'x', budget: '0' }, { label: 'x', budget: '1', rps: 0 }, { label: 'x', budget: '1', services: ['0x01'] }, { label: 'x', budget: '1', expiresAt: -5 }]) {
      expect((await api('POST', '/api/marketplace/keys', bad)).status).toBe(400);
    }
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
