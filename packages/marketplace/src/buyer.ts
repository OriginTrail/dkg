// SPDX-License-Identifier: Apache-2.0

/**
 * The buyer (OT-RFC-27): it funds subscriptions from the buyer wallet, out of
 * that wallet's TRAC or a Conviction Account that granted it, and keeps the
 * standing plan funded.
 *
 * - **Checks before sending.** A funding or top-up is checked first against
 *   what the chain says now: the pool is live, the epoch is the current one or
 *   the next, and for a wallet, its TRAC covers the value. For an account, the
 *   checks of the contracts, in their order: the account can pay for services
 *   (not scheduled in full, not expired, no treasury wired), service spending
 *   is on, the grant to the buyer wallet is live and lasts past the
 *   subscription's start, the cost fits the grant's limit, and it fits the
 *   billing window's allowance. A refusal is a `MarketplaceRefusal` named after
 *   the contract error it stands for. The send then simulates the transaction
 *   before signing it, so a refusal the checks missed is still never sent.
 * - **Session keys.** Each subscription gets a fresh session key, stored
 *   encrypted before its funding is sent.
 * - **The job.** At every tick the buyer decides from the chain alone: it funds
 *   the current epoch when it has no subscription, funds the next one within
 *   `prefundLeadSeconds` of the boundary, and tops up a subscription with the
 *   plan's services it lacks. A crash or a failed send heals at the next tick,
 *   since a buyer has one subscription per epoch. A renewal that fails raises
 *   an alert, once per epoch and refusal code.
 *
 * Every funding is bounded by the plan, which names each epoch's budgets and
 * the last epoch to fund; by the grant's limit and expiry for an account; and
 * by the buyer wallet's TRAC for a wallet. The wallet's allowance to
 * `ServiceSubscriptionsWallet`, when short, is raised to what the plan needs
 * through its last epoch.
 */
import { ethers } from 'ethers';
import {
  enrichEvmError,
  subscriptionIdOf,
  type EpochTimes,
  type MarketplaceChainAdapter,
  type ServiceBudget,
  type Subscription,
  type SubscriptionFunding,
  type SubscriptionTopUp,
  type V10PublishingConvictionAccountInfo,
} from '@origintrail-official/dkg-chain';
import type { ResolvedMarketplaceConfig } from './config.js';
import { budgetsOf, planDigestOf, valueOf, type FundingSource, type PlannedService, type StandingPlan } from './plan.js';
import type { BuyerStore } from './store.js';

/** No funding is sent this close to an epoch's end: it could land in the next one. */
export const END_MARGIN_SECONDS = 30;

/** A refusal the buyer's checks found, named after the contract error it stands for. */
export class MarketplaceRefusal extends Error {
  constructor(readonly code: string, readonly args: readonly string[] = []) {
    super(`${code}(${args.join(', ')})`);
    this.name = 'MarketplaceRefusal';
  }
}

/** The code and arguments of a refusal or a contract revert; `null` for any other error. */
export function refusalOf(err: unknown): { code: string; args: string[] } | null {
  if (err instanceof MarketplaceRefusal) return { code: err.code, args: [...err.args] };
  const name = enrichEvmError(err);
  if (!name) return null;
  const args = (err as { revert?: { args?: ArrayLike<unknown> } }).revert?.args;
  return { code: name, args: args ? Array.from(args, String) : [] };
}

export interface FundingRequest {
  epoch: number;
  source: FundingSource;
  services: PlannedService[];
}

export interface FundingCheck {
  epoch: number;
  source: FundingSource;
  value: bigint;
  cost: bigint;
  discountBps: number;
  refusal?: { code: string; args: string[] };
}

export interface BuyerAlert {
  epoch: number;
  code: string;
  message: string;
}

export interface BuyerDeps {
  chain: MarketplaceChainAdapter;
  store: BuyerStore;
  config: ResolvedMarketplaceConfig;
  /** The node's operational wallets, which it can send from; by default the buyer wallet alone. */
  nodeWallets?: readonly string[];
  /** Told of each renewal that fails, once per epoch and refusal code. */
  onAlert?: (alert: BuyerAlert) => void;
  log?: (message: string) => void;
}

export class Buyer {
  readonly chain: MarketplaceChainAdapter;
  readonly store: BuyerStore;
  readonly config: ResolvedMarketplaceConfig;
  readonly nodeWallets: readonly string[];
  /** The last renewal outcome per epoch: `null` for success. */
  readonly renewals = new Map<number, { at: number; refusal: { code: string; args: string[] } | null }>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;

  constructor(private readonly deps: BuyerDeps) {
    this.chain = deps.chain;
    this.store = deps.store;
    this.config = deps.config;
    this.nodeWallets = (deps.nodeWallets ?? [deps.config.buyerWallet]).map((w) => ethers.getAddress(w));
  }

