// SPDX-License-Identifier: Apache-2.0

/**
 * The seller (OT-RFC-27): a Core Node that serves its services to any buyer
 * whose subscription funds them, and signs a receipt for each call.
 *
 * - **The gate.** It serves only while it is a Core Node: it has a profile and
 *   a place in the sharding table, which takes the minimum stake. Read at every
 *   tick; until the first tick it serves nothing.
 * - **Prices.** A service's price per unit, in wei, is set per epoch. The
 *   current epoch's is frozen the first time it is used and kept on disk; the
 *   settings' price applies to epochs not frozen yet.
 * - **Offers.** At every tick it shares an offer for each service, for the
 *   current and the next epoch, into the Marketplace Context Graph.
 * - **Each call** is checked, cheapest check first, then
 *   served by the service's backend, cut to the units the request allows, and
 *   its receipt signed by an operational wallet. The call, its result and its
 *   receipt are on disk before the answer goes back; if that write fails, the
 *   answer is an error and no result. A repeat of a call already served gets
 *   the stored answer. Calls on one subscription run one at a time, so a
 *   nonce is claimed once and a budget's check counts every call before it.
 * - **The end of the epoch.** Within `stopServingSeconds` of it, new calls are
 *   refused: their receipts could not land in time.
 */
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import {
  QUERY_INFERENCE_RECEIPT_TYPES,
  SERVICE_CLASS_INFERENCE,
  hashQueryInferenceReceipt,
  hashServiceRequest,
  recoverSigner,
  type EpochTimes,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type QueryInferenceReceipt,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import { UpstreamError, type Connector } from './connector.js';
import { Journal, KeyedLock } from './journal.js';
import { offerQuads, type OfferQuad } from './offers.js';
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
  type ReceiptWire,
  type ServeAnswer,
  type ServeResponse,
  type ServiceRequestWire,
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
  /** The operational wallet that signs receipts. */
  signer: string;
  stopServingSeconds: number;
  tickSeconds: number;
  /** Shares quads into the Marketplace Context Graph's shared memory. */
  shareOffers?: (quads: OfferQuad[]) => Promise<void>;
  log?: (message: string) => void;
}

/** One served call, as the ledger keeps it. */
export interface ServedCall {
  requestDigest: string;
  subscriptionId: string;
  budgetIndex: number;
  /** The request as served: `seller` is this node's identity. */
  request: ServiceRequestWire;
  signature: string;
  receipt: ReceiptWire;
  receiptSignature: string;
  result: { content: string };
}

export class Seller {
  readonly services: ReadonlyMap<string, SellerService>;
  private readonly ledger: Journal<ServedCall>;
  private readonly lock = new KeyedLock();
  private readonly served = new Map<string, ServedCall>();
  private readonly nonces = new Map<string, Set<string>>();
  /** subscription id and budget index => the value of receipts not landed yet. */
  private readonly unlanded = new Map<string, bigint>();
  private prices: Record<string, Record<string, string>> = {};
  private identityId = 0n;
  private open = false;
  private domain: MarketplaceDomain | undefined;
  private shared = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;

  constructor(private readonly deps: SellerDeps) {
    this.services = new Map(deps.services.map((s) => [s.serviceId.toLowerCase(), s]));
    this.ledger = new Journal(join(deps.dir, 'seller-ledger.jsonl'));
  }

  /** The identity it serves as, and whether it serves now. */
  get gate(): { identityId: bigint; open: boolean } {
    return { identityId: this.identityId, open: this.open };
  }

  /** Read the ledger and the frozen prices. Call once before serving. */
  async load(): Promise<void> {
    for (const call of await this.ledger.read()) this.remember(call);
    try {
      this.prices = JSON.parse(await readFile(join(this.deps.dir, 'seller-prices.json'), 'utf8'));
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }
  }

