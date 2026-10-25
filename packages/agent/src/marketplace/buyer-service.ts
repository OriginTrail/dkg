/**
 * OT-RFC-27 marketplace buyer runtime: session-key lifecycle (persisted under
 * the node data dir), the non-refundable period subscription (one TRAC
 * `transferFrom` into the epoch pool via `chain.marketplaceFundSubscription`),
 * and the Marketplace Router invoke path — discover offers, probe live
 * quotes, `selectRoute` under the plan policy + local meter, sign a bounded
 * seller-specific authorization with the session key, serve the call
 * off-chain over `PROTOCOL_MARKETPLACE_SERVE`, verify the returned
 * seller-signed QueryInferenceReceipt, and settle the meter.
 *
 * The meter reserves the worst case (`maxUnits · ask`) at admission and only
 * settles the verified receipt value, so "remaining" is always safe against
 * in-flight calls; every failure voids the reservation. Routing keeps a local
 * delivery history per seller peer as the deterministic tie-break.
 */
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import {
  MARKETPLACE_SERVE_VERSION,
  PROTOCOL_MARKETPLACE_QUOTE,
  PROTOCOL_MARKETPLACE_SERVE,
  decodeMarketplaceQuoteResponse,
  decodeMarketplaceServeResponse,
  encodeMarketplaceQuoteRequest,
  encodeMarketplaceServeRequest,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter, TxResult } from '@origintrail-official/dkg-chain';
import {
  BuyerMeter,
  createSessionKey,
  loadSessionKey,
  persistSessionKey,
  selectRoute,
  signAuthorization,
  verifyReceiptAgainstAuthorization,
  type BoundedAuthorization,
  type DeliveryStats,
  type MarketplaceOffer,
  type MarketplaceQuote,
  type MarketplaceServiceType,
  type MeterState,
  type PlanPolicy,
  type QueryInferenceReceipt,
  type RouteFailureReason,
  type RouteRejection,
  type SessionKeyRecord,
} from '@origintrail-official/dkg-marketplace';
import type { MarketplaceOfferSource } from './offer-publisher.js';
import type { MarketplaceLogger, MarketplaceMessenger } from './seller-service.js';

export class MarketplaceNotSubscribedError extends Error {
  constructor() {
    super('marketplace: no active subscription — call subscribe() first');
    this.name = 'MarketplaceNotSubscribedError';
  }
}

/** The router found no admissible seller; `rejections` carry the full fault picture. */
export class MarketplaceRouteError extends Error {
  constructor(
    readonly reason: RouteFailureReason,
    readonly rejections: RouteRejection[],
  ) {
    super(
      `marketplace: no route (${reason})${rejections.length > 0
        ? ` — rejected: ${rejections.map((r) => `${r.offerId}:${r.reason}`).join(', ')}`
        : ''}${reason === 'no-offers'
        ? ' — discovery returned no offers (is this node synced to the marketplace context graph?)'
        : ''}`,
    );
    this.name = 'MarketplaceRouteError';
  }
}

/** The selected seller failed the call (transport, errorCode, or bad receipt). */
export class MarketplaceInvokeError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`marketplace: invoke failed (${code}): ${detail}`);
    this.name = 'MarketplaceInvokeError';
  }
}

export interface MarketplaceBuyerDeps {
  messenger: MarketplaceMessenger;
  chain: ChainAdapter;
  /** Funding wallet — the on-chain `msg.sender` of `fundSubscription`. */
  resolveBuyerAddress: () => Promise<string>;
  offerSource: MarketplaceOfferSource;
  /**
   * Idempotently (re)subscribe this node to the `marketplace` context graph so
   * SWM-shared offer KAs sync into the local store the offer source queries.
   * Invoked before every discovery: a subscription that could not install at
   * startup, or a CG a seller creates only later, converges on the next call.
   */
  ensureOfferSubscription?: () => void;
  /**
   * Fire-and-forget backfill nudge, invoked when discovery finds NO offers:
   * the periodic sync reconciler treats recently-synced peers as fresh, so a
   * node whose first marketplace sync raced the CG's authority bootstrap
   * would otherwise stay empty until the staleness window expires. The
   * implementation throttles itself and contains its own failures.
   */
  requestOfferBackfill?: () => void;
  log: MarketplaceLogger;
  /**
   * Where the session key persists (JSON, mode 0o600). Omitted → an
   * ephemeral in-memory key with a warning; fine for tests, not for nodes.
   */
  sessionKeyPath?: string;
  /** Injectable unix-seconds clock (authorization expiry + offer staleness). */
  nowSeconds?: () => number;
  /** Authorization validity window. Default 600s. */
  authTtlSeconds?: number;
  /** Per-request cap on live quote probes. Default 8. */
  maxQuoteProbes?: number;
  quoteTimeoutMs?: number;
  serveTimeoutMs?: number;
}

