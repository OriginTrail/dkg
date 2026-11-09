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
 *   its receipt signed by an operational wallet. The call, its result and its
 *   receipt are in the ledger before the answer goes back; if that write fails,
 *   the answer is an error and no result. A repeat of a call already served
 *   gets the stored answer. Calls on one subscription run one at a time, so a
 *   nonce is claimed once and a budget's check counts every call before it.
 * - **The end of the epoch.** Within `stopServingSeconds` of it, new calls are
 *   refused: their receipts could not land in time.
 * - **The job.** Ticks every `tickSeconds` from the epoch's start, and once
 *   more `finalLandingSeconds` before its end: the gate, then the offer job
 *   started beside landing, each on its own, so one failing leaves the others.
 *   A tick that fails as a whole is tried again soon, and never past the final
 *   tick.
 */
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
import { UpstreamError, type Connector } from './connector.js';
import { KeyedLock } from './journal.js';
import { DEFAULT_LANDING, Lander, nextLandingAt, secondsToNextTick, secondsToRetry, type LandingReport, type LandingSettings } from './landing.js';
import { SellerLedger, type ServedCall } from './ledger.js';
import { OfferJob, type OfferAssets } from './offer-job.js';
import {
  WireError,
  quoteRequestFromWire,
  receiptToWire,
  refusal,
  requestToWire,
  resultCommitmentOf,
  serveRequestFromWire,
  type InferenceBody,
  type QuoteResponse,
  type ServeAnswer,
  type ServeResponse,
} from './wire.js';