  /** The gate, then the offers of the current and the next epoch. */
  async tick(): Promise<void> {
    const chain = this.deps.chain;
    this.identityId = await chain.getIdentityId();
    this.open = this.identityId > 0n && await chain.isShardingTableMember(this.identityId);
    this.domain ??= (await chain.getMarketplaceContracts()).requestDomain;
    if (!this.open || !this.deps.shareOffers) return;
    const times = await chain.getEpochTimes();
    const quads: OfferQuad[] = [];
    const keys: string[] = [];
    for (const epoch of [times.epoch, times.epoch + 1]) {
      for (const s of this.services.values()) {
        const price = await this.priceFor(s, epoch, times.epoch);
        const key = `${s.serviceId}:${epoch}:${price}`;
        if (this.shared.has(key)) continue;
        keys.push(key);
        quads.push(...offerQuads({
          seller: this.identityId, serviceId: s.serviceId, serviceClass: SERVICE_CLASS_INFERENCE, unit: 'token',
          pricePerUnit: price, epoch, capacity: s.capacity, model: s.model, provenance: s.provenance,
          ...(s.tokenizerBundle ? { tokenizerBundle: s.tokenizerBundle } : {}),
        }));
      }
    }
    if (quads.length === 0) return;
    await this.deps.shareOffers(quads);
    for (const key of keys) this.shared.add(key);
  }

  start(): void {
    if (this.timer) return;
    const run = () => {
      if (this.ticking) return;
      this.ticking = this.tick()
        .catch((err: unknown) => this.deps.log?.(`[marketplace] seller tick failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { this.ticking = undefined; });
    };
    run();
    this.timer = setInterval(run, this.deps.tickSeconds * 1_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
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
      this.deps.log?.(`[marketplace] a call could not be served: ${err instanceof Error ? err.message : String(err)}`);
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
    const before = this.served.get(requestDigest);
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
    const budgetKey = `${request.subscriptionId}:${budgetIndex}`;
    // One call at a time per subscription: its nonces are one set, whatever the budget.
    return this.lock.run(request.subscriptionId, async () => {
      // 6. A nonce new to the ledger. 7. Budget left, less this seller's receipts not landed, covers the call.
      if (this.nonces.get(request.subscriptionId)?.has(request.nonce.toString())) return refusal('NonceUsed');
      const left = await chain.budgetLeft(request.subscriptionId, budgetIndex);
      if (left - (this.unlanded.get(budgetKey) ?? 0n) < request.maxValueWei) return refusal('BudgetExhausted');
      return this.run(service, request, call, requestDigest, budgetIndex);
    });
  }

  /** Serve the call, cut to what it allows, sign its receipt and store it all before answering. */
  private async run(
    service: SellerService,
    request: ServiceRequest,
    call: { signature: string; body: InferenceBody },
    requestDigest: string,
    budgetIndex: number,
  ): Promise<ServeResponse> {
    const unitCap = minBig(request.maxUnits, request.maxValueWei / request.pricePerUnit);
    let completion;
    try {
      completion = await service.connector.complete({
        messages: call.body.messages,
        maxTokens: Number(minBig(BigInt(call.body.max_tokens), unitCap)),
      });
    } catch (err) {
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
      request: requestToWire(request),
      signature: call.signature,
      receipt: receiptToWire(receipt),
      receiptSignature,
      result: { content },
    };
    await this.ledger.append(served);
    this.remember(served);
    return answerOf(served);
  }

  private remember(call: ServedCall): void {
    this.served.set(call.requestDigest, call);
    const nonces = this.nonces.get(call.subscriptionId) ?? new Set<string>();
    nonces.add(call.request.nonce);
    this.nonces.set(call.subscriptionId, nonces);
    const key = `${call.subscriptionId}:${call.budgetIndex}`;
    this.unlanded.set(key, (this.unlanded.get(key) ?? 0n) + BigInt(call.receipt.valueWei));
  }

  /** The price of `service` in `epoch`, frozen and stored once the epoch is current. */
  private async priceFor(service: SellerService, epoch: number, current: number): Promise<bigint> {
    const stored = () => this.prices[service.serviceId]?.[String(epoch)];
    if (stored() !== undefined) return BigInt(stored()!);
    if (epoch !== current) return service.pricePerUnit;
    return this.lock.run('prices', async () => {
      if (stored() !== undefined) return BigInt(stored()!);
      const prices = { ...this.prices, [service.serviceId]: { ...this.prices[service.serviceId], [String(epoch)]: service.pricePerUnit.toString() } };
      await mkdir(this.deps.dir, { recursive: true });
      const file = join(this.deps.dir, 'seller-prices.json');
      await writeFile(`${file}.tmp`, `${JSON.stringify(prices, null, 2)}\n`, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      this.prices = prices;
      return service.pricePerUnit;
    });
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
