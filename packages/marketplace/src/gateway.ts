// SPDX-License-Identifier: Apache-2.0

/**
 * The buyer's gateway (OT-RFC-27): an OpenAI-compatible chat completion,
 * paid for from this epoch's subscription and served by the router's seller.
 * A call goes through, in order:
 *   1. the caller: a live access key within its rate, checked before the
 *      body is read (`callerOf`), then the key's services;
 *   2. the epoch: a call is sent only while its request can live
 *      `MIN_REQUEST_SECONDS` before the sellers' stop time, checked again when
 *      its turn comes; from then to the next epoch's start, the answer is 503
 *      with `Retry-After`;
 *   3. this epoch's subscription, and the call's service budget in it;
 *   4. its budget's turn (gateway-turns.ts): calls on one budget run one at a
 *      time, a few wait, and the gateway takes a bounded number at once, from
 *      before the reads of steps 2 and 3; a call with no room is refused at
 *      once (429, or 503 for the gateway);
 *   5. a seller, from the router; a call with tools (`usesTools`) only one
 *      whose quote says it takes them, and 400 `tools_unsupported` before
 *      anything is signed when no seller that serves now does;
 *   6. the soft ceiling: what the budget used on chain, what this node's calls
 *      on it may still cost, and this call's most value stay under 95% of the
 *      budget;
 *   7. the key's own budget: the call reserves its most value of it, beside
 *      the key's other calls in flight;
 *   8. the request, signed by the subscription's session key: a nonce from a
 *      counter per subscription and seller, written before it is signed;
 *      `issuedAt` half a minute before the chain's time, for a seller whose
 *      head is a block or two behind, and never before `startsAt`; an expiry
 *      ten minutes on, or at the stop time if that is sooner; `maxUnits` the
 *      input's UTF-8 bytes, which a tokenizer never exceeds, with its tools'
 *      and tool calls' JSON, plus `max_tokens` and an allowance per message
 *      and per tool (seller-bounds.ts); `maxValueWei` those units at the quoted
 *      price. The call is on disk (buyer-ledger.ts) before it is sent;
 *   9. the seller's answer, and its receipt's checks: it answers this request,
 *      `units` within `maxUnits`, `valueWei` the units at the price, completed
 *      between the request's issue and its expiry, as settlement requires, the
 *      result is what it commits to, and an operational key of the seller's
 *      Core Node signed it. A receipt that fails takes the seller out of
 *      routing for the epoch, and the call fails;
 *  10. the receipt is kept, with the key's charge in the same record, before
 *      the answer goes back. The answer is OpenAI's: the text or the tool
 *      calls, the finish reason, and the usage, split into prompt and
 *      completion tokens when the seller said how and that adds up to the
 *      receipt's units, else the total alone.
 * A call whose client goes away before it is sent leaves its queue, or stops,
 * and is never signed, sent or charged. Once sent, a call counts whatever
 * comes back, since its seller may land a receipt for any request the session
 * key signed: one refused, unanswered, or answered with a receipt that fails a
 * check counts at its request's most value, against the budget until the chain
 * shows its nonce used, and against its key until the epoch is made final,
 * when the key is charged that value if the request landed. A seller that
 * refuses or leaves unanswered `MAX_UNSETTLED_PER_SELLER` calls in an epoch is
 * out of routing for the rest of it, so its calls hold no more. The activity
 * lists these calls too, at their most value, with why.
 *
 * Its job, every tick: the calls whose nonces the chain shows used have
 * landed, and leave the value the ceiling counts. A call of an ended epoch
 * that did not land leaves its key's reservation. An epoch before the last
 * ended one is made final: its reconciliation is kept, and its receipts and
 * nonce counters are dropped, what they cost folded into each key's total, in
 * the ledger's one compaction (buyer-ledger.ts).
 */
