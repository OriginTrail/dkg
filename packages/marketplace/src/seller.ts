// SPDX-License-Identifier: Apache-2.0

/**
 * The seller (OT-RFC-27): a Core Node that serves its services to any buyer
 * whose subscription funds them, signs a receipt for each call, and lands the
 * receipts on chain (landing.ts).
 *
 * - **The gate.** It serves only while it is a Core Node: it has a profile and
 *   a place in the sharding table, which takes the minimum stake. Read at every
 *   tick; until the first tick it serves nothing. A tick whose reads of it fail
 *   keeps what the last one read.
 * - **Prices.** A service's price per unit, in wei, is set per epoch. The
 *   current epoch's is frozen the first time it is used and kept on disk. The
 *   next epoch's can be set ahead of it, until that epoch starts; the settings'
 *   price applies to epochs neither frozen nor set.
 * - **Offers.** Each service's offer is a Knowledge Asset in the Marketplace
 *   Context Graph's Verifiable Memory, kept by the offer job (offer-job.ts):
 *   it names the node's peer id, and the receipts' operational wallet signs
 *   it. The job runs at every tick, beside the landing and never inside it.
 * - **Each call** is checked, cheapest check first, then
 *   served by the service's backend, cut to the units the request allows, and
 *   its receipt signed by an operational wallet. A call with tools is taken
 *   only by a service that takes tool calls (`tools`, said in its quotes);
 *   its tools go to the backend, and the tools the model called come back in
 *   the result, which the receipt commits to with its text. An answer cut short
 *   is its text alone: a tool call cut short is no call. The answer says,
 *   unsigned, how its units split between prompt and completion tokens. The
 *   call, its result and its receipt are in the ledger before the answer goes
 *   back; if that write fails, the answer is an error and no result. A repeat
 *   of a call already served
 *   gets the stored answer, but only from the peer it was served to: once its
 *   receipt lands, the request and its signature are public. Calls on one
 *   subscription run one at a time, so a nonce is claimed once and a budget's
 *   check counts every call before it.
 * - **No backend work it is not paid for.** A request is taken only while its
 *   backend's longest answer, and the receipt after it, still come before the
 *   request expires, checked again after any wait for the calls before it; a
 *   receipt is never signed past the expiry, which the chain would refuse. A
 *   unit cap the input could use up is refused before the backend runs, and
 *   the backend is asked for no more output than the cap pays for. A call
 *   whose backend ran but gave nothing to sign is not run again.
 * - **A backend that refuses a call.** An answer about the call itself (400,
 *   404, 413, 415 or 422) is refused as `BadRequest`, which a buyer does not
 *   retry: it tries other sellers first for a while, and still routes this
 *   seller's other services. Any other failure (no answer in time, or 401,
 *   403, 408, 409, 429 or 5xx, about the seller's key, quota or load) is
 *   `UpstreamError`, to retry. When the backend refuses a call with tools as
 *   made (400 or 422) and has shown nothing of tools since the node started,
 *   it is checked with minimal calls with tools of the seller's own, which no
 *   buyer's content is in: the model's own choice of tools, then the function
 *   named (seller-backend.ts). Both refused as made, the service takes no tool
 *   calls until the node restarts, and its quotes stop saying it takes them;
 *   either served, the refusal was that call's own, and the service keeps its
 *   tools. The refused call waits for that a few seconds at most, and never
 *   past its backend's time limit, which the buyer's wait for it outlasts.
 * - **The end of the epoch.** Within `stopServingSeconds` of it, new calls are
 *   refused: their receipts could not land in time.
 * - **The job.** Ticks every `tickSeconds` from the epoch's start, and once
 *   more `finalLandingSeconds` before its end: the gate, then the offer job
 *   started beside landing, each on its own, so one failing leaves the others.
 *   A tick that fails as a whole is tried again soon, and never past the final
 *   tick.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import {
  QUERY_INFERENCE_RECEIPT_TYPES,
  hashQueryInferenceReceipt,
  hashServiceRequest,
  recoverSigner,
  type EpochTimes,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type QueryInferenceReceipt,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import { MarketplaceRefusal } from './buyer.js';
import { UpstreamError, type Completion, type Connector } from './connector.js';
import { KeyedLock, setAside, writeDurably } from './journal.js';
import { DEFAULT_LANDING, Lander, nextLandingAt, secondsToNextTick, secondsToRetry, type LandingReport, type LandingSettings } from './landing.js';
import { SellerLedger, type ServedCall } from './ledger.js';
import { OfferJob, type OfferAssets } from './offer-job.js';
import { ServiceBackend } from './seller-backend.js';
import { inputUnitsBound } from './seller-bounds.js';
import {
  PEER_LIMITS,
  WireError,
  quoteRequestFromWire,
  receiptToWire,
  refusal,
  requestToWire,
  resultCommitmentOf,
  serveRequestFromWire,
  usesTools,
  type InferenceBody,
  type QuoteResponse,
  type ServeAnswer,
  type ServeRefusal,
  type ServeResponse,
  type ServeResult,
} from './wire.js';

/** New calls stop this long before an epoch ends. */
export const DEFAULT_STOP_SERVING_SECONDS = 180;
/** The longest a service's backend takes to answer, when its settings name no time limit. */
export const DEFAULT_BACKEND_TIMEOUT_MS = 60_000;
/**
 * The longest time limit a backend may have: ten seconds inside the buyer gateway's wait for an answer
 * (`PEER_LIMITS.serveTimeoutMs`). A slower answer reaches a buyer that has stopped waiting, which still pays for it.
 */
