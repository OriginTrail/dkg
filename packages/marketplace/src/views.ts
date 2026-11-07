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
  subscriptionIdOf,
  type BuyerGrant,
  type MarketplaceChainAdapter,
  type Subscription,
  type TxResult,
} from '@origintrail-official/dkg-chain';
import { END_MARGIN_SECONDS, MarketplaceRefusal, accountRefusal, type Buyer, type FundingCheck } from './buyer.js';
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

/** A subscription and its budgets: what each used and has left on chain, and its soft ceiling. */
export async function subscriptionView(chain: MarketplaceChainAdapter, s: Subscription) {
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
        ...amount('value', b.value),
        ...amount('maxPricePerUnit', b.maxPricePerUnit),
        ...amount('used', used),
        // Receipts held and not landed yet: none while the node makes no calls.
        ...amount('held', 0n),
        ...amount('left', left),
        ...amount('softCeiling', (b.value * SOFT_CEILING_PERCENT) / 100n),
      };
    })),
  };
}

/** The buyer's subscriptions in `epochs`, those it has. */
export async function subscriptionsView(buyer: Buyer, epochs: readonly number[]) {
  const subscriptions = [];
  for (const epoch of epochs) {
    const s = await buyer.chain.getSubscription(subscriptionIdOf(buyer.buyerWallet, epoch));
    if (s) subscriptions.push(await subscriptionView(buyer.chain, s));
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
    if (epoch === times.epoch && times.endsAt - times.now < END_MARGIN_SECONDS) continue;
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

/** The accounts the node's primary wallet owns, as `/api/pca` lists them, and those that granted the buyer wallet. */
export async function accountsView(buyer: Buyer) {
  const [owned, granted] = await Promise.all([
    buyer.chain.listNodePublishingConvictionAccounts(),
    buyer.chain.listBuyerAccounts(buyer.buyerWallet),
  ]);
  const ids = [...new Set([...owned.map((a) => a.accountId), ...granted])].sort((a, b) => (a < b ? -1 : 1));
  return { accounts: await Promise.all(ids.map((id) => accountView(buyer, id))) };
}

/** The buyer wallet, its balances and its allowance to `ServiceSubscriptionsWallet`, and the accounts it can use. */
export async function fundingView(buyer: Buyer) {
  const chain = buyer.chain;
  const [times, balances, allowance, { accounts }] = await Promise.all([
    chain.getEpochTimes(),
    chain.getWalletBalances(buyer.buyerWallet),
    chain.getServiceSubscriptionsWalletAllowance(buyer.buyerWallet),
    accountsView(buyer),
  ]);
  return {
    buyerWallet: {
      address: buyer.buyerWallet,
      ...amount('eth', balances.eth, 'Ether'),
      ...amount('trac', balances.trac),
      ...amount('walletContractAllowance', allowance),
    },
    accounts,
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