import { ethers } from 'ethers';
import {
  hashServiceRequest,
  signServiceRequest,
  subscriptionIdOf,
  type EpochTimes,
  type LandedGroup,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type QueryInferenceReceipt,
  type ServiceBudget,
  type ServiceRequest,
  type Subscription,
} from '@origintrail-official/dkg-chain';
import { NO_FX, type Fx } from './config.js';
import type { BuyerLedger } from './buyer-ledger.js';
import { exposureOf, isKept, type CallBook, type HeldReceipt } from './gateway-book.js';
import { CallerGone, Turns, TurnsFull, type TurnLimits } from './gateway-turns.js';
import type { AccessKey, AccessKeys } from './keys.js';
import { serviceIdOf } from './offers.js';
import { inputUnitsBound } from './seller-bounds.js';
import { reconcileSubscription, type ReconciledRow } from './reconcile.js';
import type { Route, Router } from './router.js';
import { receiptSignerOf, DEFAULT_STOP_SERVING_SECONDS } from './seller.js';
import type { BuyerStore } from './store.js';
import { amount } from './views.js';
import {
  PEER_LIMITS,
  WireError,
  decodeMessage,
  encodeMessage,
  inferenceBodyFromWire,
  receiptFromWire,
  receiptToWire,
  requestToWire,
  resultCommitmentOf,
  serveResponseFromWire,
  usesTools,
  type InferenceBody,
  type ReceiptWire,
  type ServeAnswerReceived,
  type ServeResponseReceived,
  type ServeUsage,
} from './wire.js';

/** Calls stop at this share of a budget's value. */
const SOFT_CEILING_PERCENT = 95n;
/** How long a request may wait for its seller. */
const REQUEST_LIFETIME_SECONDS = 600;
/**
 * The least time a request is sent with before it expires: as long as the gateway waits for its answer, and half a
 * minute for the chain's clock as each side reads it. A receipt completed after its request's expiry never lands,
 * so a call that cannot have this long before the sellers' stop time waits for the next epoch.
 */
export const MIN_REQUEST_SECONDS = Math.ceil(PEER_LIMITS.serveTimeoutMs / 1_000) + 30;
/** How long a caller refused for want of room is asked to wait. */
const BUSY_RETRY_AFTER_SECONDS = 5;
/** How far a request's `issuedAt` is before the chain's time as read: a seller whose head is behind takes it. */
export const ISSUED_BEFORE_SECONDS = 30;
/** The calls one seller may refuse or leave unanswered in an epoch before it is out of routing for the rest of it. */
export const MAX_UNSETTLED_PER_SELLER = 8;
const DEFAULT_MAX_TOKENS = 512;

export interface GatewayAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Who calls, once checked: a live access key. A node or agent token is not one. */
export interface GatewayCaller {
  key: AccessKey;
}

export interface CallOptions {
  /** Aborted when the call's client goes away. */
  signal?: AbortSignal;
}

export interface GatewayDeps {
  chain: MarketplaceChainAdapter;
  buyerWallet: string;
  /** Where the subscriptions' session keys are. */
  store: BuyerStore;
  router: Router;
  /** The access keys callers present; their ledger keeps the gateway's calls and nonce counters too. */
  keys: AccessKeys;
  /** Send a `serve` message to a seller and read the answer's bytes. */
  send(peerId: string, payload: Uint8Array, messageId: string): Promise<Uint8Array>;
  /** The model URN of a service in an epoch, from the offers, for listing models. */
  modelOf?(serviceId: string, epoch: number): Promise<string | undefined>;
  /** The sellers' stop time before an epoch's end. Default 180. */
  stopServingSeconds?: number;
  /** How many calls wait on a budget, and how many the gateway takes at once; the defaults otherwise. */
  turns?: TurnLimits;
  /** Milliseconds, for how long a call waited for its turn; `Date.now` by default. */
  clock?: () => number;
  /** The reference rate the catalog shows USD by; none by default. */
  fx?: Fx;
  log?: (message: string) => void;
}

export type { HeldReceipt, KeptReceipt } from './gateway-book.js';

/** How many calls `activity` answers. */
const ACTIVITY_LIMIT = 200;

/** A call through the gateway, as the activity lists it (`Call`). */
export interface CallView {
  callId: string;
  /** When the seller completed it, in chain seconds. */
  at: number;
  serviceId: string;
  seller: number;
  keyId: string;
  units: number;
  value: string;
  valueTrac: string;
  state: 'held' | 'landed' | 'missed';
  /**
   * Set on a call with no receipt the node relies on: its seller's refusal code, `unanswered`, `sent` (the node
   * stopped while it waited), or the check its receipt failed. Its `units` and `value` are then the most its request
   * allows, which it holds until it lands or its epoch ends.
   */
  problem?: string;
}