export const MAX_BACKEND_TIMEOUT_MS = PEER_LIMITS.serveTimeoutMs - 10_000;
/** What a call needs after its backend answers, before its request expires: the chain's time, the receipt signed and stored. */
const RECEIPT_SECONDS = 5;
/** Calls whose backend ran but gave nothing to sign, kept so a repeat does not run it again: the newest this many. */
const FAILED_CALLS_KEPT = 10_000;
/**
 * A backend's statuses about the call itself, not the seller's key, quota or load: the same call would be refused
 * again, so it is refused as `BadRequest`, not to retry. Any other failure is `UpstreamError`, to retry.
 */
const CALL_REFUSED: ReadonlySet<number> = new Set([400, 404, 413, 415, 422]);

export interface SellerService {
  /** The model's URN; `serviceId` is its keccak256. */
  model: string;
  serviceId: string;
  /** Wei per unit, for epochs whose price is not frozen yet. */
  pricePerUnit: bigint;
  capacity: number | null;
  provenance: 'weights-pinned' | 'upstream-claimed';
  tokenizerBundle?: string;
  connector: Connector;
  /** The connector's time limit: a request that expires sooner, and the receipt after it, is refused. `DEFAULT_BACKEND_TIMEOUT_MS` by default. */
  backendTimeoutMs?: number;
  /**
   * Whether it takes tool calls: said in its quotes. Off unless set; off too, until the node restarts, once its
   * backend refuses the seller's own minimal calls with tools as made (`ServiceBackend`).
   */
  tools?: boolean;
}

