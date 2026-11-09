// SPDX-License-Identifier: Apache-2.0
/**
 * The buyer against MockChainAdapter's marketplace: fundings from the wallet
 * and from an account, top-ups and their dry runs, the checks before sending,
 * and the job that funds, prefunds and tops up from what the chain shows.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, marketplaceChainOf, subscriptionIdOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import {
  Buyer,
  BuyerStore,
  MarketplaceRefusal,
  parsePlan,
  refusalOf,
  type BuyerAlert,
  type PlannedService,
  type ResolvedMarketplaceConfig,
  type StandingPlanWire,
} from '../src/index.js';

const TRAC = 10n ** 18n;
const DAY = 86_400;
const SIGNER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const A = `0x${'0a'.repeat(32)}`;
const B = `0x${'0b'.repeat(32)}`;
const service = (serviceId: string, value: bigint, serviceClass = 1): PlannedService =>
  ({ serviceId, serviceClass, value, maxPricePerUnit: 10n ** 9n });

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let store: BuyerStore;
let alerts: BuyerAlert[];

function buyerWith(config: Partial<ResolvedMarketplaceConfig> = {}): Buyer {
  return new Buyer({
    chain,
    store,
    config: { enabled: true, buyerWallet: SIGNER.address, prefundLeadSeconds: 7_200, tickSeconds: 300, ...config },
    onAlert: (alert) => alerts.push(alert),
  });
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; args: string[] } | null> {
  return promise.then(() => null, (err: unknown) => refusalOf(err));
}

/** An account of the node's own wallet, with service spending on and the wallet as its buyer. */
async function grantedAccount(maxCostPerEpoch = 1_000n * TRAC, expiresIn = 90 * DAY): Promise<bigint> {
  const { accountId } = await mock.createPublishingConvictionAccount(120_000n * TRAC);
  await chain.setServiceSpending(accountId, true);
  const { now } = await chain.getEpochTimes();
  await chain.addBuyer(
    { accountId, buyer: SIGNER.address, maxCostPerEpoch, expiresAt: now + expiresIn, nonce: await chain.grantNonce(accountId) },
    '0x', '0x',
  );
  return accountId;
}

/** What another store over the buyer's directory holds for the epoch's subscription: the stored key's address, and the key it opens. */
async function keyOnDisk(epoch: number): Promise<{ stored: string | null; opened: string | null }> {
  const subscriptionId = subscriptionIdOf(SIGNER.address, epoch);
  const fresh = new BuyerStore(dir);
  const stored = await fresh.sessionKeyAddress(subscriptionId);
  return { stored, opened: stored === null ? null : (await fresh.sessionKeyFor(subscriptionId)).address };
}