  get buyerWallet(): string {
    return this.config.buyerWallet;
  }

  // ------------------------------------------------------------- fundings

  /** A dry run: what a funding would cost, and the refusal it would meet, without sending anything. */
  async dryRun(request: FundingRequest): Promise<FundingCheck> {
    return this.check(request, await this.chain.getEpochTimes());
  }

  async fund(request: FundingRequest): Promise<SubscriptionFunding> {
    return this.exclusive(async () => {
      const check = await this.check(request, await this.chain.getEpochTimes());
      if (check.refusal) throw new MarketplaceRefusal(check.refusal.code, check.refusal.args);
      const subscriptionId = subscriptionIdOf(this.buyerWallet, request.epoch);
      const sessionKey = (await this.store.sessionKeyFor(subscriptionId)).address;
      const budgets = budgetsOf(request.services);
      const planDigest = planDigestOf(request.epoch, this.buyerWallet, budgets);
      const from = { from: this.buyerWallet };
      let funded: SubscriptionFunding;
      if (request.source.kind === 'wallet') {
        await this.ensureAllowance(check.value, request.epoch);
        funded = await this.chain.fundFromWallet({ epoch: request.epoch, sessionKey, planDigest, budgets }, from);
      } else {
        funded = await this.chain.fundFromAccount({ accountId: request.source.accountId, epoch: request.epoch, sessionKey, planDigest, budgets }, from);
      }
      // Where reading what landed for it starts; without it, reading starts at the settlement's deployment.
      await this.store.recordFunding(funded.subscriptionId, funded.blockNumber).catch((err: unknown) => {
        this.deps.log?.(`[marketplace] the funding block of ${funded.subscriptionId} was not kept: ${err instanceof Error ? err.message : String(err)}`);
      });
      return funded;
    });
  }

  /**
   * A dry run of a top-up: what adding `services` would cost, and the refusal
   * it would meet, without sending anything. A subscription that is not found
   * or not the buyer's is refused, as the top-up is.
   */
  async dryRunTopUp(subscriptionId: string, services: PlannedService[]): Promise<FundingCheck> {
    return (await this.topUpCheck(subscriptionId, services)).check;
  }

  /**
   * Add `services` to the buyer's subscription: value to the budgets it has,
   * and the services it lacks as new budgets. A service it has keeps its class
   * and price cap.
   */
  async topUp(subscriptionId: string, services: PlannedService[]): Promise<SubscriptionTopUp> {
    return this.exclusive(async () => {
      const { subscription, stored, additions, check } = await this.topUpCheck(subscriptionId, services);
      if (check.refusal) throw new MarketplaceRefusal(check.refusal.code, check.refusal.args);
      const planDigest = planDigestOf(subscription.epoch, this.buyerWallet, merged(stored, additions));
      const from = { from: this.buyerWallet };
      if (check.source.kind === 'wallet') {
        await this.ensureAllowance(check.value, subscription.epoch);
        return this.chain.topUpFromWallet(subscriptionId, additions, planDigest, from);
      }
      return this.chain.topUpFromAccount(subscriptionId, additions, planDigest, from);
    });
  }

  // ------------------------------------------------------------------ job

  /** Fund, prefund and top up as the plan says and the chain shows. */
  async tick(): Promise<void> {
    const plan = await this.store.readPlan();
    if (!plan?.renew || plan.renewUntilEpoch === undefined) return;
    const times = await this.chain.getEpochTimes();
    const left = times.endsAt - times.now;
    const epochs = left <= this.config.prefundLeadSeconds ? [times.epoch, times.epoch + 1] : [times.epoch];
    for (const epoch of epochs) {
      if (epoch > plan.renewUntilEpoch || (epoch === times.epoch && left < END_MARGIN_SECONDS)) continue;
      try {
        await this.renew(plan, epoch);
        this.renewals.set(epoch, { at: times.now, refusal: null });
      } catch (err) {
        this.renewalFailed(epoch, times.now, err);
      }
    }
  }