export interface SellerDeps {
  chain: MarketplaceChainAdapter;
  /** Where the seller's ledger and frozen prices go. */
  dir: string;
  services: SellerService[];
  /** The operational wallet that signs receipts and offers. */
  signer: string;
  /** The node's own libp2p peer id: its offers name it, and buyers dial it. */
  peerId: string;
  /** The node's operational wallets, which send its batches; the signer's alone by default. */
  wallets?: readonly string[];
  stopServingSeconds: number;
  tickSeconds: number;
  /** The landing loop's settings; the defaults otherwise. */
  landing?: LandingSettings;
  /** Where the offers are published: the Marketplace Context Graph's Verifiable Memory. Without it, none are. */
  offers?: OfferAssets;
  log?: (message: string) => void;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Seller {
  readonly services: ReadonlyMap<string, SellerService>;
  readonly ledger: SellerLedger;
  readonly lander: Lander;
  /** The offer job, when the seller has somewhere to publish its offers. */
  readonly offers: OfferJob | undefined;
  /** What the last tick's landing did. */
  lastLanding: LandingReport | undefined;
  private readonly landing: LandingSettings;
  private readonly lock = new KeyedLock();
  private prices: Record<string, Record<string, string>> = {};
  private identityId = 0n;
  private open = false;
  private domain: MarketplaceDomain | undefined;
  /** service id => its backend: whether the last call answered, and what it has shown of tools. */
  private readonly backends: ReadonlyMap<string, ServiceBackend>;
  /** The chain's time as the last tick read it, and when, by this host's clock. */
  private lastTimes: { times: EpochTimes; at: number } | undefined;
  /** request digest => the refusal of a call whose backend ran but gave nothing to sign, oldest first. */
  private readonly failed = new Map<string, ServeRefusal>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking: Promise<void> | undefined;

  constructor(private readonly deps: SellerDeps) {
    this.services = new Map(deps.services.map((s) => [s.serviceId.toLowerCase(), s]));
    this.backends = new Map(deps.services.map((s) => [
      s.serviceId.toLowerCase(),
      new ServiceBackend(s.connector, { model: s.model, takesTools: s.tools === true, timeoutMs: s.backendTimeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS }, deps.log),
    ]));
    this.landing = deps.landing ?? DEFAULT_LANDING;
    this.ledger = new SellerLedger(deps.dir, deps.log);
    this.lander = new Lander({ chain: deps.chain, ledger: this.ledger, settings: this.landing, ...(deps.log ? { log: deps.log } : {}) });
    this.offers = deps.offers && new OfferJob({
      chain: deps.chain, dir: deps.dir, assets: deps.offers, signer: deps.signer, peerId: deps.peerId, tickSeconds: deps.tickSeconds,
      seller: {
        gate: () => ({ identityId: this.identityId, open: this.open, domain: this.domain }),
        services: () => [...this.services.values()],
        prices: async (serviceId, epoch) => {
          const service = this.serviceOf(serviceId);
          return { price: await this.priceFor(service, epoch, epoch), nextPrice: await this.priceFor(service, epoch + 1, epoch) };
        },
      },
      ...(deps.log ? { log: deps.log } : {}),
    });
  }

  /** The identity it serves as, and whether it serves now. */
  get gate(): { identityId: bigint; open: boolean } {
    return { identityId: this.identityId, open: this.open };
  }

  get chain(): MarketplaceChainAdapter {
    return this.deps.chain;
  }

  /** The node's operational wallets. */
  get wallets(): readonly string[] {
    return this.deps.wallets ?? [this.deps.signer];
  }

  /** Whether a service's backend answered its last call: `up` until one fails. */
  backendOf(serviceId: string): 'up' | 'down' {
    return this.backends.get(serviceId.toLowerCase())?.state ?? 'up';
  }

  /** When the next landing is due, in chain seconds. */
  nextLandingAt(times: EpochTimes): number {
    return nextLandingAt(times, this.landing, this.deps.tickSeconds);
  }

  /** Land now, due or not: what the tick did. */
  async landNow(): Promise<LandingReport> {
    this.lander.landNow();
    this.lastLanding = await this.lander.tick(this.open);
    return this.lastLanding;
  }

  /** A service's price this epoch, which freezes it, and the next epoch's. */
  async pricesOf(serviceId: string): Promise<{ price: bigint; nextPrice: bigint }> {
    const service = this.serviceOf(serviceId);
    const { epoch } = await this.deps.chain.getEpochTimes();
    return { price: await this.priceFor(service, epoch, epoch), nextPrice: await this.priceFor(service, epoch + 1, epoch) };
  }

  /**
   * Set a service's price for the next epoch; this epoch's stays as it is
   * frozen. Refused with `EpochStarted` when that epoch starts before the
   * price is kept: its price may be frozen by then.
   */
  async setNextPrice(serviceId: string, price: bigint): Promise<void> {
    const service = this.serviceOf(serviceId);
    const next = (await this.deps.chain.getEpochTimes()).epoch + 1;
    await this.lock.run('prices', async () => {
      // Read again under the lock: the epoch may have turned while this waited for it.
      if ((await this.deps.chain.getEpochTimes()).epoch >= next) throw new MarketplaceRefusal('EpochStarted', [service.serviceId, String(next)]);
      await this.storePrice(service.serviceId, next, price);
    });
  }

  /**
   * Read the ledger, the offers published and the frozen prices. Call once
   * before serving. A prices file that is empty or not prices, as a power loss
   * during a write can leave it, is moved aside and logged, and the seller
   * starts with none: this epoch's prices are frozen again from the settings.
   * A ledger that cannot be read starts empty (`SellerLedger.load`). A prices
   * file it cannot read at all, a read error that may pass, or a record of the
   * offers published that cannot be read (`OfferJob.load`) fails the load.
   */
  async load(): Promise<void> {
    await this.ledger.load();
    await this.offers?.load();
    const file = join(this.deps.dir, 'seller-prices.json');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
      return;
    }
    const prices = pricesFrom(text);
    if (prices) {
      this.prices = prices;
      return;
    }
    let where: string;
    try {
      where = `it was moved to ${await setAside(file)}`;
    } catch (err) {
      where = `it could not be moved aside (${messageOf(err)})`;
    }
    this.deps.log?.(`[marketplace] the seller's prices ${file} could not be read; ${where}, and this epoch's prices are frozen again from the settings`);
  }