/** A call in its budget's turn: what the checks before it found. */
interface BudgetCall {
  caller: GatewayCaller;
  model: string;
  body: InferenceBody;
  serviceId: string;
  times: EpochTimes;
  /** When `times` was read, by `clock`. */
  readAt: number;
  stopAt: number;
  subscriptionId: string;
  subscription: Subscription;
  budget: ServiceBudget;
  budgetIndex: number;
  budgetKey: string;
  signal: AbortSignal | undefined;
}

const fail = (status: number, code: string, message: string, more: Record<string, unknown> = {}, headers?: Record<string, string>): GatewayAnswer =>
  ({ status, body: { error: { code, message, type: 'marketplace' }, ...more }, ...(headers ? { headers } : {}) });
/** The answer to a call too near the epoch's end, at the chain's time `now`. */
const epochEnding = (endsAt: number, now: number): GatewayAnswer =>
  fail(503, 'epoch_ending', 'the epoch is ending; calls resume when the next one starts', { nextEpochAt: endsAt },
    { 'Retry-After': String(Math.max(1, endsAt - now)) });
/** The answer to a call whose client went away before it was sent: nobody reads it. */
const gone = (): GatewayAnswer => fail(499, 'client_gone', 'the client went away before its call was sent');

export class Gateway {
  /** The nonce counters, the calls and the epochs made final: the keys' ledger. */
  private readonly ledger: BuyerLedger;
  private readonly turns: Turns;
  private readonly clock: () => number;
  /** The calls sent and not made final, and what each may still cost: the ledger's. */
  private readonly book: CallBook;
  /** subscription id => the groups landed for it, read up to `toBlock`. */
  private readonly scans = new Map<string, { toBlock: number; groups: LandedGroup[] }>();
  private readonly sessionKeys = new Map<string, ethers.Wallet>();
  private domain: MarketplaceDomain | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;

  constructor(private readonly deps: GatewayDeps) {
    this.ledger = deps.keys.ledger;
    this.book = this.ledger.calls;
    this.turns = new Turns(deps.turns);
    this.clock = deps.clock ?? Date.now;
  }

  /** The access keys callers present. */
  get keys(): AccessKeys {
    return this.deps.keys;
  }

  get router(): Router {
    return this.deps.router;
  }

  get chain(): MarketplaceChainAdapter {
    return this.deps.chain;
  }

  get buyerWallet(): string {
    return this.deps.buyerWallet;
  }

  get fx(): Fx {
    return this.deps.fx ?? NO_FX;
  }

  /** What this node's calls on a budget not seen landed may still cost. */
  heldValue(subscriptionId: string, budgetIndex: number): bigint {
    return this.book.heldValue(`${subscriptionId.toLowerCase()}:${budgetIndex}`);
  }

  /**
   * An epoch's calls (`Call`), newest first, at most `ACTIVITY_LIMIT`, or one
   * access key's: held while the chain shows its nonce unused, landed once it
   * shows it used, and missed once the epoch ended without it. A call with
   * no receipt the node relies on is listed at its most value, from when it
   * was issued, with its `problem`. An epoch made final keeps its
   * reconciliation, not its calls.
   */
  async activity(epoch?: number, keyId?: string): Promise<{ calls: CallView[] }> {
    const times = await this.deps.chain.getEpochTimes();
    const asked = epoch ?? times.epoch;
    const kept = this.book.callsOf(asked).filter((r) => keyId === undefined || r.keyId === keyId);
    const used = await this.usedOf(kept);
    const calls: CallView[] = kept.map((r) => {
      const state = used.has(r.callId) ? 'landed' : asked < times.epoch ? 'missed' : 'held';
      const of = { callId: r.callId, serviceId: r.request.serviceId, seller: Number(r.seller), keyId: r.keyId, state } as const;
      if (isKept(r)) return { ...of, at: r.receipt.completedAt, units: Number(r.receipt.units), ...amount('value', BigInt(r.receipt.valueWei)) };
      return {
        ...of, at: r.request.issuedAt, units: Number(r.request.maxUnits), ...amount('value', BigInt(r.request.maxValueWei)),
        problem: r.problem ?? r.state,
      };
    });
    return { calls: calls.sort((a, b) => b.at - a.at).slice(0, ACTIVITY_LIMIT) };
  }

  /** Read the calls kept, the epochs made final and the nonce counters (the ledger). Call once before serving. */
  async load(): Promise<void> {
    await this.ledger.load();
    for (const r of this.ledger.openCalls()) this.unsettled(r);
  }

