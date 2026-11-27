// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace buyer end to end on the evm-module's Hardhat chain: the
 * daemon's /api/marketplace routes, the buyer and its job, the EVM adapter and
 * the contracts, with nothing mocked between them.
 *   - wallet and account funding for the current and the next epoch, top-ups
 *     and an upgrade from the plan;
 *   - the job prefunding the next epoch across a boundary, by time travel;
 *   - the new-account path: an old account refused (`EmissionAlreadyScheduled`),
 *     then a new one opted in with the node as its own buyer, and an account a
 *     browser wallet owns, granted with the node's signed consent;
 *   - refusals: `LimitExceeded`, `GrantEndsBeforeSubscription` and a short
 *     window allowance, each as the buyer's check gives it and as the contract
 *     reverts it in simulation, with nothing sent.
 * One snapshot per test; the file's snapshot is reverted at its end, so its
 * time travel does not reach other files.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Contract, Wallet, ethers } from 'ethers';
import { EVMChainAdapter, marketplaceChainOf, recoverSigner, subscriptionIdOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import { Buyer, BuyerStore, refusalOf, type ResolvedMarketplaceConfig } from '@origintrail-official/dkg-marketplace';
import { createProvider, getSharedContext, revertSnapshot, takeSnapshot } from '../../chain/test/evm-test-context.js';
import { HARDHAT_KEYS, makeAdapterConfig, mintTokens } from '../../chain/test/hardhat-harness.js';
import { handleMarketplaceRoutes } from '../src/daemon/routes/marketplace.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const TRAC = 10n ** 18n;
const DAY = 86_400;
const A = ethers.id('urn:dkg:model:a');
const B = ethers.id('urn:dkg:model:b');
const C = ethers.id('urn:dkg:model:c');
const NODE = new Wallet(HARDHAT_KEYS.PUBLISHER2).address;

const service = (serviceId: string, trac: bigint, serviceClass: 'inference' | 'query' = 'inference') =>
  ({ serviceId, serviceClass, value: String(trac * TRAC), maxPricePerUnit: '1000000000000' });

let fileSnapshot: string;
let testSnapshot: string;
let dir: string;
let node: EVMChainAdapter;
let chain: MarketplaceChainAdapter;
let buyer: Buyer;

function buyerWith(config: Partial<ResolvedMarketplaceConfig> = {}): Buyer {
  return new Buyer({
    chain,
    store: new BuyerStore(dir),
    config: { enabled: true, buyerWallet: NODE, prefundLeadSeconds: 7_200, tickSeconds: 300, ...config },
    nodeWallets: [NODE, new Wallet(HARDHAT_KEYS.EXTRA2).address],
  });
}

/** One request through the daemon's marketplace routes, as the node admin. */
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.setHeader = () => undefined;
  res.end = (text: string) => { res.body = text; res.writableEnded = true; };
  const req: any = { method, url: path };
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  const url = new URL(`http://127.0.0.1${path}`);
  const ctx = {
    req, res, url, path: url.pathname, marketplace: buyer,
    actor: { authentication: requestAuthentication({ kind: 'nodeOperator' }) },
  } as unknown as RequestContext;
  await handleMarketplaceRoutes(ctx);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/** The decoded name of the revert the send meets in simulation, and that it sent nothing. */
async function simulatedRevert(send: () => Promise<unknown>): Promise<string | undefined> {
  const nonce = await createProvider().getTransactionCount(NODE);
  const err = await send().then(() => undefined, (e: unknown) => e);
  expect(await createProvider().getTransactionCount(NODE)).toBe(nonce);
  return refusalOf(err)?.code;
}

async function travelTo(timestamp: number): Promise<void> {
  const provider = createProvider();
  const latest = (await provider.getBlock('latest'))!.timestamp;
  await provider.send('evm_increaseTime', [timestamp - latest]);
  await provider.send('evm_mine', []);
}

/** An account the node's primary wallet owns, opted in, with the node as its own buyer. */
async function grantedAccount(committed: bigint, maxCostPerEpoch: bigint, expiresAt?: number): Promise<bigint> {
  const { accountId } = await node.createPublishingConvictionAccount(committed * TRAC);
  expect((await api('POST', `/api/marketplace/accounts/${accountId}/service-spending`, { enabled: true })).status).toBe(200);
  const { endsAt } = await chain.getEpochTimes();
  const added = await api('POST', `/api/marketplace/accounts/${accountId}/buyers`, {
    maxCostPerEpoch: String(maxCostPerEpoch * TRAC), expiresAt: expiresAt ?? endsAt + 40 * DAY,
  });
  expect(added.status).toBe(200);
  return accountId;
}

describe('the marketplace buyer on Hardhat', () => {
  beforeAll(async () => {
    fileSnapshot = await takeSnapshot();
    await mintTokens(createProvider(), getSharedContext().hubAddress, HARDHAT_KEYS.DEPLOYER, NODE, 500_000n * TRAC);
  }, 120_000);
  afterAll(async () => { await revertSnapshot(fileSnapshot); });
  beforeEach(async () => {
    testSnapshot = await takeSnapshot();
    dir = await mkdtemp(join(tmpdir(), 'marketplace-buyer-evm-'));
    // A fresh adapter per test: its account reads are cached briefly, and each test reverts the chain.
    const { rpcUrl, hubAddress } = getSharedContext();
    node = new EVMChainAdapter(makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.PUBLISHER2, [HARDHAT_KEYS.EXTRA2]));
    chain = marketplaceChainOf(node)!;
    buyer = buyerWith();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await revertSnapshot(testSnapshot);
    await rm(dir, { recursive: true, force: true });
  });

  it('funds the current and the next epoch from the wallet, tops up, and upgrades from the plan', async () => {
    const times = await chain.getEpochTimes();
    const funding = (await api('GET', '/api/marketplace/funding')).body;
    expect(funding).toMatchObject({ buyerWallet: { address: NODE }, epoch: times.epoch, epochEndsAt: times.endsAt });
    expect(BigInt(funding.buyerWallet.trac)).toBeGreaterThanOrEqual(500_000n * TRAC);
    const request = { epoch: 'current', source: { kind: 'wallet' }, services: [service(A, 100n)] };
    const dryRun = await api('POST', '/api/marketplace/subscriptions/preview', request);
    expect(dryRun.body).toEqual({
      epoch: times.epoch, source: { kind: 'wallet' }, value: String(100n * TRAC), valueTrac: '100.0',
      cost: String(100n * TRAC), costTrac: '100.0', discountBps: 0,
    });

    const current = await api('POST', '/api/marketplace/subscriptions', request);
    expect(current.status).toBe(200);
    expect(current.body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const id = subscriptionIdOf(NODE, times.epoch);
    expect(current.body.subscription).toMatchObject({ subscriptionId: id, epoch: times.epoch, endsAt: times.endsAt, cost: String(100n * TRAC) });
    // The subscription names the session key the node stored for it; the buyer's unit test checks it is stored before the send.
    expect(current.body.subscription.sessionKey).toBe(await buyer.store.sessionKeyAddress(id));

    const next = await api('POST', '/api/marketplace/subscriptions', { ...request, epoch: 'next' });
    expect(next.body.subscription).toMatchObject({ epoch: times.epoch + 1, startsAt: times.endsAt });
    const again = await api('POST', '/api/marketplace/subscriptions', request);
    expect(again).toEqual({ status: 409, body: { error: `SubscriptionAlreadyFunded(${id})`, code: 'SubscriptionAlreadyFunded', args: [id], retryable: false } });

    const topUp = await api('POST', `/api/marketplace/subscriptions/${id}/top-up`, { services: [service(A, 10n), service(B, 20n, 'query')] });
    expect(topUp.status).toBe(200);
    const budgets = (ids: string[]) => topUp.body.subscription.budgets.filter((b: any) => ids.includes(b.serviceId));
    expect(budgets([A.toLowerCase(), B.toLowerCase()]).map((b: any) => b.value)).toEqual([String(110n * TRAC), String(20n * TRAC)]);
    expect((await api('GET', '/api/marketplace/subscriptions')).body.subscriptions).toHaveLength(2);

    // The plan adds C: the job appends it to this epoch's subscription.
    const plan = { services: [service(A, 100n), service(B, 20n, 'query'), service(C, 5n)], source: { kind: 'wallet' }, renew: true, renewUntilEpoch: times.epoch + 1 };
    expect((await api('PUT', '/api/marketplace/plan', plan)).status).toBe(200);
    await buyer.tick();
    const upgraded = (await api('GET', `/api/marketplace/subscriptions?epoch=current`)).body.subscriptions[0];
    expect(upgraded.budgets.map((b: any) => b.serviceId)).toContain(C.toLowerCase());
    expect(buyer.renewals.get(times.epoch)?.refusal).toBeNull();
  });

  it('prefunds the next epoch across the boundary, by time travel', async () => {
    buyer = buyerWith({ prefundLeadSeconds: 600 });
    const times = await chain.getEpochTimes();
    const plan = { services: [service(A, 50n)], source: { kind: 'wallet' }, renew: true, renewUntilEpoch: times.epoch + 1 };
    expect((await api('PUT', '/api/marketplace/plan', plan)).body.next).toMatchObject({ epoch: times.epoch, cost: String(50n * TRAC) });
    const sends = vi.spyOn(chain, 'fundFromWallet');
    await buyer.tick();
    expect(sends).toHaveBeenCalledTimes(1);
    expect((await api('GET', '/api/marketplace/plan')).body.next).toMatchObject({ epoch: times.epoch + 1, at: times.endsAt - 600 });

    // Outside the lead the next epoch waits; inside it, the job prefunds.
    await travelTo(times.endsAt - 900);
    await buyer.tick();
    expect(sends).toHaveBeenCalledTimes(1);
    await travelTo(times.endsAt - 300);
    await buyer.tick();
    expect(sends).toHaveBeenCalledTimes(2);
    const prefunded = await chain.getSubscription(subscriptionIdOf(NODE, times.epoch + 1));
    expect(prefunded).toMatchObject({ epoch: times.epoch + 1, startsAt: times.endsAt, fundedEpoch: times.epoch });

    // Across the boundary the prefunded subscription is the current one, and nothing is funded twice.
    await travelTo(times.endsAt + 60);
    await buyer.tick();
    expect(sends).toHaveBeenCalledTimes(2);
    const now = (await api('GET', '/api/marketplace/subscriptions?epoch=current')).body.subscriptions;
    expect(now.map((s: any) => s.epoch)).toEqual([times.epoch + 1]);
    expect((await api('GET', '/api/marketplace/plan')).body).not.toHaveProperty('next');
  });

  it('funds from an account the node owns and is its own buyer: two empty signatures, the current and the next epoch', async () => {
    const consents = vi.spyOn(chain, 'addBuyer');
    const accountId = await grantedAccount(50_000n, 1_000n);
    expect(consents).toHaveBeenCalledWith(expect.objectContaining({ accountId, buyer: NODE }), '0x', '0x', { from: NODE });
    const account = (await api('GET', '/api/marketplace/accounts')).body.accounts.find((a: any) => a.accountId === String(accountId));
    expect(account).toMatchObject({ ownedByNode: true, serviceCapable: true, discountBps: 2000, grant: { buyer: NODE, live: true }, publisherWallets: [] });

    const source = { kind: 'account', accountId: String(accountId) };
    const current = await api('POST', '/api/marketplace/subscriptions', { epoch: 'current', source, services: [service(A, 500n)] });
    expect(current.body.subscription).toMatchObject({ source: { ...source, discountBps: 2000 }, value: String(500n * TRAC), cost: String(400n * TRAC) });
    const next = await api('POST', '/api/marketplace/subscriptions', { epoch: 'next', source, services: [service(A, 500n)] });
    expect(next.status).toBe(200);
    const topUp = await api('POST', `/api/marketplace/subscriptions/${current.body.subscription.subscriptionId}/top-up`, { services: [service(B, 100n, 'query')] });
    expect(topUp.body.subscription.cost).toBe(String(480n * TRAC));

    // The owner's later actions: a new limit, then the buyer removed; its subscriptions run on.
    const limits = await api('POST', `/api/marketplace/accounts/${accountId}/buyers/${NODE}/limits`, { maxCostPerEpoch: String(2_000n * TRAC), expiresAt: account.grant.expiresAt });
    expect(limits.status).toBe(200);
    expect((await chain.getGrant(accountId, NODE))!.maxCostPerEpoch).toBe(2_000n * TRAC);
    expect((await api('DELETE', `/api/marketplace/accounts/${accountId}/buyers/${NODE}`)).status).toBe(200);
    const refused = await api('POST', '/api/marketplace/subscriptions/preview', { epoch: 'next', source, services: [service(A, 1n)] });
    expect(refused.body.refusal.code).toBe('SubscriptionAlreadyFunded');
    expect((await api('GET', '/api/marketplace/subscriptions')).body.subscriptions).toHaveLength(2);
  });

  it('refuses as the contracts do: LimitExceeded, GrantEndsBeforeSubscription and a short window allowance', async () => {
    const { epoch, now, endsAt } = await chain.getEpochTimes();
    const fundOf = (accountId: bigint, at: number, trac: bigint) => async () => chain.fundFromAccount({
      accountId, epoch: at, sessionKey: Wallet.createRandom().address, planDigest: ethers.ZeroHash,
      budgets: [{ serviceId: A, serviceClass: 1, value: trac * TRAC, maxPricePerUnit: 10n ** 12n }],
    }, { from: NODE });
    const fund = (accountId: bigint, at: 'current' | 'next', trac: bigint) =>
      api('POST', '/api/marketplace/subscriptions', { epoch: at, source: { kind: 'account', accountId: String(accountId) }, services: [service(A, trac)] });

    // 200 TRAC at the 20% tier costs 160 TRAC, over the 100 TRAC limit.
    const limited = await grantedAccount(50_000n, 100n);
    expect(await fund(limited, 'current', 200n)).toMatchObject({
      status: 409, body: { code: 'LimitExceeded', args: ['maxCostPerEpoch', String(100n * TRAC), String(160n * TRAC)] },
    });
    expect(await simulatedRevert(fundOf(limited, epoch, 200n))).toBe('LimitExceeded');

    // A grant that ends in this epoch cannot fund the next one.
    const ending = await grantedAccount(50_000n, 1_000n, now + DAY);
    expect(await fund(ending, 'next', 10n)).toMatchObject({
      status: 409, body: { code: 'GrantEndsBeforeSubscription', args: [String(ending), NODE, String(now + DAY), String(endsAt)] },
    });
    expect(await simulatedRevert(fundOf(ending, epoch + 1, 10n))).toBe('GrantEndsBeforeSubscription');

    // A small account: the window allows less than the funding costs.
    const small = await grantedAccount(12_000n, 100_000n);
    const window = await chain.currentWindowAllowance(small);
    const over = (window.baseRemaining + window.topUpBuffer) / TRAC + 1n;
    const short = await fund(small, 'current', over);
    expect(short).toMatchObject({ status: 409, body: { code: 'InsufficientAllowance' } });
    expect(await simulatedRevert(fundOf(small, epoch, over))).toBe('InsufficientAllowance');

    // The grant that ends in this epoch still funds this epoch.
    expect((await fund(ending, 'current', 10n)).status).toBe(200);
  });

  it('refuses an old account, then takes the new-account path', async () => {
    const { hubAddress } = getSharedContext();
    const hub = new Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], createProvider());
    const storage = new Contract(
      await hub.getContractAddress('PublishingConvictionStorage'),
      ['function setLastSettledWindow(uint256 accountId, uint16 w)'],
      new Wallet(HARDHAT_KEYS.DEPLOYER, createProvider()),
    );
    // What PublishingConviction 10.0.8 and 10.1.0 left every account they created: scheduled in full.
    const scheduleInFull = async (accountId: bigint) => {
      await (await storage.setLastSettledWindow(accountId, await chain.getConvictionAccountLockDurationEpochs(accountId))).wait();
    };

    // An old account cannot opt in.
    const { accountId: old } = await node.createPublishingConvictionAccount(50_000n * TRAC);
    await scheduleInFull(old);
    expect(await api('POST', `/api/marketplace/accounts/${old}/service-spending`, { enabled: true }))
      .toMatchObject({ status: 409, body: { code: 'EmissionAlreadyScheduled', args: [String(old)] } });
    expect((await api('GET', '/api/marketplace/accounts')).body.accounts.find((a: any) => a.accountId === String(old)))
      .toMatchObject({ serviceCapable: false, refusal: 'EmissionAlreadyScheduled' });

    // One that opted in and granted the node before it was scheduled in full is refused each spend,
    // by the check and by the contract. Another wallet owns it, with the node's signed consent.
    const owner = new EVMChainAdapter(makeAdapterConfig(getSharedContext().rpcUrl, hubAddress, HARDHAT_KEYS.EXTRA3));
    await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, owner.getSignerAddress(), 50_000n * TRAC);
    const { accountId: granted } = await owner.createPublishingConvictionAccount(50_000n * TRAC);
    await owner.setServiceSpending(granted, true);
    const { epoch, endsAt } = await chain.getEpochTimes();
    const terms = { accountId: granted, buyer: NODE, maxCostPerEpoch: 1_000n * TRAC, expiresAt: endsAt + 40 * DAY, nonce: 0n };
    await owner.addBuyer(terms, '0x', (await chain.signBuyerGrant(terms)).signature);
    await scheduleInFull(granted);
    const source = (accountId: bigint) => ({ kind: 'account', accountId: String(accountId) });
    expect((await api('POST', '/api/marketplace/subscriptions/preview', { epoch: 'current', source: source(granted), services: [service(A, 10n)] })).body.refusal)
      .toEqual({ code: 'EmissionAlreadyScheduled', args: [String(granted)] });
    expect(await simulatedRevert(() => chain.fundFromAccount({
      accountId: granted, epoch, sessionKey: Wallet.createRandom().address, planDigest: ethers.ZeroHash,
      budgets: [{ serviceId: A, serviceClass: 1, value: 10n * TRAC, maxPricePerUnit: 10n ** 12n }],
    }, { from: NODE }))).toBe('EmissionAlreadyScheduled');

    // The new-account path: a new account (as POST /api/pca creates it), opted in, the node added, then funded.
    const fresh = await grantedAccount(50_000n, 1_000n);
    const funded = await api('POST', '/api/marketplace/subscriptions', { epoch: 'current', source: source(fresh), services: [service(A, 100n)] });
    expect(funded.status).toBe(200);
    expect(funded.body.subscription.cost).toBe(String(80n * TRAC));
  });

  it("grants the node on an account a browser wallet owns, with the node's signed consent", async () => {
    const browser = new EVMChainAdapter(makeAdapterConfig(getSharedContext().rpcUrl, getSharedContext().hubAddress, HARDHAT_KEYS.EXTRA1));
    const owner = browser.getSignerAddress();
    await mintTokens(createProvider(), getSharedContext().hubAddress, HARDHAT_KEYS.DEPLOYER, owner, 50_000n * TRAC);
    const { accountId } = await browser.createPublishingConvictionAccount(50_000n * TRAC);
    await browser.setServiceSpending(accountId, true);
    expect(await api('POST', `/api/marketplace/accounts/${accountId}/service-spending`, { enabled: false }))
      .toMatchObject({ status: 403, body: { code: 'NotAccountOwner' } });

    const contracts = (await api('GET', '/api/marketplace/accounts/contracts')).body;
    expect(contracts).toMatchObject({ chainId: 31337, buyerWallet: NODE, grantDomain: { name: 'DKGServiceSubscriptions', version: '1' } });
    const { endsAt } = await chain.getEpochTimes();
    const consent = (await api('POST', `/api/marketplace/accounts/${accountId}/buyer-consent`, { maxCostPerEpoch: String(500n * TRAC), expiresAt: endsAt + 10 * DAY })).body;
    expect(recoverSigner(consent.digest, consent.buyerSignature)).toBe(NODE);
    expect(ethers.TypedDataEncoder.hash(contracts.grantDomain, contracts.grantTypes, consent.terms)).toBe(consent.digest);

    // The browser wallet sends addBuyer: its consent by sending, the node's by signature.
    const terms = { ...consent.terms, accountId: BigInt(consent.terms.accountId), maxCostPerEpoch: BigInt(consent.terms.maxCostPerEpoch), nonce: BigInt(consent.terms.nonce) };
    await browser.addBuyer(terms, '0x', consent.buyerSignature);
    const account = (await api('GET', '/api/marketplace/accounts')).body.accounts.find((a: any) => a.accountId === String(accountId));
    expect(account).toMatchObject({ ownedByNode: false, serviceCapable: true, grant: { buyer: NODE, live: true } });
    const funded = await api('POST', '/api/marketplace/subscriptions', { epoch: 'next', source: { kind: 'account', accountId: String(accountId) }, services: [service(A, 100n)] });
    expect(funded.body.subscription).toMatchObject({ epoch: (await chain.getEpochTimes()).epoch + 1, cost: String(80n * TRAC) });
  });
});
