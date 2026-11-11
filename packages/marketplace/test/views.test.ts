// SPDX-License-Identifier: Apache-2.0
/** The node API's buyer shapes, against MockChainAdapter's marketplace. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { BUYER_GRANT_TYPES, MockChainAdapter, SERVICE_CLASS_QUERY, marketplaceChainOf, subscriptionIdOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import {
  Buyer,
  BuyerStore,
  accountView,
  accountsView,
  amount,
  contractsView,
  dryRunView,
  fundingView,
  parsePlan,
  planView,
  subscriptionsView,
  txView,
  type StandingPlanWire,
} from '../src/index.js';

const TRAC = 10n ** 18n;
const DAY = 86_400;
const SIGNER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const A = `0x${'0a'.repeat(32)}`;

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let buyer: Buyer;

const plan = (extra: Partial<StandingPlanWire> = {}) => parsePlan({
  services: [{ serviceId: A, serviceClass: 'inference', value: String(100n * TRAC), maxPricePerUnit: String(10n ** 9n) }],
  source: { kind: 'wallet' },
  renew: true,
  renewUntilEpoch: 5,
  ...extra,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-views-'));
  mock = new MockChainAdapter('mock:31337', SIGNER.address);
  mock.setMockACKSigner(SIGNER);
  chain = marketplaceChainOf(mock)!;
  buyer = new Buyer({
    chain,
    store: new BuyerStore(dir),
    config: { enabled: true, buyerWallet: SIGNER.address, prefundLeadSeconds: 7_200, tickSeconds: 300 },
  });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('amounts and transactions', () => {
  it('carries wei with a sibling in whole tokens', () => {
    expect(amount('value', 2_500_000_000_000_000_000n)).toEqual({ value: '2500000000000000000', valueTrac: '2.5' });
    expect(amount('eth', 10n ** 17n, 'Ether')).toEqual({ eth: '100000000000000000', ethEther: '0.1' });
    expect(txView({ hash: '0xab', blockNumber: 7, success: true })).toEqual({ txHash: '0xab', blockNumber: 7 });
  });
});

describe('subscriptions and dry runs', () => {
  it('shows a funded subscription with its budgets, what they used and their soft ceiling', async () => {
    const { epoch, endsAt } = await chain.getEpochTimes();
    await buyer.fund({ epoch, source: { kind: 'wallet' }, services: plan().services });
    const { subscriptions } = await subscriptionsView(buyer, [epoch, epoch + 1]);
    expect(subscriptions).toHaveLength(1);
    const [s] = subscriptions;
    expect(s).toMatchObject({
      subscriptionId: subscriptionIdOf(SIGNER.address, epoch), epoch, endsAt, source: { kind: 'wallet' },
      value: String(100n * TRAC), valueTrac: '100.0', cost: String(100n * TRAC), costTrac: '100.0',
    });
    expect(s!.sessionKey).toBe(await buyer.store.sessionKeyAddress(s!.subscriptionId));
    expect(s!.budgets).toEqual([{
      budgetIndex: 0, serviceId: A, serviceClass: 'inference',
      value: String(100n * TRAC), valueTrac: '100.0',
      maxPricePerUnit: String(10n ** 9n), maxPricePerUnitTrac: '0.000000001',
      used: '0', usedTrac: '0.0', held: '0', heldTrac: '0.0',
      left: String(100n * TRAC), leftTrac: '100.0',
      softCeiling: String(95n * TRAC), softCeilingTrac: '95.0',
    }]);
  });

  it("names each budget's class as the chain stored it: a query budget comes back as query", async () => {
    const { epoch } = await chain.getEpochTimes();
    const B = `0x${'0b'.repeat(32)}`;
    await buyer.fund({ epoch, source: { kind: 'wallet' }, services: [...plan().services, { serviceId: B, serviceClass: SERVICE_CLASS_QUERY, value: TRAC, maxPricePerUnit: 10n ** 9n }] });
    const { subscriptions } = await subscriptionsView(buyer, [epoch]);
    expect(subscriptions[0]!.budgets.map((b) => [b.serviceId, b.serviceClass])).toEqual([[A, 'inference'], [B, 'query']]);
  });

  it('shows a dry run, with the account discount and the refusal', async () => {
    const { epoch } = await chain.getEpochTimes();
    const { accountId } = await mock.createPublishingConvictionAccount(120_000n * TRAC);
    const check = await buyer.dryRun({ epoch, source: { kind: 'account', accountId }, services: plan().services });
    expect(await dryRunView(chain, check)).toEqual({
      epoch, source: { kind: 'account', accountId: String(accountId), discountBps: 3000 },
      value: String(100n * TRAC), valueTrac: '100.0', cost: String(70n * TRAC), costTrac: '70.0', discountBps: 3000,
      refusal: { code: 'ServiceSpendingDisabled', args: [String(accountId)] },
    });
  });
});

describe('the plan', () => {
  it('names the next renewal: the current epoch now, then the next one at the prefund lead', async () => {
    const times = await chain.getEpochTimes();
    const first = await planView(buyer, plan());
    expect(first).toMatchObject({ source: { kind: 'wallet' }, renew: true, renewUntilEpoch: 5, next: { epoch: times.epoch, cost: String(100n * TRAC) } });
    expect(first.services).toEqual([{
      serviceId: A, serviceClass: 'inference', value: String(100n * TRAC), valueTrac: '100.0',
      maxPricePerUnit: String(10n ** 9n), maxPricePerUnitTrac: '0.000000001',
    }]);
    expect(first.next!.at).toBeGreaterThanOrEqual(times.now);

    await buyer.fund({ epoch: times.epoch, source: { kind: 'wallet' }, services: plan().services });
    expect((await planView(buyer, plan())).next).toMatchObject({ epoch: times.epoch + 1, at: times.endsAt - 7_200 });
    expect((await planView(buyer, plan({ renewUntilEpoch: times.epoch }))).next).toBeUndefined();
    expect((await planView(buyer, plan({ renew: false, renewUntilEpoch: undefined }))).next).toBeUndefined();
  });

  it('gives the refusal the next renewal would meet', async () => {
    const { accountId } = await mock.createPublishingConvictionAccount(120_000n * TRAC);
    const view = await planView(buyer, plan({ source: { kind: 'account', accountId: String(accountId) } }));
    expect(view.source).toEqual({ kind: 'account', accountId: String(accountId), discountBps: 3000 });
    expect(view.next).toMatchObject({ cost: String(70n * TRAC), refusal: 'ServiceSpendingDisabled' });
  });
});

describe('accounts and funding', () => {
  it('shows whether an account can pay, its window, its grant and its two wallet lists', async () => {
    const { accountId } = await mock.createPublishingConvictionAccount(120_000n * TRAC);
    expect(await accountView(buyer, accountId)).toMatchObject({
      accountId: String(accountId), ownedByNode: true, serviceCapable: false, refusal: 'ServiceSpendingDisabled', discountBps: 3000,
      window: { index: 0, baseRemaining: String(10_000n * TRAC), baseRemainingTrac: '10000.0', topUpBuffer: '0', expired: false },
      buyerWallets: [], publisherWallets: [],
    });

    await chain.setServiceSpending(accountId, true);
    const { now } = await chain.getEpochTimes();
    await chain.addBuyer({ accountId, buyer: SIGNER.address, maxCostPerEpoch: 500n * TRAC, expiresAt: now + 30 * DAY, nonce: 0n }, '0x', '0x');
    const grant = { buyer: SIGNER.address, maxCostPerEpoch: String(500n * TRAC), maxCostPerEpochTrac: '500.0', expiresAt: now + 30 * DAY, revokedAt: 0, live: true };
    const view = await accountView(buyer, accountId);
    expect(view).toMatchObject({ serviceCapable: true, grant, buyerWallets: [grant] });
    expect(view).not.toHaveProperty('refusal');

    await chain.removeBuyer(accountId, SIGNER.address);
    expect((await accountView(buyer, accountId)).grant).toMatchObject({ live: false });
    await expect(accountView(buyer, 99n)).rejects.toMatchObject({ code: 'ERC721NonexistentToken' });
  });

  it('lists the accounts the node owns and those that granted the buyer wallet, and the wallet balances', async () => {
    const first = await mock.createPublishingConvictionAccount(120_000n * TRAC);
    const second = await mock.createPublishingConvictionAccount(1_000n * TRAC);
    expect((await accountsView(buyer)).accounts.map((a) => a.accountId)).toEqual([String(first.accountId), String(second.accountId)]);

    await chain.approveServiceSubscriptionsWallet(42n * TRAC);
    const funding = await fundingView(buyer);
    expect(funding.buyerWallet).toEqual({
      address: SIGNER.address,
      eth: String(100n * TRAC), ethEther: '100.0',
      trac: String(1_000_000n * TRAC), tracTrac: '1000000.0',
      walletContractAllowance: String(42n * TRAC), walletContractAllowanceTrac: '42.0',
    });
    expect(funding.accounts).toHaveLength(2);
    expect(funding.accountsPending).toBe(false);
    expect(funding.epochEndsAt).toBe((await chain.getEpochTimes()).endsAt);
  });

  it('answers without waiting for an account list that takes long to read, and from the last list read', async () => {
    const owned = await mock.createPublishingConvictionAccount(120_000n * TRAC);
    const listBuyerAccounts = chain.listBuyerAccounts.bind(chain);
    const listNodeAccounts = chain.listNodePublishingConvictionAccounts.bind(chain);
    let granted = 0;
    let owners = 0;
    const releases: Array<(ids: bigint[]) => void> = [];
    chain.listBuyerAccounts = () => { granted += 1; return new Promise<bigint[]>((resolve) => { releases.push(resolve); }); };
    chain.listNodePublishingConvictionAccounts = () => { owners += 1; return listNodeAccounts(); };
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      // No list read yet: both views answer with the balances and no accounts, from one shared read.
      const [first, overlapping] = await Promise.all([fundingView(buyer, 10), accountsView(buyer, 10)]);
      expect(first.accountsPending).toBe(true);
      expect(first.accounts).toEqual([]);
      expect(first.buyerWallet.address).toBe(SIGNER.address);
      expect(overlapping).toEqual({ accounts: [], accountsPending: true });
      expect([granted, owners]).toEqual([1, 1]);

      // The read finishes after the views answered. A later view starts the next read and, while it runs,
      // answers from the list the first one read.
      releases[0]!([]);
      await settled();
      const second = await fundingView(buyer, 10);
      expect([granted, owners]).toEqual([2, 2]);
      expect(second.accountsPending).toBe(true);
      expect(second.accounts.map((a) => a.accountId)).toEqual([String(owned.accountId)]);
      releases[1]!([]);
      await settled();
    } finally {
      chain.listBuyerAccounts = listBuyerAccounts;
      chain.listNodePublishingConvictionAccounts = listNodeAccounts;
    }
    const third = await fundingView(buyer);
    expect(third.accountsPending).toBe(false);
    expect(third.accounts.map((a) => a.accountId)).toEqual([String(owned.accountId)]);
  });

  it('fails a view whose account list fails before the wait is over, and reads again for the next view', async () => {
    const listBuyerAccounts = chain.listBuyerAccounts.bind(chain);
    chain.listBuyerAccounts = () => Promise.reject(new Error('no backend'));
    try {
      await expect(fundingView(buyer, 1_000)).rejects.toThrow('no backend');
    } finally {
      chain.listBuyerAccounts = listBuyerAccounts;
    }
    expect((await fundingView(buyer)).accountsPending).toBe(false);
  });

  it('tells the next view that a list read failed after the views stopped waiting, until a read succeeds', async () => {
    const listBuyerAccounts = chain.listBuyerAccounts.bind(chain);
    const fails: Array<(err: Error) => void> = [];
    chain.listBuyerAccounts = () => new Promise<bigint[]>((_resolve, reject) => { fails.push(reject); });
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const first = await fundingView(buyer, 10);
      expect(first.accountsPending).toBe(true);
      expect(first).not.toHaveProperty('accountsError');

      // The read fails after the view answered; the next view, which cannot wait either, says so.
      fails[0]!(new Error('upstream timeout'));
      await settled();
      const second = await fundingView(buyer, 10);
      expect(second.accountsPending).toBe(true);
      expect(second.accountsError).toBe('upstream timeout');
      expect((await accountsView(buyer, 10)).accountsError).toBe('upstream timeout');
      fails[1]!(new Error('upstream timeout'));
      await settled();
    } finally {
      chain.listBuyerAccounts = listBuyerAccounts;
    }
    // A read that succeeds clears it.
    const third = await fundingView(buyer);
    expect(third.accountsPending).toBe(false);
    expect(third).not.toHaveProperty('accountsError');

    // Seen where it shows: a later read that cannot finish in time answers pending, without the old failure.
    chain.listBuyerAccounts = () => new Promise<bigint[]>(() => undefined);
    try {
      const fourth = await fundingView(buyer, 10);
      expect(fourth.accountsPending).toBe(true);
      expect(fourth).not.toHaveProperty('accountsError');
      const accounts = await accountsView(buyer, 10);
      expect(accounts.accountsPending).toBe(true);
      expect(accounts).not.toHaveProperty('accountsError');
    } finally {
      chain.listBuyerAccounts = listBuyerAccounts;
    }
  });

  it('gives a browser wallet the contracts, the grant domain and its types', async () => {
    const contracts = await contractsView(buyer);
    const m = await chain.getMarketplaceContracts();
    expect(contracts).toMatchObject({ chainId: 31337, buyerWallet: SIGNER.address, grantDomain: m.grantDomain, grantTypes: BUYER_GRANT_TYPES });
    expect(contracts.addresses.ServiceSubscriptions).toBe(m.serviceSubscriptions);
    expect(Object.keys(contracts.addresses)).toHaveLength(7);
  });
});
