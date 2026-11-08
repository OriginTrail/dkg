// SPDX-License-Identifier: Apache-2.0

/**
 * The buyer's gateway (OT-RFC-27): an OpenAI-compatible chat completion,
 * paid for from this epoch's subscription and served by the router's seller.
 * A call goes through, in order:
 *   1. the caller: the node's admin, or a live access key within its rate,
 *      checked before the body is read (`callerOf`), then the key's services;
 *   2. the epoch: from the sellers' stop time to the next epoch's start, the
 *      answer is 503 with `Retry-After`;
 *   3. this epoch's subscription, and the call's service budget in it;
 *   4. a seller, from the router;
 *   5. the soft ceiling: what the budget used on chain, the receipts this node
 *      holds, and this call's most value stay under 95% of the budget;
 *   6. the key's own budget;
 *   7. the request, signed by the subscription's session key: a nonce from a
 *      counter per subscription and seller, written before it is signed;
 *      `issuedAt` the chain's time and never before `startsAt`; an expiry ten
 *      minutes on, or at the stop time if that is sooner; `maxUnits` the input's
 *      UTF-8 bytes, which a tokenizer never exceeds, plus `max_tokens` and an
 *      allowance per message; `maxValueWei` those units at the quoted price;
 *   8. the seller's answer, and its receipt's checks: it answers this request,
 *      `units` within `maxUnits`, `valueWei` the units at the price, the result
 *      is what it commits to, and an operational key of the seller's Core Node
 *      signed it. A receipt that fails takes the seller out of routing for the
 *      epoch, and the call fails;
 *   9. the receipt is kept before the answer goes back.
 * Calls on one budget run one at a time, from the ceiling to the receipt.
 */
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  hashServiceRequest,
  signServiceRequest,
  subscriptionIdOf,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type QueryInferenceReceipt,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import type { AccessKey, AccessKeys } from './keys.js';
import { Journal, KeyedLock } from './journal.js';
import { serviceIdOf } from './offers.js';
import type { Router } from './router.js';
import { receiptSignerOf, DEFAULT_STOP_SERVING_SECONDS } from './seller.js';
import type { BuyerStore } from './store.js';
import { amount } from './views.js';
import {
  WireError,
  decodeMessage,
  encodeMessage,
  inferenceBodyFromWire,
  receiptFromWire,
  requestToWire,
  resultCommitmentOf,
  type InferenceBody,
  type ReceiptWire,
  type ServeResponse,
  type ServiceRequestWire,
} from './wire.js';

/** Calls stop at this share of a budget's value. */
const SOFT_CEILING_PERCENT = 95n;
/** How long a request may wait for its seller. */
const REQUEST_LIFETIME_SECONDS = 600;
/** Units allowed per message for the chat template, and per call. */
const UNITS_PER_MESSAGE = 8;
const UNITS_PER_CALL = 16;
const DEFAULT_MAX_TOKENS = 512;

export interface GatewayAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Who calls, once checked: the node's admin (the UI's playground), or a live access key. */
export type GatewayCaller = { admin: true } | { admin: false; key: AccessKey };

export interface GatewayDeps {
  chain: MarketplaceChainAdapter;
  buyerWallet: string;
  /** Where the subscriptions' session keys are. */
  store: BuyerStore;
  router: Router;
  keys: AccessKeys;
  /** Send a `serve` message to a seller and read the answer's bytes. */
  send(peerId: string, payload: Uint8Array, messageId: string): Promise<Uint8Array>;
  /** Where the receipts and nonce counters go. */
  dir: string;
  /** The model URN of a service in an epoch, from the offers, for listing models. */
  modelOf?(serviceId: string, epoch: number): Promise<string | undefined>;
  /** The sellers' stop time before an epoch's end. Default 180. */
  stopServingSeconds?: number;
}