const planWire = (extra: Partial<StandingPlanWire> = {}): StandingPlanWire => ({
  services: [{ serviceId: A, serviceClass: 'inference', value: String(100n * TRAC), maxPricePerUnit: String(10n ** 9n) }],
  source: { kind: 'wallet' },
  renew: true,
  renewUntilEpoch: 3,
  ...extra,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-buyer-'));
  mock = new MockChainAdapter('mock:31337', SIGNER.address);
  mock.setMockACKSigner(SIGNER);
  chain = marketplaceChainOf(mock)!;
  store = new BuyerStore(dir);
  alerts = [];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('funding from the wallet', () => {
  it('stores the session key before sending, raises the allowance for the plan, and funds once per epoch', async () => {
    const buyer = buyerWith();
    const { epoch } = await chain.getEpochTimes();
    await store.writePlan(parsePlan(planWire()));
    const request = { epoch, source: { kind: 'wallet' as const }, services: [service(A, 100n * TRAC)] };

    expect(await buyer.dryRun(request)).toEqual({ epoch, source: { kind: 'wallet' }, value: 100n * TRAC, cost: 100n * TRAC, discountBps: 0 });
    // What is on disk as the funding is sent, read by another store over the same directory.
    const send = chain.fundFromWallet.bind(chain);
    const atSend: Array<{ named: string; stored: string | null; opened: string | null }> = [];
    vi.spyOn(chain, 'fundFromWallet').mockImplementation(async (funding, opts) => {
      atSend.push({ named: funding.sessionKey, ...(await keyOnDisk(funding.epoch)) });
      return send(funding, opts);
    });
    const funded = await buyer.fund(request);
    const subscriptionId = subscriptionIdOf(SIGNER.address, epoch);
    expect(funded.subscriptionId).toBe(subscriptionId);
    const { sessionKey } = (await chain.getSubscription(subscriptionId))!;
    expect(atSend).toEqual([{ named: sessionKey, stored: sessionKey, opened: sessionKey }]);
    // The block it was funded in, where reading what landed for it starts.
    expect(await store.fundingBlock(subscriptionId)).toBe(funded.blockNumber);
    // The plan runs through epoch 3: three epochs of 100 TRAC approved, one spent.
    expect(await chain.getServiceSubscriptionsWalletAllowance(SIGNER.address)).toBe(200n * TRAC);

    expect(await refusal(buyer.fund(request))).toEqual({ code: 'SubscriptionAlreadyFunded', args: [subscriptionId] });
    expect((await buyer.dryRun({ ...request, epoch: epoch + 2 })).refusal).toEqual({ code: 'InvalidFundingRequest', args: ['epoch'] });
    const tooMany = Array.from({ length: 17 }, (_, i) => service(ethers.toBeHex(i + 1, 32), TRAC));
    expect((await buyer.dryRun({ ...request, epoch: epoch + 1, services: tooMany })).refusal?.code).toBe('InvalidFundingRequest');
  });

  it('funds even when the funding block cannot be kept, and says so', async () => {
    const logs: string[] = [];
    const buyer = new Buyer({ chain, store, config: { enabled: true, buyerWallet: SIGNER.address, prefundLeadSeconds: 7_200, tickSeconds: 300 }, log: (m) => logs.push(m) });
    vi.spyOn(store, 'recordFunding').mockRejectedValueOnce(new Error('the disk is full'));
    const { epoch } = await chain.getEpochTimes();
    const funded = await buyer.fund({ epoch, source: { kind: 'wallet' }, services: [service(A, TRAC)] });
    expect(await store.fundingBlock(funded.subscriptionId)).toBeNull();
    expect(logs).toEqual([expect.stringMatching(/funding block .* was not kept: the disk is full/)]);
  });

  it('serializes fundings: the second of two for one epoch is refused before it is sent', async () => {
    const buyer = buyerWith();
    const { epoch } = await chain.getEpochTimes();
    const send = vi.spyOn(chain, 'fundFromWallet');
    const request = { epoch, source: { kind: 'wallet' as const }, services: [service(A, TRAC)] };
    const results = await Promise.allSettled([buyer.fund(request), buyer.fund(request)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(MarketplaceRefusal);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing, from the wallet or an account, when the session key cannot be stored', async () => {
    const accountId = await grantedAccount();
    const buyer = buyerWith();
    const { epoch } = await chain.getEpochTimes();
    const sends = (['fundFromWallet', 'fundFromAccount', 'approveServiceSubscriptionsWallet'] as const).map((name) => vi.spyOn(chain, name));
    vi.spyOn(store, 'sessionKeyFor').mockRejectedValue(new Error('the disk is full'));
    for (const source of [{ kind: 'wallet' as const }, { kind: 'account' as const, accountId }]) {
      await expect(buyer.fund({ epoch, source, services: [service(A, TRAC)] })).rejects.toThrow('the disk is full');
    }
    for (const send of sends) expect(send).not.toHaveBeenCalled();
    expect(await chain.subscriptionExists(subscriptionIdOf(SIGNER.address, epoch))).toBe(false);
    expect(await keyOnDisk(epoch)).toEqual({ stored: null, opened: null });
  });

  it('refuses a value above the wallet TRAC, and a paused or inactive pool, without sending', async () => {
    const buyer = buyerWith();
    const { epoch } = await chain.getEpochTimes();
    const send = vi.spyOn(chain, 'fundFromWallet');
    const request = { epoch, source: { kind: 'wallet' as const }, services: [service(A, 2_000_000n * TRAC)] };
    expect((await refusal(buyer.fund(request)))?.code).toBe('ERC20InsufficientBalance');
    const state = await chain.batchState();
    vi.spyOn(chain, 'batchState').mockResolvedValueOnce({ ...state, paused: true }).mockResolvedValueOnce({ ...state, activationEpoch: epoch + 1 });
    expect((await buyer.dryRun(request)).refusal?.code).toBe('QueryInferencePaused');
    expect((await buyer.dryRun(request)).refusal).toEqual({ code: 'QueryInferenceNotActive', args: [String(epoch + 1), String(epoch)] });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('funding from an account', () => {
  it('funds the current and the next epoch at the account discount, within the grant', async () => {
    const accountId = await grantedAccount();
    const buyer = buyerWith();
    const { epoch } = await chain.getEpochTimes();
    const source = { kind: 'account' as const, accountId };
    const check = await buyer.dryRun({ epoch, source, services: [service(A, 100n * TRAC)] });
    expect(check).toMatchObject({ value: 100n * TRAC, cost: 70n * TRAC, discountBps: 3000 });
    expect(check.refusal).toBeUndefined();

    // As from the wallet: the key the funding names is on disk before it is sent.
    const send = chain.fundFromAccount.bind(chain);
    const atSend: Array<{ named: string; stored: string | null; opened: string | null }> = [];
    vi.spyOn(chain, 'fundFromAccount').mockImplementation(async (funding, opts) => {
      atSend.push({ named: funding.sessionKey, ...(await keyOnDisk(funding.epoch)) });
      return send(funding, opts);
    });
    await buyer.fund({ epoch, source, services: [service(A, 100n * TRAC)] });
    const { sessionKey } = (await chain.getSubscription(subscriptionIdOf(SIGNER.address, epoch)))!;
    expect(atSend).toEqual([{ named: sessionKey, stored: sessionKey, opened: sessionKey }]);
    await buyer.fund({ epoch: epoch + 1, source, services: [service(A, 100n * TRAC)] });
    const next = await chain.getSubscription(subscriptionIdOf(SIGNER.address, epoch + 1));
    expect(next).toMatchObject({ accountId, epoch: epoch + 1, cost: 70n * TRAC });
    expect(await chain.fundingIn(epoch + 1)).toEqual({ wallet: 0n, account: 70n * TRAC });
  });

  it('refuses in the order the contracts do', async () => {
    const buyer = buyerWith();
    const { epoch, now, endsAt } = await chain.getEpochTimes();
    const request = (accountId: bigint, value = 100n * TRAC, at = epoch) => ({ epoch: at, source: { kind: 'account' as const, accountId }, services: [service(A, value)] });
    expect((await buyer.dryRun(request(99n))).refusal?.code).toBe('ERC721NonexistentToken');

    const { accountId } = await mock.createPublishingConvictionAccount(120_000n * TRAC);
    expect((await buyer.dryRun(request(accountId))).refusal?.code).toBe('ServiceSpendingDisabled');
    await chain.setServiceSpending(accountId, true);
    expect((await buyer.dryRun(request(accountId))).refusal?.code).toBe('NotABuyer');

    // A grant that ends inside this epoch funds this epoch but not the next.
    await chain.addBuyer({ accountId, buyer: SIGNER.address, maxCostPerEpoch: 100n * TRAC, expiresAt: now + DAY, nonce: 0n }, '0x', '0x');
    expect((await buyer.dryRun(request(accountId))).refusal).toBeUndefined();
    expect((await buyer.dryRun(request(accountId, 100n * TRAC, epoch + 1))).refusal)
      .toEqual({ code: 'GrantEndsBeforeSubscription', args: [String(accountId), SIGNER.address, String(now + DAY), String(endsAt)] });
    // 200 TRAC at a 30% discount is 140 TRAC, above the 100 TRAC limit.
    expect((await buyer.dryRun(request(accountId, 200n * TRAC))).refusal)
      .toEqual({ code: 'LimitExceeded', args: ['maxCostPerEpoch', String(100n * TRAC), String(140n * TRAC)] });

    // The window allows 10,000 TRAC an epoch: a grant above it meets the allowance.
    await chain.setBuyerLimits(accountId, SIGNER.address, { maxCostPerEpoch: 100_000n * TRAC, expiresAt: now + 90 * DAY });
    expect((await buyer.dryRun(request(accountId, 20_000n * TRAC))).refusal)
      .toEqual({ code: 'InsufficientAllowance', args: [String(accountId), String(epoch), String(14_000n * TRAC), String(10_000n * TRAC)] });

    await chain.removeBuyer(accountId, SIGNER.address);
    expect((await buyer.dryRun(request(accountId))).refusal?.code).toBe('GrantRevoked');
  });

  it('refuses an account its contract scheduled in full', async () => {
    const accountId = await grantedAccount();
    const buyer = buyerWith();
    const { epoch } = await chain.getEpochTimes();
    const info = (await chain.getPublishingConvictionAccountInfo(accountId))!;
    vi.spyOn(chain, 'getPublishingConvictionAccountInfo').mockResolvedValue({ ...info, lastSettledWindow: 12 });
    const send = vi.spyOn(chain, 'fundFromAccount');
    expect(await refusal(buyer.fund({ epoch, source: { kind: 'account', accountId }, services: [service(A, TRAC)] })))
      .toEqual({ code: 'EmissionAlreadyScheduled', args: [String(accountId)] });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('topping up', () => {
  it('adds value to a budget it has, under its own terms, and appends a new service', async () => {
    const buyer = buyerWith();
    const { epoch } = await chain.getEpochTimes();
    const { subscriptionId } = await buyer.fund({ epoch, source: { kind: 'wallet' }, services: [service(A, 100n * TRAC)] });
    // The caller's cap for A differs; the stored one is kept.
    const additions = [{ ...service(A, 10n * TRAC), maxPricePerUnit: 1n }, service(B, 20n * TRAC, 2)];
    // Its dry run raises no allowance: that would be a send.
    const approve = vi.spyOn(chain, 'approveServiceSubscriptionsWallet');
    expect(await buyer.dryRunTopUp(subscriptionId, additions)).toEqual({ epoch, source: { kind: 'wallet' }, value: 30n * TRAC, cost: 30n * TRAC, discountBps: 0 });
    expect(approve).not.toHaveBeenCalled();
    const topUp = await buyer.topUp(subscriptionId, additions);
    expect(topUp).toMatchObject({ value: 30n * TRAC, cost: 30n * TRAC });
    expect(await chain.getBudgets(subscriptionId)).toEqual([service(A, 110n * TRAC), service(B, 20n * TRAC, 2)]);
    expect(await refusal(buyer.topUp(subscriptionIdOf(SIGNER.address, epoch + 1), [service(A, TRAC)])))
      .toEqual({ code: 'SubscriptionNotFound', args: [subscriptionIdOf(SIGNER.address, epoch + 1)] });
    // Another buyer's subscription is not this node's to top up.
    const other = buyerWith({ buyerWallet: ethers.getAddress(`0x${'0c'.repeat(20)}`) });
    expect((await refusal(other.topUp(subscriptionId, [service(A, TRAC)])))?.code).toBe('NotSubscriptionBuyer');
  });

  it('counts the subscription cost against the grant limit for an account', async () => {
    const accountId = await grantedAccount(100n * TRAC);
    const buyer = buyerWith();
    const { epoch } = await chain.getEpochTimes();
    const { subscriptionId } = await buyer.fund({ epoch, source: { kind: 'account', accountId }, services: [service(A, 100n * TRAC)] });
    expect(await refusal(buyer.topUp(subscriptionId, [service(A, 50n * TRAC)])))
      .toEqual({ code: 'LimitExceeded', args: ['maxCostPerEpoch', String(100n * TRAC), String(105n * TRAC)] });
    await buyer.topUp(subscriptionId, [service(A, 40n * TRAC)]);
    expect((await chain.getSubscription(subscriptionId))!.cost).toBe(98n * TRAC);
  });

  it('dry-runs a top-up from an account at its discount, and one over the window allowance, sending nothing', async () => {
    const accountId = await grantedAccount(100_000n * TRAC);
    const buyer = buyerWith();
    const { epoch } = await chain.getEpochTimes();
    const { subscriptionId } = await buyer.fund({ epoch, source: { kind: 'account', accountId }, services: [service(A, 100n * TRAC)] });
    const sends = (['topUpFromAccount', 'topUpFromWallet', 'fundFromAccount', 'fundFromWallet', 'approveServiceSubscriptionsWallet'] as const)
      .map((name) => vi.spyOn(chain, name));
    const state = async () => ({
      subscription: await chain.getSubscription(subscriptionId),
      budgets: await chain.getBudgets(subscriptionId),
      window: await chain.currentWindowAllowance(accountId),
    });
    const before = await state();

    // The addition's own value and cost: 30 TRAC at a 30% discount.
    expect(await buyer.dryRunTopUp(subscriptionId, [service(A, 10n * TRAC), service(B, 20n * TRAC)]))
      .toEqual({ epoch, source: { kind: 'account', accountId }, value: 30n * TRAC, cost: 21n * TRAC, discountBps: 3000 });
    // 20,000 TRAC at a 30% discount is 14,000 TRAC, above what the window has left.
    const left = before.window.baseRemaining + before.window.topUpBuffer;
    expect(await buyer.dryRunTopUp(subscriptionId, [service(A, 20_000n * TRAC)])).toMatchObject({
      cost: 14_000n * TRAC,
      refusal: { code: 'InsufficientAllowance', args: [String(accountId), String(epoch), String(14_000n * TRAC), String(left)] },
    });
    // A subscription not found, or another buyer's, is refused as its top-up is.
    expect((await refusal(buyer.dryRunTopUp(subscriptionIdOf(SIGNER.address, epoch + 1), [service(A, TRAC)])))?.code).toBe('SubscriptionNotFound');
    const other = buyerWith({ buyerWallet: ethers.getAddress(`0x${'0c'.repeat(20)}`) });
    expect((await refusal(other.dryRunTopUp(subscriptionId, [service(A, TRAC)])))?.code).toBe('NotSubscriptionBuyer');

    for (const send of sends) expect(send).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });
});

describe('the job', () => {
  it('does nothing without a renewing plan', async () => {
    const buyer = buyerWith();
    await buyer.tick();
    await store.writePlan(parsePlan(planWire({ renew: false, renewUntilEpoch: undefined })));
    await buyer.tick();
    expect(await chain.subscriptionExists(subscriptionIdOf(SIGNER.address, 1))).toBe(false);
  });

  it('funds the current epoch, then nothing more until the prefund lead, and heals after a missed epoch', async () => {
    const buyer = buyerWith();
    const send = vi.spyOn(chain, 'fundFromWallet');
    await store.writePlan(parsePlan(planWire()));
    await buyer.tick();
    await buyer.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await chain.subscriptionExists(subscriptionIdOf(SIGNER.address, 1))).toBe(true);
    expect(await chain.subscriptionExists(subscriptionIdOf(SIGNER.address, 2))).toBe(false);
    expect(buyer.renewals.get(1)?.refusal).toBeNull();

    mock.__advanceEpoch();
    mock.__advanceEpoch();
    await buyer.tick();
    expect(await chain.subscriptionExists(subscriptionIdOf(SIGNER.address, 3))).toBe(true);
    // Past the plan's last epoch, nothing is funded.
    mock.__advanceEpoch();
    await buyer.tick();
    expect(await chain.subscriptionExists(subscriptionIdOf(SIGNER.address, 4))).toBe(false);
  });

  it('prefunds the next epoch within the lead, through the plan last epoch only', async () => {
    const buyer = buyerWith({ prefundLeadSeconds: 31 * DAY });
    await store.writePlan(parsePlan(planWire({ renewUntilEpoch: 2 })));
    await buyer.tick();
    expect(await chain.subscriptionExists(subscriptionIdOf(SIGNER.address, 1))).toBe(true);
    expect(await chain.subscriptionExists(subscriptionIdOf(SIGNER.address, 2))).toBe(true);
    mock.__advanceEpoch();
    await buyer.tick();
    expect(await chain.subscriptionExists(subscriptionIdOf(SIGNER.address, 3))).toBe(false);
  });

  it('upgrades a funded subscription with the plan services it lacks', async () => {
    const buyer = buyerWith();
    await store.writePlan(parsePlan(planWire()));
    await buyer.tick();
    await store.writePlan(parsePlan(planWire({
      services: [...planWire().services, { serviceId: B, serviceClass: 'query', value: String(5n * TRAC), maxPricePerUnit: '7' }],
    })));
    await buyer.tick();
    const budgets = await chain.getBudgets(subscriptionIdOf(SIGNER.address, 1));
    expect(budgets.map((b) => [b.serviceId, b.value])).toEqual([[A, 100n * TRAC], [B, 5n * TRAC]]);
  });

  it('alerts once per epoch and reason when a renewal fails, and records it', async () => {
    const { accountId } = await mock.createPublishingConvictionAccount(120_000n * TRAC);
    const buyer = buyerWith();
    await store.writePlan(parsePlan(planWire({ source: { kind: 'account', accountId: String(accountId) } })));
    await buyer.tick();
    await buyer.tick();
    expect(alerts).toEqual([{ epoch: 1, code: 'ServiceSpendingDisabled', message: expect.stringContaining('epoch 1 was not funded') }]);
    await chain.setServiceSpending(accountId, true);
    await buyer.tick();
    expect(alerts.map((a) => a.code)).toEqual(['ServiceSpendingDisabled', 'NotABuyer']);
    expect(buyer.renewals.get(1)?.refusal?.code).toBe('NotABuyer');

    // An error whose message changes at every tick is still one reason.
    const reads = vi.spyOn(chain, 'getGrant');
    reads.mockRejectedValueOnce(new Error('socket hang up (1)')).mockRejectedValueOnce(new Error('socket hang up (2)'));
    await buyer.tick();
    await buyer.tick();
    expect(alerts.map((a) => a.code)).toEqual(['ServiceSpendingDisabled', 'NotABuyer', 'Error']);
    expect(alerts[2]!.message).toContain('socket hang up (1)');
  });

  it('start runs a tick at once and stop waits for it', async () => {
    const buyer = buyerWith();
    await store.writePlan(parsePlan(planWire()));
    buyer.start();
    buyer.start();
    await buyer.stop();
    expect(await chain.subscriptionExists(subscriptionIdOf(SIGNER.address, 1))).toBe(true);
  });
});

describe('refusalOf', () => {
  it('reads a refusal, a decoded revert, and nothing else', async () => {
    expect(refusalOf(new MarketplaceRefusal('GrantExpired', ['1', '0xabc']))).toEqual({ code: 'GrantExpired', args: ['1', '0xabc'] });
    const reverted = await chain.fundFromWallet({ epoch: 1, sessionKey: SIGNER.address, planDigest: ethers.ZeroHash, budgets: [service(A, TRAC)] })
      .then(() => null, (err: unknown) => err);
    expect(refusalOf(reverted)?.code).toBe('ERC20InsufficientAllowance');
    expect(refusalOf(new Error('socket hang up'))).toBeNull();
  });
});