  /** The gate, the offer job started beside landing, then landing. Returns the seconds to the next tick. */
  async tick(): Promise<number> {
    const started = Date.now();
    await this.readGate();
    const times = await this.deps.chain.getEpochTimes();
    this.lastTimes = { times, at: Date.now() };
    // Not awaited: a publish waits for ACKs and a transaction, and landing never waits for it.
    this.offers?.poke();
    this.lastLanding = await this.lander.tick(this.open).catch((err: unknown) => {
      this.deps.log?.(`[marketplace] landing failed: ${messageOf(err)}`);
      return undefined;
    });
    const took = Math.floor((Date.now() - started) / 1_000);
    return Math.max(1, secondsToNextTick(times, this.deps.tickSeconds, this.landing.finalLandingSeconds) - took);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const run = (): void => {
      this.ticking = this.tick()
        .catch((err: unknown) => {
          const elapsed = this.lastTimes ? Math.floor((Date.now() - this.lastTimes.at) / 1_000) : 0;
          const seconds = secondsToRetry(this.lastTimes?.times, elapsed, this.deps.tickSeconds, this.landing.finalLandingSeconds);
          this.deps.log?.(`[marketplace] seller tick failed, tried again in ${seconds} s: ${messageOf(err)}`);
          return seconds;
        })
        .then((seconds) => {
          this.ticking = undefined;
          if (!this.running) return;
          this.timer = setTimeout(run, seconds * 1_000);
          this.timer.unref?.();
        });
    };
    run();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.ticking;
    await this.offers?.stop();
  }

  /** The gate: this node's identity and its place in the sharding table. Reads that fail keep the last ones' answer. */
  private async readGate(): Promise<void> {
    const chain = this.deps.chain;
    try {
      const identityId = await chain.getIdentityId();
      const open = identityId > 0n && await chain.isShardingTableMember(identityId);
      this.domain ??= (await chain.getMarketplaceContracts()).requestDomain;
      this.identityId = identityId;
      this.open = open;
    } catch (err) {
      this.deps.log?.(`[marketplace] the Core Node gate was not read; it stays ${this.open ? 'open' : 'closed'}: ${messageOf(err)}`);
    }
  }

  // -------------------------------------------------------------- quote

  async quote(raw: unknown): Promise<QuoteResponse> {
    const { services } = quoteRequestFromWire(raw);
    const times = await this.deps.chain.getEpochTimes();
    const available = this.open && times.endsAt - times.now > this.deps.stopServingSeconds;
    const offers = [];
    for (const id of services) {
      const s = this.services.get(id);
      if (!s) continue;
      offers.push({
        serviceId: s.serviceId, pricePerUnit: (await this.priceFor(s, times.epoch, times.epoch)).toString(), available, capacity: s.capacity,
        ...(this.backendFor(s).takesTools ? { tools: true as const } : {}),
      });
    }
    return { seller: this.identityId.toString(), epoch: times.epoch, offers };
  }

  // -------------------------------------------------------------- serve

  /**
   * Answer a `serve` message from the peer `from`, as its connection
   * authenticated it: the result and its receipt, or a refusal. Never throws.
   */
  async serve(raw: unknown, from: string): Promise<ServeResponse> {
    try {
      return await this.checkAndServe(raw, from);
    } catch (err) {
      this.deps.log?.(`[marketplace] a call could not be served: ${messageOf(err)}`);
      return refusal('Unavailable');
    }
  }