/** A call's receipt, as the buyer keeps it: `held` until it lands, or `refused` with the check it failed. */
export interface HeldReceipt {
  callId: string;
  subscriptionId: string;
  budgetIndex: number;
  seller: string;
  keyId: string;
  request: ServiceRequestWire;
  signature: string;
  receipt: ReceiptWire;
  receiptSignature: string;
  state: 'held' | 'refused';
  problem?: string;
}

const fail = (status: number, code: string, message: string, more: Record<string, unknown> = {}, headers?: Record<string, string>): GatewayAnswer =>
  ({ status, body: { error: { code, message, type: 'marketplace' }, ...more }, ...(headers ? { headers } : {}) });

export class Gateway {
  private readonly receipts: Journal<HeldReceipt>;
  private readonly nonceLog: Journal<{ subscriptionId: string; seller: string; nonce: string }>;
  private readonly lock = new KeyedLock();
  private readonly nonces = new Map<string, bigint>();
  private readonly held = new Map<string, bigint>();
  private readonly sessionKeys = new Map<string, ethers.Wallet>();
  private domain: MarketplaceDomain | undefined;

  constructor(private readonly deps: GatewayDeps) {
    this.receipts = new Journal(join(deps.dir, 'buyer-receipts.jsonl'));
    this.nonceLog = new Journal(join(deps.dir, 'buyer-nonces.jsonl'));
  }

  /** The access keys callers present. */
  get keys(): AccessKeys {
    return this.deps.keys;
  }