  /** The job: a tick now, then every `tickSeconds`. */
  start(tickSeconds: number): void {
    if (this.timer) return;
    const run = () => {
      if (this.ticking) return;
      this.ticking = this.tick()
        .catch((err: unknown) => this.deps.log?.(`[marketplace] gateway tick failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { this.ticking = undefined; });
    };
    run();
    this.timer = setInterval(run, tickSeconds * 1_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
  }

  /**
   * The calls that landed leave the value the ceiling counts; a call of an ended epoch that did not land leaves its
   * key's reservation; epochs before the last ended one are made final.
   */
  async tick(): Promise<void> {
    const { epoch } = await this.deps.chain.getEpochTimes();
    const open = this.book.unlandedOf(epoch);
    const used = await this.usedOf(open);
    for (const r of open) if (used.has(r.callId)) this.book.landed(r);
    // An ended epoch takes no more receipts: what did not land by then never will.
    const ended = this.book.keyHeldBefore(epoch);
    const landed = await this.usedOf(ended);
    for (const r of ended) if (!landed.has(r.callId)) this.book.release(r);
    for (const e of this.ledger.epochsBefore(epoch - 1)) await this.finalize(e);
  }

  /**
   * The receipts this node holds for an epoch's subscription against those
   * landed and counted, per seller and budget (the node API's `GET /reconciliation`):
   * final once the epoch has ended.
   */
  async reconciliation(epoch?: number): Promise<{ epoch: number; final: boolean; rows: ReconciledRow[] }> {
    const times = await this.deps.chain.getEpochTimes();
    const asked = epoch ?? times.epoch;
    const kept = this.ledger.final(asked);
    if (kept) return { epoch: asked, final: true, rows: kept };
    return { epoch: asked, final: asked < times.epoch, rows: await this.rowsOf(asked) };
  }

  /** The services this epoch's subscription funds, as OpenAI models. */
  async models(): Promise<GatewayAnswer> {
    const { epoch } = await this.deps.chain.getEpochTimes();
    const id = subscriptionIdOf(this.deps.buyerWallet, epoch);
    const budgets = (await this.deps.chain.subscriptionExists(id)) ? await this.deps.chain.getBudgets(id) : [];
    const data = [];
    for (const b of budgets) {
      const serviceId = b.serviceId.toLowerCase();
      data.push({ id: (await this.deps.modelOf?.(serviceId, epoch)) ?? serviceId, object: 'model', owned_by: 'dkg-marketplace', service_id: serviceId });
    }
    return { status: 200, body: { object: 'list', data } };
  }

  /**
   * The caller of a gateway route, before its body is read: a live key of
   * this node within its rate. Anything else, a node or agent token included,
   * is refused with 401 (or 429 for the rate), with no other work done.
   * `token` is the bearer credential as presented.
   */
  async callerOf(token: string | undefined): Promise<{ caller: GatewayCaller } | { answer: GatewayAnswer }> {
    const check = await this.deps.keys.check(token, Math.floor(Date.now() / 1000));
    if (!check.ok) return { answer: fail(check.status, check.code, 'an access key of this node is needed') };
    return { caller: { key: check.key } };
  }

  async chatCompletion(caller: GatewayCaller, raw: unknown, options: CallOptions = {}): Promise<GatewayAnswer> {
    const call = raw as {
      model?: unknown; messages?: unknown; max_tokens?: unknown; stream?: unknown; tools?: unknown; tool_choice?: unknown; parallel_tool_calls?: unknown;
    } | null;
    if (typeof call?.model !== 'string' || call.model === '') return fail(400, 'bad_request', 'model is required');
    if (call.stream === true) return fail(400, 'bad_request', 'streamed answers are not supported');
    let body: InferenceBody;
    try {
      body = inferenceBodyFromWire({
        messages: call.messages, max_tokens: call.max_tokens ?? DEFAULT_MAX_TOKENS,
        tools: call.tools, tool_choice: call.tool_choice, parallel_tool_calls: call.parallel_tool_calls,
      });
    } catch (err) {
      return fail(400, 'bad_request', err instanceof WireError ? err.message : 'bad request');
    }
    const serviceId = ethers.isHexString(call.model, 32) ? call.model.toLowerCase() : serviceIdOf(call.model);
    if (caller.key.services && !caller.key.services.includes(serviceId)) {
      return fail(401, 'service_not_allowed', 'the access key may not call this service');
    }

    const model = call.model;
    try {
      // A place in the gateway before the chain is read: a slow chain holds no more calls than the gateway takes.
      return await this.turns.admit(() => this.callOnChain(caller, model, body, serviceId, options.signal));
    } catch (err) {
      if (err instanceof CallerGone) return gone();
      if (!(err instanceof TurnsFull)) throw err;
      const retry = { 'Retry-After': String(BUSY_RETRY_AFTER_SECONDS) };
      return err.scope === 'budget'
        ? fail(429, 'budget_busy', 'too many calls wait on this service now; try again shortly', { serviceId }, retry)
        : fail(503, 'gateway_busy', 'the gateway has as many calls as it takes at once; try again shortly', {}, retry);
    }
  }

  /** A call with its place in the gateway: the epoch, its subscription and budget, then its budget's turn. */
  private async callOnChain(caller: GatewayCaller, model: string, body: InferenceBody, serviceId: string, signal: AbortSignal | undefined): Promise<GatewayAnswer> {
    const chain = this.deps.chain;
    const times = await chain.getEpochTimes();
    const readAt = this.clock();
    const stopAt = times.endsAt - (this.deps.stopServingSeconds ?? DEFAULT_STOP_SERVING_SECONDS);
    if (times.now > stopAt - MIN_REQUEST_SECONDS) return epochEnding(times.endsAt, times.now);
    const subscriptionId = subscriptionIdOf(this.deps.buyerWallet, times.epoch);
    const subscription = await chain.getSubscription(subscriptionId);
    const budgets = subscription ? await chain.getBudgets(subscriptionId) : [];
    const budgetIndex = budgets.findIndex((b) => b.serviceId.toLowerCase() === serviceId);
    if (!subscription || budgetIndex < 0) {
      return fail(402, 'no_subscription', 'no subscription funds this service in this epoch', { serviceId, fork: { fund: true } });
    }
    const budgetKey = `${subscriptionId}:${budgetIndex}`;
    const turn: BudgetCall = {
      caller, model, body, serviceId, times, readAt, stopAt, subscriptionId, subscription,
      budget: budgets[budgetIndex]!, budgetIndex, budgetKey, signal,
    };
    return this.turns.turn(budgetKey, () => this.callInTurn(turn), signal);
  }

  /** A call in its budget's turn, from the seller and the ceiling to the request, signed and sent. */
  private async callInTurn(c: BudgetCall): Promise<GatewayAnswer> {
    // Its client left while it waited: nothing is done for it.
    if (c.signal?.aborted) return gone();
    const chain = this.deps.chain;
    const picked = await this.deps.router.pickFor(c.serviceId, c.times.epoch, c.budget.maxPricePerUnit, { tools: usesTools(c.body) });
    if (!picked.route) {
      return picked.reason === 'tools_unsupported'
        ? fail(400, 'tools_unsupported', 'no seller of this service takes tool calls now', { serviceId: c.serviceId })
        : fail(503, 'no_seller', 'no seller serves this service now', { serviceId: c.serviceId });
    }
    const route = picked.route;
    const maxUnits = unitsBound(c.body);
    const maxValueWei = maxUnits * route.pricePerUnit;
    const used = c.budget.value - await chain.budgetLeft(c.subscriptionId, c.budgetIndex);
    const held = this.book.heldValue(c.budgetKey);
    const ceiling = (c.budget.value * SOFT_CEILING_PERCENT) / 100n;
    if (used + held + maxValueWei > ceiling) {
      const left = ceiling > used + held ? ceiling - used - held : 0n;
      return fail(402, 'soft_ceiling', 'the budget is at its soft ceiling', {
        serviceId: c.serviceId, ...amount('left', left), fork: { topUp: true, nextEpochAt: c.times.endsAt },
      });
    }
    const keyId = c.caller.key.keyId;
    if (!(await this.deps.keys.reserve(keyId, maxValueWei))) {
      return fail(402, 'key_budget', "the call could cost more than the access key's budget has left");
    }
    // The reservation goes unless the call is sent: a sent call settles it, or keeps it while its cost is not known.
    let sent = false;
    try {
      const sessionKey = await this.sessionKeyOf(c.subscriptionId, c.subscription.sessionKey);
      if (!sessionKey) return fail(500, 'session_key_missing', "this node does not hold the subscription's session key");
      const domain = await this.domainOf();
      if (c.signal?.aborted) return gone();
      // The chain's time now, by how long the call has waited since it was read: a turn that came too near the stop
      // time is not sent. `issuedAt` is before the time read, which the chain and the seller have passed.
      const now = c.times.now + Math.floor((this.clock() - c.readAt) / 1_000);
      if (now > c.stopAt - MIN_REQUEST_SECONDS) return epochEnding(c.times.endsAt, now);
      const request: ServiceRequest = {
        subscriptionId: c.subscriptionId, serviceId: c.serviceId, seller: route.seller,
        nonce: await this.ledger.takeNonce(c.times.epoch, c.subscriptionId, route.seller),
        pricePerUnit: route.pricePerUnit, maxUnits, maxValueWei,
        issuedAt: Math.max(c.times.now - ISSUED_BEFORE_SECONDS, c.subscription.startsAt),
        expiry: Math.min(now + REQUEST_LIFETIME_SECONDS, c.stopAt),
      };
      const callId = hashServiceRequest(domain, request);
      const signature = signServiceRequest(sessionKey.privateKey, domain, request);
      const message = encodeMessage({ request: requestToWire(request), signature, body: c.body });
      // A message over the seller's cap would be refused before it is read: that is the caller's, not the seller's.
      if (message.length + PEER_LIMITS.envelopeBytes > PEER_LIMITS.serveRequestBytes) {
        return fail(413, 'request_too_large', 'the call is larger than a seller takes');
      }
      // The last moment its client's leaving stops the call.
      if (c.signal?.aborted) return gone();
      const kept: HeldReceipt = {
        callId, epoch: c.times.epoch, subscriptionId: c.subscriptionId, budgetIndex: c.budgetIndex, seller: route.seller.toString(), keyId,
        request: requestToWire(request), signature, state: 'open',
      };
      // On disk before it goes, with the key's reservation: a node that stops while it waits still counts it.
      await this.ledger.recordSent({ ...kept, problem: 'sent' });
      sent = true;
      return await this.sendAndKeep(c, route, domain, request, message, kept, used);
    } finally {
      if (!sent) this.deps.keys.release(keyId, maxValueWei);
    }
  }

  /**
   * Send a signed call and keep what comes back: its receipt, checked, or the call at its most value. `used` is what
   * the budget had used on chain before it.
   */
  private async sendAndKeep(
    c: BudgetCall,
    route: Route,
    domain: MarketplaceDomain,
    request: ServiceRequest,
    message: Uint8Array,
    kept: HeldReceipt,
    used: bigint,
  ): Promise<GatewayAnswer> {
    const router = this.deps.router;
    const started = Date.now();
    let answer: ServeResponseReceived;
    try {
      answer = await this.sendServe(route.peerId, message, kept.callId);
    } catch {
      // No answer, or none that reads as one: the seller may have served it, and it counts as such.
      router.unreachable(route.seller);
      await this.keepUnsettled({ ...kept, problem: 'unanswered' });
      return fail(503, 'seller_unreachable', 'the seller did not answer; try again', { serviceId: c.serviceId });
    }
    router.measured(route.seller, Date.now() - started);
    if (!answer.ok) {
      if (answer.code === 'WrongPrice') router.requote(route.seller);
      else if (!answer.retry) router.demote(route.seller);
      else if (answer.code !== 'EpochEnding') router.unreachable(route.seller);
      await this.keepUnsettled({ ...kept, problem: answer.code });
      return fail(502, 'seller_refused', `the seller refused the call: ${answer.code}`, { sellerCode: answer.code, retry: answer.retry });
    }
    const checked = await this.checkReceipt(domain, request, kept.callId, c.budgetIndex, answer);
    if (checked.problem) {
      // A receipt that fails a check is kept as its seller sent it, whatever its shape; the call keeps its key's reservation.
      await this.ledger.recordUnresolved({
        ...kept, receipt: answer.receipt as ReceiptWire, receiptSignature: answer.receiptSignature, state: 'refused', problem: checked.problem,
      });
      router.failed(route.seller, c.times.epoch);
      return fail(502, 'bad_receipt', `the seller's receipt failed a check: ${checked.problem}`, { problem: checked.problem });
    }
    const receipt = checked.receipt!;
    // Kept as decoded, its key charged the receipt's value in the same record; the ledger gives back the call's reservation.
    await this.ledger.recordAccepted({ ...kept, receipt: receiptToWire(receipt), receiptSignature: answer.receiptSignature, state: 'held' }, c.times.now);
    const left = c.budget.value - used - this.book.heldValue(c.budgetKey);
    const { content, tool_calls: toolCalls, finish_reason: finish } = answer.result;
    const split = usageOf(answer.usage, receipt.units);
    return {
      status: 200,
      body: {
        id: kept.callId,
        object: 'chat.completion',
        created: receipt.completedAt,
        model: c.model,
        choices: [{
          index: 0,
          message: toolCalls ? { role: 'assistant', content, tool_calls: toolCalls } : { role: 'assistant', content },
          finish_reason: finish ?? (toolCalls ? 'tool_calls' : 'stop'),
        }],
        usage: split
          ? { prompt_tokens: split.promptTokens, completion_tokens: split.completionTokens, total_tokens: Number(receipt.units) }
          : { total_tokens: Number(receipt.units) },
        marketplace: {
          callId: kept.callId, serviceId: c.serviceId, seller: Number(route.seller), units: Number(receipt.units),
          ...amount('value', receipt.valueWei), ...amount('budgetLeft', left > 0n ? left : 0n),
        },
      },
    };
  }

  /** The checks of the module comment, of a receipt as it came: decoded first, then `problem` names the first that failed. */
  private async checkReceipt(
    domain: MarketplaceDomain,
    request: ServiceRequest,
    callId: string,
    budgetIndex: number,
    answer: ServeAnswerReceived,
  ): Promise<{ receipt?: QueryInferenceReceipt; problem?: string }> {
    let receipt: QueryInferenceReceipt;
    try {
      receipt = receiptFromWire(answer.receipt);
    } catch {
      return { problem: 'malformed' };
    }
    if (receipt.requestDigest !== callId) return { problem: 'other_request' };
    if (answer.budgetIndex !== budgetIndex) return { problem: 'other_budget' };
    if (receipt.units > request.maxUnits) return { problem: 'units_over_max' };
    if (receipt.valueWei !== receipt.units * request.pricePerUnit || receipt.valueWei > request.maxValueWei) return { problem: 'value_mismatch' };
    if (receipt.completedAt < request.issuedAt || receipt.completedAt > request.expiry) return { problem: 'outside_time' };
    if (receipt.resultCommitment !== resultCommitmentOf(answer.result)) return { problem: 'result_mismatch' };
    const signer = receiptSignerOf(domain, receipt, answer.receiptSignature);
    if (!signer) return { problem: 'bad_signature' };
    const verdict = await this.deps.chain.verifyACKIdentityDetailed(signer, request.seller);
    // An RPC failure says nothing about the seller: the receipt is kept, and checked again when it lands.
    if (!verdict.valid && verdict.reason !== 'rpc-error') return { problem: 'not_a_seller_key' };
    return { receipt };
  }

  /**
   * One `serve`, with one retry under a new message id when the messenger lost the first answer. The answer is read
   * with `serveResponseFromWire`, so one that is not a serve answer throws as no answer does.
   */
  private async sendServe(peerId: string, message: Uint8Array, callId: string): Promise<ServeResponseReceived> {
    for (let attempt = 0; ; attempt++) {
      const bytes = await this.deps.send(peerId, message, `${callId}:${attempt}`);
      if (attempt === 0 && new TextDecoder().decode(bytes) === 'RESPONSE_GONE') continue;
      return serveResponseFromWire(decodeMessage(bytes));
    }
  }

  /** A call its seller refused or never answered, kept; past `MAX_UNSETTLED_PER_SELLER` in its epoch, the seller is out for the rest of it. */
  private async keepUnsettled(r: HeldReceipt): Promise<void> {
    this.unsettled(r);
    await this.ledger.recordUnresolved(r);
  }

  private unsettled(r: HeldReceipt): void {
    if (this.book.unsettledBy(r) >= MAX_UNSETTLED_PER_SELLER) this.deps.router.failed(BigInt(r.seller), r.epoch);
  }

  /** The call ids of `receipts` whose nonces the chain shows used. */
  private async usedOf(receipts: readonly HeldReceipt[]): Promise<Set<string>> {
    const words = new Map<string, bigint>();
    const used = new Set<string>();
    for (const r of receipts) {
      const nonce = BigInt(r.request.nonce);
      const key = `${r.subscriptionId}:${r.seller}:${nonce >> 8n}`;
      if (!words.has(key)) words.set(key, await this.deps.chain.nonceWord(r.subscriptionId, BigInt(r.seller), nonce >> 8n));
      if ((words.get(key)! >> (nonce & 0xffn)) & 1n) used.add(r.callId);
    }
    return used;
  }

  private async rowsOf(epoch: number): Promise<ReconciledRow[]> {
    const chain = this.deps.chain;
    const subscriptionId = subscriptionIdOf(this.deps.buyerWallet, epoch);
    const receipts = this.book.callsOf(epoch).filter(isKept);
    if (!(await chain.subscriptionExists(subscriptionId))) return [];
    const budgets = await chain.getBudgets(subscriptionId);
    const used = await this.usedOf(receipts);
    return reconcileSubscription(await this.domainOf(), receipts, await this.landedFor(subscriptionId), (r) => used.has(r.callId),
      (i) => budgets[i]?.serviceId.toLowerCase() ?? '');
  }

  /** The groups landed for a subscription, read on from where the last read ended. */
  private async landedFor(subscriptionId: string): Promise<LandedGroup[]> {
    const before = this.scans.get(subscriptionId);
    // The first read starts at the block of the funding, or at the settlement's deployment when that is not known.
    const from = before ? before.toBlock + 1 : (await this.deps.store.fundingBlock(subscriptionId)) ?? undefined;
    const next = await this.deps.chain.listReceiptsLanded(subscriptionId, from);
    const groups = [...(before?.groups ?? []), ...next.groups.filter((g) => !before || g.blockNumber > before.toBlock)];
    this.scans.set(subscriptionId, { toBlock: Math.max(before?.toBlock ?? -1, next.toBlock), groups });
    return groups;
  }

  /**
   * Keep an ended epoch's reconciliation, and drop its calls and nonce counters: the ledger's compaction. A refused or
   * open call whose request landed charges its key the most the request allowed, which is all this node can tell of
   * what landed for it, in the same rewrite; one that did not land charges nothing.
   */
  private async finalize(epoch: number): Promise<void> {
    const rows = await this.rowsOf(epoch);
    const unknown = this.book.callsOf(epoch).filter((r) => !isKept(r));
    const landed = await this.usedOf(unknown);
    const charges = unknown.filter((r) => landed.has(r.callId)).map((r) => ({ keyId: r.keyId, value: exposureOf(r), at: r.request.issuedAt }));
    const subscriptionId = subscriptionIdOf(this.deps.buyerWallet, epoch);
    await this.ledger.finalize(epoch, subscriptionId, rows, charges);
    this.scans.delete(subscriptionId);
    for (const key of this.sessionKeys.keys()) if (key.startsWith(subscriptionId)) this.sessionKeys.delete(key);
  }

  /** The subscription's session key, opened once and kept in memory; `null` when this node does not hold it. */
  private async sessionKeyOf(subscriptionId: string, onChain: string): Promise<ethers.Wallet | null> {
    const kept = this.sessionKeys.get(subscriptionId);
    if (kept) return kept;
    if ((await this.deps.store.sessionKeyAddress(subscriptionId)) !== ethers.getAddress(onChain)) return null;
    const key = await this.deps.store.sessionKeyFor(subscriptionId);
    this.sessionKeys.set(subscriptionId, key);
    return key;
  }

  private async domainOf(): Promise<MarketplaceDomain> {
    this.domain ??= (await this.deps.chain.getMarketplaceContracts()).requestDomain;
    return this.domain;
  }
}

/** The most units a call can take: the most its input can (`inputUnitsBound`, as its seller counts it), and `max_tokens`. */
export function unitsBound(body: InferenceBody): bigint {
  return inputUnitsBound(body) + BigInt(body.max_tokens);
}

/** A seller's split of a call's units, when it adds up to the receipt's: it is not signed, and the receipt's units are. */
function usageOf(usage: ServeUsage | undefined, units: bigint): ServeUsage | undefined {
  return usage && BigInt(usage.promptTokens) + BigInt(usage.completionTokens) === units ? usage : undefined;
}