  private async checkAndServe(raw: unknown, from: string): Promise<ServeResponse> {
    let call: { request: ServiceRequest; signature: string; body: InferenceBody };
    try {
      call = serveRequestFromWire(raw);
    } catch (err) {
      return refusal('BadRequest', err instanceof WireError ? err.message : undefined);
    }
    if (!this.open || !this.domain) return refusal('NotServing');
    // The request as this seller would have been named in it: a request for another seller recovers to another key.
    const request: ServiceRequest = { ...call.request, seller: this.identityId };
    const requestDigest = hashServiceRequest(this.domain, request);
    const repeat = this.repeatOf(requestDigest, call.signature, from);
    if (repeat) return repeat;

    const chain = this.deps.chain;
    const times = await chain.getEpochTimes();
    const readAt = Date.now();
    // 1. Not too near the epoch's end, at this epoch's price.
    if (times.endsAt - times.now <= this.deps.stopServingSeconds) return refusal('EpochEnding');
    const service = this.services.get(request.serviceId);
    if (!service) return refusal('UnknownService');
    // A buyer sends a call with tools only to a seller whose quote says it takes them.
    if (!this.backendFor(service).takesTools && usesTools(call.body)) return refusal('BadRequest', 'this service takes no tool calls');
    if (request.pricePerUnit !== await this.priceFor(service, times.epoch, times.epoch)) return refusal('WrongPrice');
    // 2. A subscription of this epoch that funds the service, under its price cap.
    const subscription = await chain.getSubscription(request.subscriptionId);
    if (!subscription) return refusal('SubscriptionNotFound');
    if (subscription.epoch !== times.epoch) return refusal('NotCurrentEpoch');
    const budgets = await chain.getBudgets(request.subscriptionId);
    const budgetIndex = budgets.findIndex((b) => b.serviceId.toLowerCase() === request.serviceId);
    if (budgetIndex < 0) return refusal('ServiceNotFunded');
    if (request.pricePerUnit > budgets[budgetIndex]!.maxPricePerUnit) return refusal('PriceOverCap');
    // 3. Signed by the subscription's session key, with a low s.
    if (recoverSigner(requestDigest, call.signature) !== ethers.getAddress(subscription.sessionKey)) return refusal('BadSignature');
    // 4. Issued within the subscription, and not expiring before the backend's longest answer and the receipt after it.
    if (request.issuedAt < subscription.startsAt || request.issuedAt > times.now) return refusal('NotYetValid');
    if (this.expiresTooSoon(service, request, times.now)) return refusal('Expired');
    // 5. For an account's subscription, issued while the grant it was funded under lasts.
    if (subscription.accountId !== 0n) {
      const end = await chain.grantEnd(subscription.accountId, subscription.buyer, subscription.grantNonce);
      if (request.issuedAt >= end) return refusal('GrantEnded');
    }
    // One call at a time per subscription: its nonces are one set, whatever the budget.
    return this.lock.run(request.subscriptionId, async () => {
      // A repeat that came while the call it repeats was served gets its answer too.
      const repeated = this.repeatOf(requestDigest, call.signature, from);
      if (repeated) return repeated;
      // 6. A nonce new to the ledger. 7. Budget left, less this seller's receipts not landed, covers the call.
      if (this.ledger.nonceUsed(request.subscriptionId, request.nonce.toString())) return refusal('NonceUsed');
      const left = await chain.budgetLeft(request.subscriptionId, budgetIndex);
      if (left - this.ledger.unlanded(request.subscriptionId, budgetIndex) < request.maxValueWei) return refusal('BudgetExhausted');
      // 4 again, by the time the calls before it took, on this host's clock.
      if (this.expiresTooSoon(service, request, times.now + Math.ceil((Date.now() - readAt) / 1_000))) return refusal('Expired');
      // 8. Units for an answer: more than the most the input could take, or the backend would run for nothing to bill.
      const unitCap = minBig(request.maxUnits, request.maxValueWei / request.pricePerUnit);
      const room = unitCap - inputUnitsBound(call.body);
      if (room <= 0n) return refusal('UnitsTooFew');
      return this.run(service, request, call, { requestDigest, budgetIndex, epoch: times.epoch, unitCap, room, from });
    });
  }