  start(): void {
    if (this.timer) return;
    const run = () => {
      if (this.ticking) return;
      this.ticking = this.tick()
        .catch((err: unknown) => this.deps.log?.(`[marketplace] buyer tick failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { this.ticking = undefined; });
    };
    run();
    this.timer = setInterval(run, this.config.tickSeconds * 1_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
  }

  // ------------------------------------------------------------- internal

  private async renew(plan: StandingPlan, epoch: number): Promise<void> {
    const subscriptionId = subscriptionIdOf(this.buyerWallet, epoch);
    if (!(await this.chain.subscriptionExists(subscriptionId))) {
      const funded = await this.fund({ epoch, source: plan.source, services: plan.services });
      this.deps.log?.(`[marketplace] funded epoch ${epoch}: subscription ${funded.subscriptionId}, cost ${ethers.formatEther(funded.cost)} TRAC`);
      return;
    }
    // An upgrade: the plan's services that the subscription lacks.
    const stored = await this.chain.getBudgets(subscriptionId);
    const missing = plan.services.filter((s) => !stored.some((b) => b.serviceId.toLowerCase() === s.serviceId));
    if (missing.length === 0) return;
    const topUp = await this.topUp(subscriptionId, missing);
    this.deps.log?.(`[marketplace] added ${missing.length} service(s) to epoch ${epoch}, cost ${ethers.formatEther(topUp.cost)} TRAC`);
  }

  private renewalFailed(epoch: number, at: number, err: unknown): void {
    const refusal = refusalOf(err) ?? { code: 'Error', args: [err instanceof Error ? err.message : String(err)] };
    const before = this.renewals.get(epoch)?.refusal;
    this.renewals.set(epoch, { at, refusal });
    // By code alone: the arguments of one reason move (a balance, an RPC error's message).
    if (before?.code === refusal.code) return;
    const message = `the plan's subscription for epoch ${epoch} was not funded: ${refusal.code}(${refusal.args.join(', ')})`;
    this.deps.log?.(`[marketplace] ${message}`);
    this.deps.onAlert?.({ epoch, code: refusal.code, message });
  }

  /** Raise the wallet's allowance to `ServiceSubscriptionsWallet` when it cannot pay `value`. */
  private async ensureAllowance(value: bigint, epoch: number): Promise<void> {
    const allowance = await this.chain.getServiceSubscriptionsWalletAllowance(this.buyerWallet);
    if (allowance >= value) return;
    const plan = await this.store.readPlan();
    const planned = plan?.renew && plan.source.kind === 'wallet' && plan.renewUntilEpoch !== undefined && plan.renewUntilEpoch >= epoch
      ? valueOf(plan.services) * BigInt(plan.renewUntilEpoch - epoch + 1)
      : 0n;
    await this.chain.approveServiceSubscriptionsWallet(planned > value ? planned : value, { from: this.buyerWallet });
  }

  /** A top-up's subscription, the budgets it has, what `services` add to them, and the checks of the addition. */
  private async topUpCheck(subscriptionId: string, services: PlannedService[]) {
    const times = await this.chain.getEpochTimes();
    const subscription = await this.chain.getSubscription(subscriptionId);
    if (!subscription) throw new MarketplaceRefusal('SubscriptionNotFound', [subscriptionId]);
    if (ethers.getAddress(subscription.buyer) !== this.buyerWallet) {
      throw new MarketplaceRefusal('NotSubscriptionBuyer', [subscriptionId, this.buyerWallet]);
    }
    const stored = await this.chain.getBudgets(subscriptionId);
    const additions = budgetsOf(services).map((b) => {
      const same = stored.find((s) => s.serviceId.toLowerCase() === b.serviceId.toLowerCase());
      return same ? { ...b, serviceClass: same.serviceClass, maxPricePerUnit: same.maxPricePerUnit } : b;
    });
    const source: FundingSource = subscription.accountId === 0n ? { kind: 'wallet' } : { kind: 'account', accountId: subscription.accountId };
    const newBudgets = additions.filter((b) => !stored.some((s) => s.serviceId.toLowerCase() === b.serviceId.toLowerCase())).length;
    const check = await this.check({ epoch: subscription.epoch, source, services: additions }, times, { subscription, budgets: stored.length + newBudgets });
    return { subscription, stored, additions, check };
  }

  /** The checks of the module comment, against the chain as it is now. */
  private async check(
    request: FundingRequest,
    times: EpochTimes,
    topUp?: { subscription: Subscription; budgets: number },
  ): Promise<FundingCheck> {
    const value = valueOf(request.services);
    const result: FundingCheck = { epoch: request.epoch, source: request.source, value, cost: value, discountBps: 0 };
    const refuse = (code: string, ...args: unknown[]): FundingCheck => ({ ...result, refusal: { code, args: args.map(String) } });
    const state = await this.chain.batchState();
    if (state.paused) return refuse('QueryInferencePaused');
    if (state.activationEpoch === 0 || times.epoch < state.activationEpoch) {
      return refuse('QueryInferenceNotActive', state.activationEpoch, times.epoch);
    }
    const subscriptionId = subscriptionIdOf(this.buyerWallet, request.epoch);
    if (topUp) {
      if (times.now >= topUp.subscription.endsAt) return refuse('SubscriptionEnded', subscriptionId, topUp.subscription.endsAt);
    } else if (request.epoch !== times.epoch && request.epoch !== times.epoch + 1) {
      return refuse('InvalidFundingRequest', 'epoch');
    } else if (await this.chain.subscriptionExists(subscriptionId)) {
      return refuse('SubscriptionAlreadyFunded', subscriptionId);
    }
    if ((topUp?.budgets ?? request.services.length) > (await this.chain.maxBudgetsPerSubscription())) {
      return refuse('InvalidFundingRequest', 'budgetCount');
    }
    const startsAt = topUp?.subscription.startsAt ?? (request.epoch === times.epoch ? times.now : times.endsAt);

    if (request.source.kind === 'wallet') {
      const { trac } = await this.chain.getWalletBalances(this.buyerWallet);
      return trac < value ? refuse('ERC20InsufficientBalance', this.buyerWallet, trac, value) : result;
    }

    const accountId = request.source.accountId;
    const account = await this.chain.getPublishingConvictionAccountInfo(accountId);
    if (!account) return refuse('ERC721NonexistentToken', accountId);
    ({ cost: result.cost, discountBps: result.discountBps } = await this.chain.previewCost(accountId, value));
    const unable = await accountRefusal(this.chain, accountId, account);
    if (unable) return { ...result, refusal: unable };
    const grant = await this.chain.getGrant(accountId, this.buyerWallet);
    if (!grant) return refuse('NotABuyer', accountId, this.buyerWallet);
    if (ethers.getAddress(grant.owner) !== ethers.getAddress(account.owner)) return refuse('GrantedByFormerOwner', accountId, this.buyerWallet);
    if (grant.revokedAt !== 0) return refuse('GrantRevoked', accountId, this.buyerWallet);
    if (times.now >= grant.expiresAt) return refuse('GrantExpired', accountId, this.buyerWallet);
    if (grant.expiresAt <= startsAt) return refuse('GrantEndsBeforeSubscription', accountId, this.buyerWallet, grant.expiresAt, startsAt);
    if (topUp) {
      // The grant the subscription was funded under decides which of its requests count.
      const end = await this.chain.grantEnd(accountId, this.buyerWallet, topUp.subscription.grantNonce);
      if (times.now >= end) return refuse('GrantExpired', accountId, this.buyerWallet);
      if (end <= startsAt) return refuse('GrantEndsBeforeSubscription', accountId, this.buyerWallet, end, startsAt);
    }
    const total = result.cost + (topUp?.subscription.cost ?? 0n);
    if (total > grant.maxCostPerEpoch) return refuse('LimitExceeded', 'maxCostPerEpoch', grant.maxCostPerEpoch, total);
    const window = await this.chain.currentWindowAllowance(accountId);
    if (window.expired) return refuse('AccountExpired', accountId, account.expiresAtEpoch);
    const available = window.baseRemaining + window.topUpBuffer;
    if (result.cost > available) return refuse('InsufficientAllowance', accountId, times.epoch, result.cost, available);
    return result;
  }

  /** Run `fn` after every funding or top-up before it, so two never race for one wallet or epoch. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * Why the account cannot pay for services, as the contracts refuse it, before
 * any grant is looked at: scheduled in full, a treasury wired, or service
 * spending off; `null` when none holds.
 */
export async function accountRefusal(
  chain: MarketplaceChainAdapter,
  accountId: bigint,
  account: V10PublishingConvictionAccountInfo,
): Promise<{ code: string; args: string[] } | null> {
  // As the contracts tell an account PublishingConviction 10.0.8 or 10.1.0 scheduled in full.
  if (account.lastSettledWindow >= (await chain.getConvictionAccountLockDurationEpochs(accountId))) {
    return { code: 'EmissionAlreadyScheduled', args: [String(accountId)] };
  }
  const treasury = await chain.getProtocolTreasury();
  if (treasury !== ethers.ZeroAddress) return { code: 'ServiceFundingPausedTreasuryWired', args: [treasury] };
  const spending = await chain.getServiceSpending(accountId);
  if (spending.enabledAt === 0 || spending.owner !== ethers.getAddress(account.owner)) {
    return { code: 'ServiceSpendingDisabled', args: [String(accountId)] };
  }
  return null;
}

/** The budgets after a top-up: each stored one with its addition, then the new ones. */
function merged(stored: readonly ServiceBudget[], additions: readonly ServiceBudget[]): ServiceBudget[] {
  const out = stored.map((s) => {
    const added = additions.find((a) => a.serviceId.toLowerCase() === s.serviceId.toLowerCase());
    return added ? { ...s, value: s.value + added.value } : { ...s };
  });
  for (const a of additions) {
    if (!stored.some((s) => s.serviceId.toLowerCase() === a.serviceId.toLowerCase())) out.push(a);
  }
  return out;
}