export interface MarketplaceSubscribeResult {
  epoch: bigint;
  sessionKeyAddress: string;
  tx: TxResult;
}

export interface MarketplaceInvokeResult {
  /** Executor output parsed from the result JSON bytes. */
  result: unknown;
  resultBytes: Uint8Array;
  receipt: QueryInferenceReceipt;
  authorization: BoundedAuthorization;
  seller: { peerId: string; identityId: bigint; address: string };
  servedUnits: bigint;
  costWei: bigint;
}

const DEFAULT_AUTH_TTL_SECONDS = 600;
const DEFAULT_MAX_QUOTE_PROBES = 8;

interface ActivePlan {
  epoch: bigint;
  policy: PlanPolicy;
  meter: BuyerMeter;
}

export class MarketplaceBuyerService {
  readonly #deps: MarketplaceBuyerDeps;
  readonly #nowSeconds: () => number;
  readonly #deliveryHistory = new Map<string, DeliveryStats>();
  #sessionKey: SessionKeyRecord | undefined;
  #plan: ActivePlan | undefined;

  constructor(deps: MarketplaceBuyerDeps) {
    this.#deps = deps;
    this.#nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Load or mint the persisted session key. */
  ensureSessionKey(): SessionKeyRecord {
    if (this.#sessionKey) return this.#sessionKey;
    const path = this.#deps.sessionKeyPath;
    if (!path) {
      this.#deps.log.warn('[marketplace] no data dir — using an EPHEMERAL session key (lost on restart)');
      this.#sessionKey = createSessionKey();
      return this.#sessionKey;
    }
    try {
      this.#sessionKey = loadSessionKey(path);
    } catch {
      this.#sessionKey = createSessionKey();
      persistSessionKey(path, this.#sessionKey);
      this.#deps.log.info(`[marketplace] minted session key ${this.#sessionKey.address} → ${path}`);
    }
    return this.#sessionKey;
  }

  /**
   * Fund a non-refundable period subscription and (re)register the session
   * key. A new call replaces the local plan/meter — add funds for the same
   * epoch by subscribing again with the fresh policy.
   */
  async subscribe(opts: { amountWei: bigint; policy: PlanPolicy; epoch?: bigint }): Promise<MarketplaceSubscribeResult> {
    const { chain } = this.#deps;
    if (chain.supportsMarketplace?.() !== true || typeof chain.marketplaceFundSubscription !== 'function') {
      throw new Error('marketplace: chain adapter does not support marketplace settlement');
    }
    const epoch = opts.epoch ?? (await chain.getCurrentEpoch?.()) ?? undefined;
    if (epoch === undefined) {
      throw new Error('marketplace: cannot resolve the current epoch; pass `epoch` explicitly');
    }
    const sessionKey = this.ensureSessionKey();
    const tx = await chain.marketplaceFundSubscription({
      amountWei: opts.amountWei,
      sessionKey: sessionKey.address,
      epoch,
    });
    this.#plan = { epoch, policy: opts.policy, meter: new BuyerMeter(opts.policy) };
    this.#deps.log.info(
      `[marketplace] funded subscription: epoch=${epoch} amountWei=${opts.amountWei} sessionKey=${sessionKey.address}`,
    );
    return { epoch, sessionKeyAddress: sessionKey.address, tx };
  }

  async discoverOffers(): Promise<MarketplaceOffer[]> {
    this.#deps.ensureOfferSubscription?.();
    const offers = await this.#deps.offerSource.discoverOffers();
    if (offers.length === 0) this.#deps.requestOfferBackfill?.();
    return offers;
  }

  async invoke(opts: {
    serviceType: MarketplaceServiceType;
    modelId?: string;
    /** JSON payload the executor consumes (`{ prompt }` / `{ sparql }`). */
    payload: Record<string, unknown>;
    maxUnits: bigint;
  }): Promise<MarketplaceInvokeResult> {
    const plan = this.#plan;
    if (!plan) throw new MarketplaceNotSubscribedError();
    const sessionKey = this.ensureSessionKey();
    const nowSeconds = this.#nowSeconds();

    const offers = await this.discoverOffers();
    const quotes = await this.#probeQuotes(offers, opts.serviceType, opts.modelId, nowSeconds);
    const decision = selectRoute(offers, quotes, plan.policy, plan.meter.snapshot(), {
      serviceType: opts.serviceType,
      modelId: opts.modelId,
      maxUnits: opts.maxUnits,
      nowSeconds,
      deliveryHistory: this.#deliveryHistory,
    });
    if (!decision.ok) throw new MarketplaceRouteError(decision.reason, decision.rejections);
    const { offer } = decision;
    // Fail closed BEFORE reserving: without the seller's receipt-signing
    // wallet on the offer the returned receipt can never be verified.
    if (!offer.sellerAddress) {
      throw new MarketplaceInvokeError('NO_SELLER_ADDRESS', `offer ${offer.offerId} carries no mkt:sellerAddress`);
    }

    const chainId = await this.#deps.chain.getEvmChainId();
    const marketplaceAddress = await this.#deps.chain.marketplaceGetAddress?.();
    if (!marketplaceAddress) {
      throw new MarketplaceInvokeError('NO_MARKETPLACE_ADDRESS', 'chain adapter reports no Marketplace contract');
    }
    const callId = ethers.hexlify(randomBytes(32));
    const authorization = await signAuthorization(sessionKey, {
      chainId,
      marketplaceAddress,
      buyer: await this.#deps.resolveBuyerAddress(),
      sellerIdentityId: offer.sellerIdentityId,
      offeringId: offer.offeringId,
      callId,
      epoch: plan.epoch,
      maxUnits: opts.maxUnits,
      askPerUnitWei: decision.askPerUnitWei,
      expiry: BigInt(nowSeconds + (this.#deps.authTtlSeconds ?? DEFAULT_AUTH_TTL_SECONDS)),
    });

    plan.meter.reserve(decision.bucketIndex, callId, decision.worstCaseCostWei);
    try {
      const invokeResult = await this.#serve(offer, authorization, opts.payload);
      plan.meter.settle(callId, invokeResult.costWei);
      this.#recordDelivery(offer.sellerPeerId, true);
      return invokeResult;
    } catch (error) {
      plan.meter.voidReservation(callId);
      this.#recordDelivery(offer.sellerPeerId, false);
      throw error;
    }
  }

  async #probeQuotes(
    offers: readonly MarketplaceOffer[],
    serviceType: MarketplaceServiceType,
    modelId: string | undefined,
    nowSeconds: number,
  ): Promise<MarketplaceQuote[]> {
    const probes: Array<{ offer: MarketplaceOffer }> = [];
    const seen = new Set<string>();
    for (const offer of offers) {
      if (offer.serviceType !== serviceType) continue;
      if (modelId !== undefined && offer.modelId !== modelId) continue;
      if (offer.expiresAt !== undefined && offer.expiresAt <= nowSeconds) continue;
      const key = `${offer.sellerPeerId}:${offer.offeringId.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      probes.push({ offer });
      if (probes.length >= (this.#deps.maxQuoteProbes ?? DEFAULT_MAX_QUOTE_PROBES)) break;
    }
    const quotes = await Promise.all(probes.map(async ({ offer }) => this.#probeQuote(offer)));
    return quotes.filter((quote): quote is MarketplaceQuote => quote !== undefined);
  }

  async #probeQuote(offer: MarketplaceOffer): Promise<MarketplaceQuote | undefined> {
    try {
      const sent = await this.#deps.messenger.sendReliable(
        offer.sellerPeerId,
        PROTOCOL_MARKETPLACE_QUOTE,
        encodeMarketplaceQuoteRequest({ offeringId: ethers.getBytes(offer.offeringId) }),
        this.#deps.quoteTimeoutMs !== undefined ? { timeoutMs: this.#deps.quoteTimeoutMs } : undefined,
      );
      if (!sent.delivered) return undefined;
      const response = decodeMarketplaceQuoteResponse(sent.response);
      if (!response.available || !response.askPerUnitWei) {
        this.#deps.log.info(
          `[marketplace] quote declined by ${offer.sellerPeerId} for ${offer.offeringId}: ${response.declineCode ?? 'unavailable'}`,
        );
        return {
          offeringId: offer.offeringId,
          sellerIdentityId: offer.sellerIdentityId,
          available: false,
          askPerUnitWei: 0n,
        };
      }
      const capacity = response.capacityUnitsPerMin === undefined
        ? undefined
        : BigInt(response.capacityUnitsPerMin.toString());
      return {
        offeringId: offer.offeringId,
        sellerIdentityId: offer.sellerIdentityId,
        available: true,
        askPerUnitWei: BigInt(response.askPerUnitWei),
        ...(capacity !== undefined && capacity > 0n ? { capacityUnitsPerMin: capacity } : {}),
      };
    } catch (error) {
      this.#deps.log.warn(
        `[marketplace] quote probe to ${offer.sellerPeerId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  async #serve(
    offer: MarketplaceOffer,
    authorization: BoundedAuthorization,
    payload: Record<string, unknown>,
  ): Promise<MarketplaceInvokeResult> {
    const request = encodeMarketplaceServeRequest({
      version: MARKETPLACE_SERVE_VERSION,
      buyer: ethers.getBytes(authorization.buyer),
      sellerIdentityId: authorization.sellerIdentityId.toString(),
      offeringId: ethers.getBytes(authorization.offeringId),
      callId: ethers.getBytes(authorization.callId),
      epoch: authorization.epoch,
      maxUnits: authorization.maxUnits,
      askPerUnitWei: authorization.askPerUnitWei.toString(),
      expiry: authorization.expiry,
      authSignature: ethers.getBytes(authorization.signature),
      payloadKind: offer.serviceType === 'query' ? 'query' : 'inference',
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    });
    const sent = await this.#deps.messenger.sendReliable(
      offer.sellerPeerId,
      PROTOCOL_MARKETPLACE_SERVE,
      request,
      this.#deps.serveTimeoutMs !== undefined ? { timeoutMs: this.#deps.serveTimeoutMs } : undefined,
    );
    if (!sent.delivered) {
      throw new MarketplaceInvokeError('NOT_DELIVERED', sent.error ?? 'serve request not delivered');
    }
    const response = decodeMarketplaceServeResponse(sent.response);
    if (!response.ok) {
      throw new MarketplaceInvokeError(response.errorCode ?? 'SELLER_ERROR', `seller ${offer.sellerPeerId} refused`);
    }
    if (
      !response.resultCommitment || response.resultCommitment.byteLength !== 32
      || !response.sellerSignature || response.sellerSignature.byteLength !== 65
      || !response.authDigest || response.authDigest.byteLength !== 32
      || !response.receiptValueWei || !response.result
    ) {
      throw new MarketplaceInvokeError('MALFORMED_RECEIPT', 'serve response is missing receipt fields');
    }
    const receipt: QueryInferenceReceipt = {
      authDigest: ethers.hexlify(response.authDigest),
      servedUnits: BigInt((response.servedUnits ?? 0).toString()),
      receiptValueWei: BigInt(response.receiptValueWei),
      resultCommitment: ethers.hexlify(response.resultCommitment),
      sellerSig: ethers.hexlify(response.sellerSignature),
    };
    if (receipt.authDigest !== authorization.authDigest) {
      throw new MarketplaceInvokeError('MALFORMED_RECEIPT', 'receipt settles a different authorization');
    }
    const verification = verifyReceiptAgainstAuthorization(receipt, authorization, {
      // invoke() fails closed earlier when the offer has no sellerAddress.
      sellerAddress: offer.sellerAddress as string,
      resultBytes: response.result,
    });
    if (!verification.ok) {
      throw new MarketplaceInvokeError('BAD_RECEIPT', verification.errors.join('; '));
    }
    let result: unknown;
    try {
      result = JSON.parse(new TextDecoder().decode(response.result));
    } catch {
      throw new MarketplaceInvokeError('MALFORMED_RESULT', 'result bytes are not valid JSON');
    }
    return {
      result,
      resultBytes: response.result,
      receipt,
      authorization,
      seller: {
        peerId: offer.sellerPeerId,
        identityId: offer.sellerIdentityId,
        address: offer.sellerAddress as string,
      },
      servedUnits: receipt.servedUnits,
      costWei: receipt.receiptValueWei,
    };
  }

  #recordDelivery(sellerPeerId: string, success: boolean): void {
    const stats = this.#deliveryHistory.get(sellerPeerId) ?? { successes: 0, failures: 0 };
    if (success) stats.successes += 1;
    else stats.failures += 1;
    this.#deliveryHistory.set(sellerPeerId, stats);
  }

  /** The RFC's one-line meter: `used · remaining · resets`. */
  meterSummary(): string | undefined {
    return this.#plan?.meter.meterSummary();
  }

  meterState(): MeterState | undefined {
    return this.#plan?.meter.snapshot();
  }

  status(): {
    subscribed: boolean;
    epoch?: bigint;
    sessionKeyAddress?: string;
    meter?: MeterState;
  } {
    return {
      subscribed: this.#plan !== undefined,
      ...(this.#plan ? { epoch: this.#plan.epoch, meter: this.#plan.meter.snapshot() } : {}),
      ...(this.#sessionKey ? { sessionKeyAddress: this.#sessionKey.address } : {}),
    };
  }

  /** The funded epoch of the active plan (settle rail default). */
  activeEpoch(): bigint | undefined {
    return this.#plan?.epoch;
  }
}