  /**
   * Serve the call, cut to what it allows, sign its receipt and store it all before answering. A call whose backend
   * ran but gave nothing to sign is kept as failed, so a repeat of it does not run the backend again.
   */
  private async run(
    service: SellerService,
    request: ServiceRequest,
    call: { signature: string; body: InferenceBody },
    at: { requestDigest: string; budgetIndex: number; epoch: number; unitCap: bigint; room: bigint; from: string },
  ): Promise<ServeResponse> {
    const { requestDigest, unitCap } = at;
    let completion;
    try {
      const { max_tokens: maxTokens, ...body } = call.body;
      // A call with tools refused as made may first wait, within its time limit, for the check of the backend's tools.
      // No more output than the cap pays for once the input takes the most it could.
      completion = await this.backendFor(service).complete({ ...body, maxTokens: Number(minBig(BigInt(maxTokens), at.room)) });
    } catch (err) {
      // The backend's detail (a missing key's variable, an address, its own words) stays in the log.
      this.deps.log?.(`[marketplace] the backend of ${service.model} failed: ${err instanceof UpstreamError ? err.message : String(err)}`);
      const status = err instanceof UpstreamError ? err.status : undefined;
      // No answer, or one about the seller's key, quota or load: the call may be served later.
      if (status === undefined || !CALL_REFUSED.has(status)) return this.failedOnce(requestDigest, refusal('UpstreamError'));
      return this.failedOnce(requestDigest, refusal('BadRequest', `the service's backend refused the call (${status})`));
    }
    try {
      const input = BigInt(completion.promptTokens);
      if (input >= unitCap) return this.failedOnce(requestDigest, refusal('UnitsTooFew'));
      const completedAt = Math.max((await this.deps.chain.getEpochTimes()).now, request.issuedAt);
      // The chain refuses a receipt completed after its request's expiry: no receipt, and no answer.
      if (completedAt > request.expiry) return this.failedOnce(requestDigest, refusal('Expired'));
      const output = minBig(BigInt(completion.completionTokens), unitCap - input);
      const result = resultOf(completion, Number(output));
      const units = input + output;
      const receipt: QueryInferenceReceipt = {
        requestDigest,
        resultCommitment: resultCommitmentOf(result),
        units,
        valueWei: units * request.pricePerUnit,
        completedAt,
      };
      const receiptSignature = await this.deps.chain.signTypedDataAs(this.deps.signer, this.domain!, QUERY_INFERENCE_RECEIPT_TYPES, { ...receipt });
      const served: ServedCall = {
        requestDigest,
        subscriptionId: request.subscriptionId,
        budgetIndex: at.budgetIndex,
        epoch: at.epoch,
        request: requestToWire(request),
        signature: call.signature,
        receipt: receiptToWire(receipt),
        receiptSignature,
        result,
        usage: { promptTokens: Number(input), completionTokens: Number(output) },
        peerId: at.from,
      };
      await this.ledger.recordServed(served);
      return answerOf(served);
    } catch (err) {
      this.deps.log?.(`[marketplace] a call could not be served: ${messageOf(err)}`);
      return this.failedOnce(requestDigest, refusal('Unavailable'));
    }
  }

  /**
   * A call served or tried before: the stored answer, only for the peer it was served to, since the request and its
   * signature are public once its receipt lands; the stored refusal of one whose backend ran but gave nothing to
   * sign. `undefined` for a call new to the seller.
   */
  private repeatOf(requestDigest: string, signature: string, from: string): ServeResponse | undefined {
    const served = this.ledger.served(requestDigest);
    if (served) {
      if (served.signature !== signature) return refusal('BadSignature');
      return served.peerId === from ? answerOf(served) : refusal('NonceUsed');
    }
    return this.failed.get(requestDigest);
  }

  /** Keep a call whose backend ran but gave nothing to sign, and its refusal: the newest `FAILED_CALLS_KEPT`. */
  private failedOnce(requestDigest: string, refused: ServeRefusal): ServeRefusal {
    this.failed.delete(requestDigest);
    this.failed.set(requestDigest, refused);
    if (this.failed.size > FAILED_CALLS_KEPT) this.failed.delete(this.failed.keys().next().value!);
    return refused;
  }

  /** The service's backend: one per service, made with the seller. */
  private backendFor(service: SellerService): ServiceBackend {
    return this.backends.get(service.serviceId.toLowerCase())!;
  }

