// SPDX-License-Identifier: Apache-2.0

/**
 * What the node API's buyer routes (`/api/marketplace`) return, in the shapes
 * of the UI data contract: the buyer's subscriptions and their budgets, a dry
 * run, the standing plan and its next renewal, the buyer wallet's funding,
 * the accounts it can use, and what a browser wallet needs to act as an
 * account's owner. Amounts are decimal strings of wei, each with a `…Trac`
 * sibling; times are chain seconds.
 */
import { ethers } from 'ethers';
import {
  BUYER_GRANT_TYPES,
  SERVICE_CLASS_QUERY,
  subscriptionIdOf,
  type BuyerGrant,
  type MarketplaceChainAdapter,
  type Subscription,
  type TxResult,
} from '@origintrail-official/dkg-chain';
import { MarketplaceRefusal, accountRefusal, renewsEpochUnderWay, type Buyer, type FundingCheck } from './buyer.js';
import { serviceToWire, type FundingSource, type StandingPlan } from './plan.js';

/** A budget's soft ceiling: calls stop at 95% of its value (RFC-27). */
const SOFT_CEILING_PERCENT = 95n;

/** `{ [name]: wei, [name + unit]: the amount in whole tokens }`. */
export function amount<N extends string, U extends string = 'Trac'>(
  name: N,
  wei: bigint,
  unit: U = 'Trac' as U,
): Record<N | `${N}${U}`, string> {
  return { [name]: wei.toString(), [`${name}${unit}`]: ethers.formatEther(wei) } as Record<N | `${N}${U}`, string>;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function txView(tx: TxResult): { txHash: string; blockNumber: number } {
  return { txHash: tx.hash, blockNumber: tx.blockNumber };
}

async function sourceView(chain: MarketplaceChainAdapter, source: FundingSource, discountBps?: number) {
  if (source.kind === 'wallet') return { kind: 'wallet' as const };
  const bps = discountBps ?? (await chain.getPublishingConvictionAccountInfo(source.accountId))?.discountBps ?? 0;
  return { kind: 'account' as const, accountId: source.accountId.toString(), discountBps: bps };
}

/** A budget's receipts this node holds and has not seen landed, as the gateway counts them. */
export type HeldValue = (subscriptionId: string, budgetIndex: number) => bigint;

/** A subscription and its budgets: what each used and has left on chain, what the node holds, and its soft ceiling. */
export async function subscriptionView(chain: MarketplaceChainAdapter, s: Subscription, held?: HeldValue) {
  const budgets = await chain.getBudgets(s.subscriptionId);
  const source: FundingSource = s.accountId === 0n ? { kind: 'wallet' } : { kind: 'account', accountId: s.accountId };
  return {
    subscriptionId: s.subscriptionId,
    epoch: s.epoch,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    source: await sourceView(chain, source, s.discountBps),
    ...amount('value', s.value),
    ...amount('cost', s.cost),
    sessionKey: s.sessionKey,
    budgets: await Promise.all(budgets.map(async (b, budgetIndex) => {
      const [used, left] = await Promise.all([
        chain.budgetUsed(s.subscriptionId, budgetIndex),
        chain.budgetLeft(s.subscriptionId, budgetIndex),
      ]);
      return {
        budgetIndex,
        serviceId: b.serviceId,
        // As the chain stored it: a top-up repeats it, whatever the catalog says of the service now.
        serviceClass: b.serviceClass === SERVICE_CLASS_QUERY ? 'query' : 'inference',
        ...amount('value', b.value),
        ...amount('maxPricePerUnit', b.maxPricePerUnit),
        ...amount('used', used),
        ...amount('held', held?.(s.subscriptionId, budgetIndex) ?? 0n),
        ...amount('left', left),
        ...amount('softCeiling', (b.value * SOFT_CEILING_PERCENT) / 100n),
      };
    })),
  };
}

/** The buyer's subscriptions in `epochs`, those it has. */
export async function subscriptionsView(buyer: Buyer, epochs: readonly number[], held?: HeldValue) {
  const subscriptions = [];
  for (const epoch of epochs) {
    const s = await buyer.chain.getSubscription(subscriptionIdOf(buyer.buyerWallet, epoch));
    if (s) subscriptions.push(await subscriptionView(buyer.chain, s, held));
  }
  return { subscriptions };
}

export async function dryRunView(chain: MarketplaceChainAdapter, check: FundingCheck) {
  return {
    epoch: check.epoch,
    source: await sourceView(chain, check.source, check.discountBps),
    ...amount('value', check.value),
    ...amount('cost', check.cost),
    discountBps: check.discountBps,
    ...(check.refusal ? { refusal: check.refusal } : {}),
  };
}

/**
 * The plan and its next renewal: the epoch the job funds next, from when, at
 * what cost, and the refusal it would meet now. No `next` once the plan ends
 * or stops renewing, or while both epochs the job can fund are funded.
 */
export async function planView(buyer: Buyer, plan: StandingPlan) {
  const times = await buyer.chain.getEpochTimes();
  let next: { epoch: number; at: number; cost: string; costTrac: string; refusal?: string } | undefined;
  for (const epoch of [times.epoch, times.epoch + 1]) {
    if (!plan.renew || plan.renewUntilEpoch === undefined || epoch > plan.renewUntilEpoch) break;
    // As the renewal job decides: the epoch under way only while enough of it is left.
    if (epoch === times.epoch && !renewsEpochUnderWay(times)) continue;
    if (await buyer.chain.subscriptionExists(subscriptionIdOf(buyer.buyerWallet, epoch))) continue;
    const check = await buyer.dryRun({ epoch, source: plan.source, services: plan.services });
    const at = epoch === times.epoch ? times.now : Math.max(times.now, times.endsAt - buyer.config.prefundLeadSeconds);
    next = { epoch, at, ...amount('cost', check.cost), ...(check.refusal ? { refusal: check.refusal.code } : {}) };
    break;
  }
  return {
    services: plan.services.map((s) => ({ ...serviceToWire(s), ...amount('value', s.value), ...amount('maxPricePerUnit', s.maxPricePerUnit) })),
    source: await sourceView(buyer.chain, plan.source),
    renew: plan.renew,
    ...(plan.renewUntilEpoch !== undefined ? { renewUntilEpoch: plan.renewUntilEpoch } : {}),
    ...(next ? { next } : {}),
  };
}

function grantView(buyer: string, grant: BuyerGrant, owner: string, now: number) {
  return {
    buyer,
    ...amount('maxCostPerEpoch', grant.maxCostPerEpoch),
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    live: grant.revokedAt === 0 && now < grant.expiresAt && sameAddress(grant.owner, owner),
  };
}

/**
 * One account: whether it can pay for services and, when not, the contracts'
 * reason; its discount and this window's allowance; the grant to the buyer
 * wallet; and its buyer wallets and publisher wallets, two separate lists.
 */
export async function accountView(buyer: Buyer, accountId: bigint) {
  const chain = buyer.chain;
  const info = await chain.getPublishingConvictionAccountInfo(accountId);
  if (!info) throw new MarketplaceRefusal('ERC721NonexistentToken', [String(accountId)]);
  const [window, buyers, publisherWallets, { now }] = await Promise.all([
    chain.currentWindowAllowance(accountId),
    chain.getAccountBuyers(accountId),
    chain.getPublishingConvictionAgents(accountId),
    chain.getEpochTimes(),
  ]);
  const buyerWallets = await Promise.all(buyers.map(async (b) => grantView(b, (await chain.getGrant(accountId, b))!, info.owner, now)));
  const refusal = (await accountRefusal(chain, accountId, info))?.code ?? (window.expired ? 'AccountExpired' : undefined);
  const grant = buyerWallets.find((g) => sameAddress(g.buyer, buyer.buyerWallet));
  return {
    accountId: accountId.toString(),
    ownedByNode: buyer.nodeWallets.some((w) => sameAddress(w, info.owner)),
    serviceCapable: refusal === undefined,
    ...(refusal ? { refusal } : {}),
    discountBps: info.discountBps,
    window: {
      index: window.window,
      ...amount('baseRemaining', window.baseRemaining),
      ...amount('topUpBuffer', window.topUpBuffer),
      expired: window.expired,
    },
    ...(grant ? { grant } : {}),
    buyerWallets,
    publisherWallets,
  };
}

/**
 * How long the accounts and funding views wait for the account list. Listing the accounts that granted
 * the buyer wallet reads the chain's event logs, and on a public RPC the first read after a start can
 * take minutes; past this wait a view answers with the list it last read and `accountsPending: true`.
 */
export const ACCOUNT_LIST_WAIT_MS = 5_000;

/**
 * A buyer's account list: the ids read last, why the last read that finished failed (until a read succeeds), and the
 * read in flight, which every view waiting for the list shares.
 */
interface AccountListRefresh {
  last?: bigint[];
  failure?: unknown;
  running?: Promise<bigint[]>;
}

/** How a failed account-list read reads in a view's `accountsError`. */
function accountListFailureOf(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

const accountListRefreshes = new WeakMap<Buyer, AccountListRefresh>();

/**
 * The buyer's refresh, with a read of the account ids in flight: the one already running, or a new one. A read that
 * settles, whether it read the list or failed, lets the next view start another.
 */
function refreshAccountIds(buyer: Buyer): { refresh: AccountListRefresh; running: Promise<bigint[]> } {
  let refresh = accountListRefreshes.get(buyer);
  if (!refresh) {
    refresh = {};
    accountListRefreshes.set(buyer, refresh);
  }
  if (refresh.running) return { refresh, running: refresh.running };
  const owner = refresh;
  const running = Promise.all([
    buyer.chain.listNodePublishingConvictionAccounts(),
    buyer.chain.listBuyerAccounts(buyer.buyerWallet),
  ]).then(([owned, granted]) => {
    const ids = [...new Set([...owned.map((a) => a.accountId), ...granted])].sort((a, b) => (a < b ? -1 : 1));
    owner.last = ids;
    return ids;
  });
  owner.running = running;
  const settle = (): void => {
    if (owner.running === running) owner.running = undefined;
  };
  // A read that fails after its views stopped waiting is kept, so the next view can say so; a read that succeeds clears it.
  running.then(() => { owner.failure = undefined; settle(); }, (err: unknown) => { owner.failure = err; settle(); });
  return { refresh: owner, running };
}

/**
 * The ids of the accounts the node owns and of those that granted the buyer wallet, or the last ones read if the read
 * takes longer than `waitMs`, with why the last read that finished failed, if it did.
 */
async function accountIdsOf(buyer: Buyer, waitMs: number): Promise<{ ids: bigint[]; pending: boolean; failure?: unknown }> {
  const { refresh, running } = refreshAccountIds(buyer);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const ids = await Promise.race([running, waited]);
    if (ids !== null) return { ids, pending: false };
    // The read goes on and keeps what it reads, so a later view answers from it.
    return { ids: refresh.last ?? [], pending: true, ...(refresh.failure !== undefined ? { failure: refresh.failure } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The accounts the node's primary wallet owns, as `/api/pca` lists them, and those that granted the buyer wallet.
 * `accountsPending` is true when the list was still being read after `waitMs`: `accounts` is then the list read last,
 * and `accountsError` says why the last read that finished failed, when it did and no read has succeeded since.
 */
export async function accountsView(buyer: Buyer, waitMs = ACCOUNT_LIST_WAIT_MS) {
  const { ids, pending, failure } = await accountIdsOf(buyer, waitMs);
  return {
    accounts: await Promise.all(ids.map((id) => accountView(buyer, id))),
    accountsPending: pending,
    ...(failure !== undefined ? { accountsError: accountListFailureOf(failure) } : {}),
  };
}

/** The buyer wallet, its balances and its allowance to `ServiceSubscriptionsWallet`, and the accounts it can use (see `accountsView`). */
export async function fundingView(buyer: Buyer, waitMs = ACCOUNT_LIST_WAIT_MS) {
  const chain = buyer.chain;
  const [times, balances, allowance, { accounts, accountsPending, accountsError }] = await Promise.all([
    chain.getEpochTimes(),
    chain.getWalletBalances(buyer.buyerWallet),
    chain.getServiceSubscriptionsWalletAllowance(buyer.buyerWallet),
    accountsView(buyer, waitMs),
  ]);
  return {
    buyerWallet: {
      address: buyer.buyerWallet,
      ...amount('eth', balances.eth, 'Ether'),
      ...amount('trac', balances.trac),
      ...amount('walletContractAllowance', allowance),
    },
    accounts,
    accountsPending,
    ...(accountsError !== undefined ? { accountsError } : {}),
    epoch: times.epoch,
    epochEndsAt: times.endsAt,
  };
}

/** What a browser wallet needs to sign and send an account owner's actions. */
export async function contractsView(buyer: Buyer) {
  const [m, pca] = await Promise.all([buyer.chain.getMarketplaceContracts(), buyer.chain.getPublishingConvictionContracts()]);
  return {
    chainId: m.chainId,
    buyerWallet: buyer.buyerWallet,
    addresses: {
      ServiceSubscriptions: m.serviceSubscriptions,
      ServiceSubscriptionsWallet: m.serviceSubscriptionsWallet,
      ServiceSubscriptionsStorage: m.serviceSubscriptionsStorage,
      QueryInferenceSettlement: m.queryInferenceSettlement,
      QueryInferenceStorage: m.queryInferenceStorage,
      DKGPublishingConvictionNFT: pca.nft,
      Token: pca.token,
    },
    grantDomain: m.grantDomain,
    grantTypes: BUYER_GRANT_TYPES,
  };
}