/** New calls stop this long before an epoch ends. */
export const DEFAULT_STOP_SERVING_SECONDS = 180;

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
  /** service id => whether its backend answered the last call. */
  private readonly backends = new Map<string, 'up' | 'down'>();
  /** The chain's time as the last tick read it, and when, by this host's clock. */
  private lastTimes: { times: EpochTimes; at: number } | undefined;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking: Promise<void> | undefined;

  constructor(private readonly deps: SellerDeps) {
    this.services = new Map(deps.services.map((s) => [s.serviceId.toLowerCase(), s]));
    this.landing = deps.landing ?? DEFAULT_LANDING;
    this.ledger = new SellerLedger(deps.dir);
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
    return this.backends.get(serviceId.toLowerCase()) ?? 'up';
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

  /** Read the ledger, the frozen prices and the offers published. Call once before serving. */
  async load(): Promise<void> {
    await this.ledger.load();
    await this.offers?.load();
    try {
      this.prices = JSON.parse(await readFile(join(this.deps.dir, 'seller-prices.json'), 'utf8'));
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }
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
      offers.push({ serviceId: s.serviceId, pricePerUnit: (await this.priceFor(s, times.epoch, times.epoch)).toString(), available, capacity: s.capacity });
    }
    return { seller: this.identityId.toString(), epoch: times.epoch, offers };
  }

  // -------------------------------------------------------------- serve

  /** Answer a `serve` message: the result and its receipt, or a refusal. Never throws. */
  async serve(raw: unknown): Promise<ServeResponse> {
    try {
      return await this.checkAndServe(raw);
    } catch (err) {
      this.deps.log?.(`[marketplace] a call could not be served: ${messageOf(err)}`);
      return refusal('Unavailable');
    }
  }

  private async checkAndServe(raw: unknown): Promise<ServeResponse> {
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
    const before = this.ledger.served(requestDigest);
    if (before) return before.signature === call.signature ? answerOf(before) : refusal('BadSignature');

    const chain = this.deps.chain;
    const times = await chain.getEpochTimes();
    // 1. Not too near the epoch's end, at this epoch's price.
    if (times.endsAt - times.now <= this.deps.stopServingSeconds) return refusal('EpochEnding');
    const service = this.services.get(request.serviceId);
    if (!service) return refusal('UnknownService');
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
    // 4. Issued within the subscription, and not expired.
    if (request.issuedAt < subscription.startsAt || request.issuedAt > times.now) return refusal('NotYetValid');
    if (times.now >= request.expiry) return refusal('Expired');
    // 5. For an account's subscription, issued while the grant it was funded under lasts.
    if (subscription.accountId !== 0n) {
      const end = await chain.grantEnd(subscription.accountId, subscription.buyer, subscription.grantNonce);
      if (request.issuedAt >= end) return refusal('GrantEnded');
    }
    // One call at a time per subscription: its nonces are one set, whatever the budget.
    return this.lock.run(request.subscriptionId, async () => {
      // 6. A nonce new to the ledger. 7. Budget left, less this seller's receipts not landed, covers the call.
      if (this.ledger.nonceUsed(request.subscriptionId, request.nonce.toString())) return refusal('NonceUsed');
      const left = await chain.budgetLeft(request.subscriptionId, budgetIndex);
      if (left - this.ledger.unlanded(request.subscriptionId, budgetIndex) < request.maxValueWei) return refusal('BudgetExhausted');
      return this.run(service, request, call, requestDigest, budgetIndex, times.epoch);
    });
  }

  /** Serve the call, cut to what it allows, sign its receipt and store it all before answering. */
  private async run(
    service: SellerService,
    request: ServiceRequest,
    call: { signature: string; body: InferenceBody },
    requestDigest: string,
    budgetIndex: number,
    epoch: number,
  ): Promise<ServeResponse> {
    const unitCap = minBig(request.maxUnits, request.maxValueWei / request.pricePerUnit);
    let completion;
    try {
      completion = await service.connector.complete({
        messages: call.body.messages,
        maxTokens: Number(minBig(BigInt(call.body.max_tokens), unitCap)),
      });
      this.backends.set(service.serviceId, 'up');
    } catch (err) {
      this.backends.set(service.serviceId, 'down');
      // The backend's detail (a missing key's variable, an address) stays in the log.
      this.deps.log?.(`[marketplace] the backend of ${service.model} failed: ${err instanceof UpstreamError ? err.message : String(err)}`);
      return refusal('UpstreamError');
    }
    const input = BigInt(completion.promptTokens);
    if (input >= unitCap) return refusal('UnitsTooFew');
    const output = minBig(BigInt(completion.completionTokens), unitCap - input);
    const content = cutTo(completion.content, completion.completionTokens, Number(output));
    const units = input + output;
    const receipt: QueryInferenceReceipt = {
      requestDigest,
      resultCommitment: resultCommitmentOf(content),
      units,
      valueWei: units * request.pricePerUnit,
      completedAt: Math.max((await this.deps.chain.getEpochTimes()).now, request.issuedAt),
    };
    const receiptSignature = await this.deps.chain.signTypedDataAs(this.deps.signer, this.domain!, QUERY_INFERENCE_RECEIPT_TYPES, { ...receipt });
    const served: ServedCall = {
      requestDigest,
      subscriptionId: request.subscriptionId,
      budgetIndex,
      epoch,
      request: requestToWire(request),
      signature: call.signature,
      receipt: receiptToWire(receipt),
      receiptSignature,
      result: { content },
    };
    await this.ledger.recordServed(served);
    return answerOf(served);
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

  /** Keep a price for an epoch on disk: written beside the prices file, then renamed over it. Under the prices lock. */
  private async storePrice(serviceId: string, epoch: number, price: bigint): Promise<void> {
    const prices = { ...this.prices, [serviceId]: { ...this.prices[serviceId], [String(epoch)]: price.toString() } };
    await mkdir(this.deps.dir, { recursive: true });
    const file = join(this.deps.dir, 'seller-prices.json');
    await writeFile(`${file}.tmp`, `${JSON.stringify(prices, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    this.prices = prices;
  }

  private serviceOf(serviceId: string): SellerService {
    const service = this.services.get(serviceId.toLowerCase());
    if (!service) throw new Error(`this node sells no service ${serviceId}`);
    return service;
  }
}

function answerOf(call: ServedCall): ServeAnswer {
  return { ok: true, result: call.result, receipt: call.receipt, receiptSignature: call.receiptSignature, budgetIndex: call.budgetIndex };
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