  /** Whether `request` expires before the service's backend could answer and its receipt be signed, at chain time `now`. */
  private expiresTooSoon(service: SellerService, request: ServiceRequest, now: number): boolean {
    const backendSeconds = Math.ceil((service.backendTimeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS) / 1_000);
    return request.expiry - now < backendSeconds + RECEIPT_SECONDS;
  }

  /** The price of `service` in `epoch`, frozen and stored once the epoch is current. */
  private async priceFor(service: SellerService, epoch: number, current: number): Promise<bigint> {
    const stored = () => this.prices[service.serviceId]?.[String(epoch)];
    if (stored() !== undefined) return BigInt(stored()!);
    if (epoch !== current) return service.pricePerUnit;
    return this.lock.run('prices', async () => {
      if (stored() === undefined) await this.storePrice(service.serviceId, epoch, service.pricePerUnit);
      return BigInt(stored()!);
    });
  }

  /** Keep a price for an epoch on disk: written beside the prices file, synced, then renamed over it. Under the prices lock. */
  private async storePrice(serviceId: string, epoch: number, price: bigint): Promise<void> {
    const prices = { ...this.prices, [serviceId]: { ...this.prices[serviceId], [String(epoch)]: price.toString() } };
    await writeDurably(join(this.deps.dir, 'seller-prices.json'), `${JSON.stringify(prices, null, 2)}\n`);
    this.prices = prices;
  }

  private serviceOf(serviceId: string): SellerService {
    const service = this.services.get(serviceId.toLowerCase());
    if (!service) throw new Error(`this node sells no service ${serviceId}`);
    return service;
  }
}

function answerOf(call: ServedCall): ServeAnswer {
  return {
    ok: true, result: call.result, receipt: call.receipt, receiptSignature: call.receiptSignature, budgetIndex: call.budgetIndex,
    ...(call.usage ? { usage: call.usage } : {}),
  };
}

/** Why a backend stopped before it finished: an answer stopped so is its text alone. */
const CUT_SHORT: ReadonlySet<string> = new Set(['length', 'content_filter']);

/**
 * A completion as a served call's result, its output cut to `allowed` tokens: text, or the tools the model called.
 * A completion cut short is its text alone, as a tool call cut short is no call: cut here to the units the request
 * pays for, or stopped by its backend before the end (`length`, or `content_filter`), whose reason it keeps. A
 * completion its backend finished (`stop`, `tool_calls`, or no reason) returns its tool calls.
 */
function resultOf(completion: Completion, allowed: number): ServeResult {
  if (allowed < completion.completionTokens) {
    return { content: cutTo(completion.content ?? '', completion.completionTokens, allowed), finish_reason: 'length' };
  }
  const reason = completion.finishReason;
  if (reason && CUT_SHORT.has(reason)) return { content: completion.content ?? '', finish_reason: reason };
  if (completion.tool_calls) return { content: completion.content, tool_calls: completion.tool_calls, finish_reason: 'tool_calls' };
  return { content: completion.content };
}

/** The frozen prices a prices file holds: service id => epoch => wei per unit. `null` when it holds anything else. */
function pricesFrom(text: string): Record<string, Record<string, string>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isRecord(parsed)) return null;
  for (const byEpoch of Object.values(parsed)) {
    if (!isRecord(byEpoch)) return null;
    for (const [epoch, price] of Object.entries(byEpoch)) {
      if (!/^\d+$/.test(epoch) || typeof price !== 'string' || !/^\d+$/.test(price)) return null;
    }
  }
  return parsed as Record<string, Record<string, string>>;
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * The completion cut to `allowed` of its `counted` output tokens: the same
 * share of its characters, on character boundaries. A backend that kept to the
 * limit is not cut.
 */
export function cutTo(content: string, counted: number, allowed: number): string {
  if (allowed >= counted) return content;
  const chars = Array.from(content);
  return chars.slice(0, Math.floor((chars.length * allowed) / counted)).join('');
}

/** Whether a receipt is the one its signer signed for this request domain. Used by buyers. */
export function receiptSignerOf(domain: MarketplaceDomain, receipt: QueryInferenceReceipt, signature: string): string | null {
  try {
    return ethers.recoverAddress(hashQueryInferenceReceipt(domain, receipt), signature);
  } catch {
    return null;
  }
}

export type { EpochTimes };
