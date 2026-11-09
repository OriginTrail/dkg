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
 *   plan's services it lacks. It funds or tops up the epoch under way only
 *   while enough of it is left (`renewsEpochUnderWay`): a subscription costs
 *   its full value however little of its epoch is left. A crash or a failed
 *   send heals at the next tick, since a buyer has one subscription per epoch.
 *   A renewal that fails raises an alert, once per epoch and refusal code.
 * - **Top-ups once per key.** A top-up sent with a key (`topUpOnce`) is sent
 *   at most once for that key: a repeat gets the first answer. One whose
 *   answer was lost, by an error after its transaction may have gone or a
 *   restart, is never sent again: a repeat reads the subscription, and answers
 *   that it went through once its budgets show it, or that its outcome is
 *   still unknown (`TopUpOutcomeUnknown`). One refused before it went (its
 *   checks, or the contract in simulation) leaves the key free for a repeat.
 *   The keys of a subscription are kept until its epoch ends, when a top-up is
 *   refused anyway.
 *
 * Every funding is bounded by the plan, which names each epoch's budgets and
 * the last epoch to fund; by the grant's limit and expiry for an account; and
 * by the buyer wallet's TRAC for a wallet. The wallet's allowance to
 * `ServiceSubscriptionsWallet`, when short, is raised to what the plan needs
 * through its last epoch.
 */
import { join } from 'node:path';
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
import { Journal } from './journal.js';
import { budgetsOf, planDigestOf, serviceToWire, valueOf, type FundingSource, type PlannedService, type StandingPlan } from './plan.js';
import type { BuyerStore } from './store.js';

/**
 * The share of an epoch, and the least time, that must be left of the epoch under way for the renewal job to fund
 * it or add to it. A subscription costs its full value however little of its epoch is left, and calls stop a few
 * minutes before the end (the sellers' 180 s, and the gateway's margin before that); closer to the end the job
 * waits for the next epoch, which it prefunds `prefundLeadSeconds` ahead.
 */
export const RENEWAL_MIN_SHARE = 0.25;
export const RENEWAL_MIN_SECONDS = 900;

/** Whether the renewal job funds, or adds to, the epoch under way at `times`. */
export function renewsEpochUnderWay(times: EpochTimes): boolean {
  const left = times.endsAt - times.now;
  return left >= Math.max(RENEWAL_MIN_SECONDS, (times.endsAt - times.startsAt) * RENEWAL_MIN_SHARE);
}

/** What a top-up sent with a key answers: its transaction, or none when the chain showed it went through but not by which. */
export interface KeyedTopUp {
  txHash: string | null;
  blockNumber: number | null;
}

/** The record of a top-up's key: sent (with the budgets before it), answered, or refused before it went. */
type TopUpRecord =
  | { type: 'sent'; key: string; request: string; subscriptionId: string; epoch: number; before: Record<string, string> }
  | { type: 'done'; key: string; txHash: string | null; blockNumber: number | null }
  | { type: 'refused'; key: string };