  /** Read the receipts held and the nonce counters. Call once before serving. */
  async load(): Promise<void> {
    for (const n of await this.nonceLog.read()) this.noteNonce(n.subscriptionId, n.seller, BigInt(n.nonce));
    for (const r of await this.receipts.read()) if (r.state === 'held') this.noteHeld(r);
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
   * The caller of a gateway route, before its body is read: the node's admin,
   * or a live key within its rate. Anything else is refused with 401 (or 429
   * for the rate), with no other work done. `token` is the bearer credential
   * as presented; a node or agent token is not a key.
   */
  async callerOf(credential: { admin: boolean; token: string | undefined }): Promise<{ caller: GatewayCaller } | { answer: GatewayAnswer }> {
    if (credential.admin) return { caller: { admin: true } };
    const check = await this.deps.keys.check(credential.token, Math.floor(Date.now() / 1000));
    if (!check.ok) return { answer: fail(check.status, check.code, 'an access key of this node, or its admin token, is needed') };
    return { caller: { admin: false, key: check.key } };
  }

  async chatCompletion(caller: GatewayCaller, raw: unknown): Promise<GatewayAnswer> {
    const call = raw as { model?: unknown; messages?: unknown; max_tokens?: unknown; stream?: unknown } | null;
    if (typeof call?.model !== 'string' || call.model === '') return fail(400, 'bad_request', 'model is required');
    if (call.stream === true) return fail(400, 'bad_request', 'streamed answers are not supported');
    let body: InferenceBody;
    try {
      body = inferenceBodyFromWire({ messages: call.messages, max_tokens: call.max_tokens ?? DEFAULT_MAX_TOKENS });
    } catch (err) {
      return fail(400, 'bad_request', err instanceof WireError ? err.message : 'bad request');
    }
    const serviceId = ethers.isHexString(call.model, 32) ? call.model.toLowerCase() : serviceIdOf(call.model);
    if (!caller.admin && caller.key.services && !caller.key.services.includes(serviceId)) {
      return fail(401, 'service_not_allowed', 'the access key may not call this service');
    }

    const chain = this.deps.chain;
    const times = await chain.getEpochTimes();
    const stopAt = times.endsAt - (this.deps.stopServingSeconds ?? DEFAULT_STOP_SERVING_SECONDS);
    if (times.now >= stopAt) {
      return fail(503, 'epoch_ending', 'the epoch is ending; calls resume when the next one starts', { nextEpochAt: times.endsAt },
        { 'Retry-After': String(Math.max(1, times.endsAt - times.now)) });
    }
    const subscriptionId = subscriptionIdOf(this.deps.buyerWallet, times.epoch);
    const subscription = await chain.getSubscription(subscriptionId);
    const budgets = subscription ? await chain.getBudgets(subscriptionId) : [];
    const budgetIndex = budgets.findIndex((b) => b.serviceId.toLowerCase() === serviceId);
    if (!subscription || budgetIndex < 0) {
      return fail(402, 'no_subscription', 'no subscription funds this service in this epoch', { serviceId, fork: { fund: true } });
    }
    const budget = budgets[budgetIndex]!;
    const budgetKey = `${subscriptionId}:${budgetIndex}`;
    return this.lock.run(budgetKey, async () => {
      const route = await this.deps.router.pick(serviceId, times.epoch, budget.maxPricePerUnit);
      if (!route) return fail(503, 'no_seller', 'no seller serves this service now', { serviceId });
      const maxUnits = unitsBound(body);
      const maxValueWei = maxUnits * route.pricePerUnit;
      const used = budget.value - await chain.budgetLeft(subscriptionId, budgetIndex);
      const held = this.held.get(budgetKey) ?? 0n;
      const ceiling = (budget.value * SOFT_CEILING_PERCENT) / 100n;
      if (used + held + maxValueWei > ceiling) {
        const left = ceiling > used + held ? ceiling - used - held : 0n;
        return fail(402, 'soft_ceiling', 'the budget is at its soft ceiling', { serviceId, ...amount('left', left), fork: { topUp: true, nextEpochAt: times.endsAt } });
      }
      const keyId = caller.admin ? 'admin' : caller.key.keyId;
      if (!caller.admin) {
        const spent = BigInt((await this.deps.keys.list()).find((k) => k.keyId === keyId)?.spent ?? '0');
        if (spent + maxValueWei > BigInt(caller.key.budget)) return fail(402, 'key_budget', "the call could cost more than the access key's budget has left");
      }
      const sessionKey = await this.sessionKeyOf(subscriptionId, subscription.sessionKey);
      if (!sessionKey) return fail(500, 'session_key_missing', "this node does not hold the subscription's session key");
      const domain = await this.domainOf();
      const request: ServiceRequest = {
        subscriptionId, serviceId, seller: route.seller, nonce: await this.nextNonce(subscriptionId, route.seller),
        pricePerUnit: route.pricePerUnit, maxUnits, maxValueWei,
        issuedAt: Math.max(times.now, subscription.startsAt), expiry: Math.min(times.now + REQUEST_LIFETIME_SECONDS, stopAt),
      };
      const callId = hashServiceRequest(domain, request);
      const signature = signServiceRequest(sessionKey.privateKey, domain, request);
      const started = Date.now();
      let answer: ServeResponse;
      try {
        answer = await this.sendServe(route.peerId, { request: requestToWire(request), signature, body }, callId);
      } catch {
        this.deps.router.unreachable(route.seller);
        return fail(503, 'seller_unreachable', 'the seller did not answer; try again', { serviceId });
      }
      this.deps.router.measured(route.seller, Date.now() - started);
      if (!answer.ok) {
        if (answer.code === 'WrongPrice') this.deps.router.requote(route.seller);
        else if (answer.retry && answer.code !== 'EpochEnding') this.deps.router.unreachable(route.seller);
        return fail(502, 'seller_refused', `the seller refused the call: ${answer.code}`, { sellerCode: answer.code, retry: answer.retry });
      }
      const checked = await this.checkReceipt(domain, request, callId, budgetIndex, answer);
      const entry: HeldReceipt = {
        callId, subscriptionId, budgetIndex, seller: route.seller.toString(), keyId, request: requestToWire(request), signature,
        receipt: answer.receipt, receiptSignature: answer.receiptSignature, state: checked.problem ? 'refused' : 'held',
        ...(checked.problem ? { problem: checked.problem } : {}),
      };
      await this.receipts.append(entry);
      if (checked.problem) {
        this.deps.router.failed(route.seller, times.epoch);
        return fail(502, 'bad_receipt', `the seller's receipt failed a check: ${checked.problem}`, { problem: checked.problem });
      }
      const receipt = checked.receipt!;
      this.noteHeld(entry);
      if (keyId !== 'admin') await this.deps.keys.charge(keyId, receipt.valueWei, times.now);
      const left = budget.value - used - (this.held.get(budgetKey) ?? 0n);
      return {
        status: 200,
        body: {
          id: callId,
          object: 'chat.completion',
          created: receipt.completedAt,
          model: call.model,
          choices: [{ index: 0, message: { role: 'assistant', content: answer.result.content }, finish_reason: 'stop' }],
          usage: { total_tokens: Number(receipt.units) },
          marketplace: {
            callId, serviceId, seller: Number(route.seller), units: Number(receipt.units),
            ...amount('value', receipt.valueWei), ...amount('budgetLeft', left > 0n ? left : 0n),
          },
        },
      };
    });
  }

  /** The checks of the module comment: `problem` names the first that failed. */
  private async checkReceipt(
    domain: MarketplaceDomain,
    request: ServiceRequest,
    callId: string,
    budgetIndex: number,
    answer: Extract<ServeResponse, { ok: true }>,
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
    if (typeof answer.result?.content !== 'string' || receipt.resultCommitment !== resultCommitmentOf(answer.result.content)) {
      return { problem: 'result_mismatch' };
    }
    const signer = receiptSignerOf(domain, receipt, answer.receiptSignature);
    if (!signer) return { problem: 'bad_signature' };
    const verdict = await this.deps.chain.verifyACKIdentityDetailed(signer, request.seller);
    // An RPC failure says nothing about the seller: the receipt is kept, and checked again when it lands.
    if (!verdict.valid && verdict.reason !== 'rpc-error') return { problem: 'not_a_seller_key' };
    return { receipt };
  }

  /** One `serve`, with one retry under a new message id when the messenger lost the first answer. */
  private async sendServe(peerId: string, message: object, callId: string): Promise<ServeResponse> {
    for (let attempt = 0; ; attempt++) {
      const bytes = await this.deps.send(peerId, encodeMessage(message), `${callId}:${attempt}`);
      if (attempt === 0 && new TextDecoder().decode(bytes) === 'RESPONSE_GONE') continue;
      return decodeMessage(bytes) as ServeResponse;
    }
  }

  private async nextNonce(subscriptionId: string, seller: bigint): Promise<bigint> {
    const key = `${subscriptionId}:${seller}`;
    const nonce = (this.nonces.get(key) ?? -1n) + 1n;
    await this.nonceLog.append({ subscriptionId, seller: seller.toString(), nonce: nonce.toString() });
    this.noteNonce(subscriptionId, seller.toString(), nonce);
    return nonce;
  }

  private noteNonce(subscriptionId: string, seller: string, nonce: bigint): void {
    const key = `${subscriptionId}:${seller}`;
    if (nonce > (this.nonces.get(key) ?? -1n)) this.nonces.set(key, nonce);
  }

  private noteHeld(r: HeldReceipt): void {
    const key = `${r.subscriptionId}:${r.budgetIndex}`;
    this.held.set(key, (this.held.get(key) ?? 0n) + BigInt(r.receipt.valueWei));
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

/** The most units a call can take: its input's UTF-8 bytes, an allowance per message and per call, and `max_tokens`. */
export function unitsBound(body: InferenceBody): bigint {
  const input = body.messages.reduce((n, m) => n + ethers.toUtf8Bytes(m.content).length + UNITS_PER_MESSAGE, UNITS_PER_CALL);
  return BigInt(input + body.max_tokens);
}