/** What the node knows of a key: the request it names, its epoch and budgets before it, and its answer once known. */
type TopUpKey = { request: string; subscriptionId: string; epoch: number; before: Record<string, string>; done?: KeyedTopUp };

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
  /** The keys of top-ups sent with one, in `top-ups.jsonl` beside the plan. */
  private readonly topUpLog: Journal<TopUpRecord>;
  private topUpKeys: Promise<Map<string, TopUpKey>> | undefined;

  constructor(private readonly deps: BuyerDeps) {
    this.chain = deps.chain;
    this.store = deps.store;
    this.config = deps.config;
    this.nodeWallets = (deps.nodeWallets ?? [deps.config.buyerWallet]).map((w) => ethers.getAddress(w));
    this.topUpLog = new Journal(join(deps.store.dir, 'top-ups.jsonl'));
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
    return this.exclusive(() => this.sendTopUp(subscriptionId, services));
  }

  /**
   * A top-up sent at most once for `key` (the module comment's "Top-ups once per key"). A key that names another
   * request is refused with `IdempotencyKeyReused`.
   */
  async topUpOnce(subscriptionId: string, services: PlannedService[], key: string): Promise<KeyedTopUp> {
    const id = subscriptionId.toLowerCase();
    const request = JSON.stringify({ subscriptionId: id, services: [...services].sort(byServiceId).map(serviceToWire) });
    return this.exclusive(async () => {
      const keys = await this.topUpKeysNow();
      const kept = keys.get(key);
      if (kept && kept.request !== request) throw new MarketplaceRefusal('IdempotencyKeyReused', [key]);
      if (kept?.done) return kept.done;
      if (kept) {
        // Sent before, and its answer lost: never sent again. The budgets say whether it went through.
        if (!(await this.showsTopUp(id, kept.before, services))) throw new MarketplaceRefusal('TopUpOutcomeUnknown', [key]);
        const done: KeyedTopUp = { txHash: null, blockNumber: null };
        await this.recordTopUp(keys, { type: 'done', key, ...done });
        return done;
      }
      let sent: SubscriptionTopUp;
      try {
        sent = await this.sendTopUp(id, services, (epoch, stored) => this.recordTopUp(keys, {
          type: 'sent', key, request, subscriptionId: id, epoch,
          before: Object.fromEntries(stored.map((b) => [b.serviceId.toLowerCase(), b.value.toString()])),
        }));
      } catch (err) {
        // A revert (in simulation, or mined) added nothing: the key is free again. Any other error leaves it sent.
        if (keys.has(key) && enrichEvmError(err)) await this.recordTopUp(keys, { type: 'refused', key });
        throw err;
      }
      const done: KeyedTopUp = { txHash: sent.hash, blockNumber: sent.blockNumber };
      await this.recordTopUp(keys, { type: 'done', key, ...done });
      return done;
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
      if (epoch > plan.renewUntilEpoch || (epoch === times.epoch && !renewsEpochUnderWay(times))) continue;
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

  /** A top-up's checks, then its send; `beforeSend` runs once nothing but the send is left. */
  private async sendTopUp(
    subscriptionId: string,
    services: PlannedService[],
    beforeSend?: (epoch: number, stored: readonly ServiceBudget[]) => Promise<void>,
  ): Promise<SubscriptionTopUp> {
    const { subscription, stored, additions, check } = await this.topUpCheck(subscriptionId, services);
    if (check.refusal) throw new MarketplaceRefusal(check.refusal.code, check.refusal.args);
    const planDigest = planDigestOf(subscription.epoch, this.buyerWallet, merged(stored, additions));
    const from = { from: this.buyerWallet };
    if (check.source.kind === 'wallet') await this.ensureAllowance(check.value, subscription.epoch);
    await beforeSend?.(subscription.epoch, stored);
    return check.source.kind === 'wallet'
      ? this.chain.topUpFromWallet(subscriptionId, additions, planDigest, from)
      : this.chain.topUpFromAccount(subscriptionId, additions, planDigest, from);
  }

  /** Whether the subscription's budgets show `services` added to what they held `before`. */
  private async showsTopUp(subscriptionId: string, before: Record<string, string>, services: readonly PlannedService[]): Promise<boolean> {
    const now = new Map((await this.chain.getBudgets(subscriptionId)).map((b) => [b.serviceId.toLowerCase(), b.value]));
    return services.every((s) => {
      const id = s.serviceId.toLowerCase();
      return (now.get(id) ?? 0n) >= BigInt(before[id] ?? '0') + s.value;
    });
  }

  /**
   * The top-up keys, read once. Those of a subscription whose epoch has ended are dropped, the journal rewritten
   * without them: a top-up of it is refused whatever its key.
   */
  private topUpKeysNow(): Promise<Map<string, TopUpKey>> {
    if (!this.topUpKeys) {
      const loading = (async () => {
        const keys = new Map<string, TopUpKey>();
        for (const r of await this.topUpLog.read()) applyTopUp(keys, r);
        const { epoch } = await this.chain.getEpochTimes();
        const live = new Map([...keys].filter(([, k]) => k.epoch >= epoch));
        if (live.size < keys.size) {
          await this.topUpLog.replace([...live].flatMap(([key, k]): TopUpRecord[] => [
            { type: 'sent', key, request: k.request, subscriptionId: k.subscriptionId, epoch: k.epoch, before: k.before },
            ...(k.done ? [{ type: 'done' as const, key, ...k.done }] : []),
          ]));
        }
        return live;
      })();
      loading.catch(() => {
        if (this.topUpKeys === loading) this.topUpKeys = undefined;
      });
      this.topUpKeys = loading;
    }
    return this.topUpKeys;
  }

  /** A key's record: on disk, then in `keys`. */
  private async recordTopUp(keys: Map<string, TopUpKey>, r: TopUpRecord): Promise<void> {
    await this.topUpLog.append(r);
    applyTopUp(keys, r);
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

const byServiceId = (a: { serviceId: string }, b: { serviceId: string }) => (BigInt(a.serviceId) < BigInt(b.serviceId) ? -1 : 1);

/** A top-up key's record folded into the keys: sent, answered, or refused before it went (the key free again). */
function applyTopUp(keys: Map<string, TopUpKey>, r: TopUpRecord): void {
  if (r.type === 'sent') keys.set(r.key, { request: r.request, subscriptionId: r.subscriptionId, epoch: r.epoch, before: r.before });
  else if (r.type === 'refused') keys.delete(r.key);
  else {
    const kept = keys.get(r.key);
    if (kept) kept.done = { txHash: r.txHash, blockNumber: r.blockNumber };
  }
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
