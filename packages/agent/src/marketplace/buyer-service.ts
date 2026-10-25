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
 * in-flight calls. Failure settlement follows what is KNOWN about delivery:
 * a definitive non-delivery or seller refusal voids immediately; a response
 * that proves the seller served but cannot be verified settles pessimistically
 * at the reserved worst case (the seller can still claim); an AMBIGUOUS
 * transport failure (timeout mid-flight) holds the reservation until the
 * authorization expiry passes, then voids — the seller may have served and
 * may still claim until then. Serve/quote requests go over the messenger's
 * request-owned send, never the durable outbox, so a "failed" call can never
 * be silently retried-and-served later behind the meter's back.
 *
 * Receipt trust is resolved ON-CHAIN: the receipt signer recovered from
 * `sellerSig` must resolve (IdentityStorage) to the AUTHORIZED
 * `sellerIdentityId` — the offer's RDF-published `sellerAddress` is an
 * unauthenticated routing hint and is never trusted for verification.
 * Delivery history is keyed by seller identityId for the same reason.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  SoftCeilingExceededError,
  computeReceiptDigest,
  createSessionKey,
  eip191RecoverDigest,
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
import { rememberBounded } from '../bounded-map.js';
import { createChainClock, type ChainClock } from './chain-clock.js';
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

/**
 * What is KNOWN about delivery when an invoke fails — it decides how the
 * meter reservation resolves:
 *  - `not-served`: the seller provably did not serve (definitive non-delivery
 *    or an explicit refusal errorCode) → void immediately.
 *  - `served`: the seller responded ok (it holds a claimable receipt) but the
 *    result/receipt could not be trusted → settle pessimistically at the
 *    reserved worst case.
 *  - `ambiguous`: the request may or may not have reached the seller
 *    (timeout mid-flight) → hold the reservation until the authorization
 *    expiry passes, then void.
 */
export type MarketplaceDeliveryState = 'not-served' | 'served' | 'ambiguous';

/** The selected seller failed the call (transport, errorCode, or bad receipt). */
export class MarketplaceInvokeError extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly delivery: MarketplaceDeliveryState = 'not-served',
  ) {
    super(`marketplace: invoke failed (${code}): ${detail}`);
    this.name = 'MarketplaceInvokeError';
  }
}

/**
 * Transport errors that PROVE the request never reached the seller (dial /
 * address-resolution failures happen before any bytes go out). Anything else
 * — timeouts, stream resets, unknown faults — is ambiguous: the seller may
 * have received, served and enqueued a claim while the response was lost.
 */
const DEFINITE_NON_DELIVERY_PATTERNS = [
  'no valid addresses',
  'all multiaddr dials failed',
  'no_reservation',
  'econnrefused',
  'protocol selection failed',
  'no route to', // in-process test router double
  'no handler for', // remote never registered the marketplace protocols
];

function isDefinitelyUndelivered(message: string): boolean {
  const lower = message.toLowerCase();
  return DEFINITE_NON_DELIVERY_PATTERNS.some((needle) => lower.includes(needle));
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

/** A reservation held through an ambiguous failure, voidable once expired. */
interface DeferredVoid {
  meter: BuyerMeter;
  callId: string;
  /** Chain-time unix seconds (the authorization's expiry). */
  expirySeconds: bigint;
}

/** Bound on cached receipt-signer → identityId resolutions. */
const SIGNER_IDENTITY_CACHE_BOUND = 1_024;
const MAX_TIMEOUT_MS = 2_147_483_647;

export class MarketplaceBuyerService {
  readonly #deps: MarketplaceBuyerDeps;
  readonly #nowSeconds: () => number;
  readonly #chainClock: ChainClock;
  /** Keyed by seller identityId (decimal string) — see the header note. */
  readonly #deliveryHistory = new Map<string, DeliveryStats>();
  /** Receipt signer address (lowercase) → resolved on-chain identityId. */
  readonly #signerIdentityCache = new Map<string, bigint>();
  /** Reservations surviving ambiguous failures until their expiry passes. */
  #deferredVoids: DeferredVoid[] = [];
  #sessionKey: SessionKeyRecord | undefined;
  #plan: ActivePlan | undefined;

  constructor(deps: MarketplaceBuyerDeps) {
    this.#deps = deps;
    this.#nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.#chainClock = createChainClock({
      chain: deps.chain,
      localNowSeconds: () => this.#nowSeconds(),
      warn: (message) => deps.log.warn(message),
    });
  }

  /**
   * Load or mint the persisted session key. Minting happens ONLY when the
   * file does not exist (`ENOENT`): any other load failure (corruption,
   * permissions) rethrows, because silently overwriting a possibly
   * on-chain-registered key would strand every funded bucket bound to it.
   * The in-memory key is assigned only after the (atomic) persist succeeded,
   * so a persist failure never leaves an unrecoverable key signing in memory.
   */
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
      return this.#sessionKey;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new Error(
          `marketplace: session key file ${path} failed to load — refusing to mint a replacement over a `
          + `possibly-registered key (fix or remove the file): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const minted = createSessionKey();
    if (existsSync(path)) {
      // Can only happen when the file appeared between the ENOENT and now.
      this.#deps.log.warn(
        `[marketplace] session key file ${path} appeared mid-mint — REPLACING it with ${minted.address}; `
        + 'any key registered from the replaced file can no longer sign',
      );
    }
    persistSessionKey(path, minted);
    this.#sessionKey = minted;
    this.#deps.log.info(`[marketplace] minted session key ${minted.address} → ${path}`);
    return minted;
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
    this.releaseExpiredReservations();
    const sessionKey = this.ensureSessionKey();
    const nowSeconds = this.#nowSeconds();

    const offers = await this.discoverOffers();
    const quotes = await this.#probeQuotes(offers, opts.serviceType, opts.modelId, nowSeconds);
    const decision = selectRoute(offers, quotes, plan.policy, plan.meter.snapshot(), {
      serviceType: opts.serviceType,
      modelId: opts.modelId,
      maxUnits: opts.maxUnits,
      nowSeconds,
      deliveryHistory: this.#deliveryHistoryByPeer(offers),
    });
    if (!decision.ok) throw new MarketplaceRouteError(decision.reason, decision.rejections);
    const { offer } = decision;

    const chainId = await this.#deps.chain.getEvmChainId();
    const marketplaceAddress = await this.#deps.chain.marketplaceGetAddress?.();
    if (!marketplaceAddress) {
      throw new MarketplaceInvokeError('NO_MARKETPLACE_ADDRESS', 'chain adapter reports no Marketplace contract');
    }
    const callId = ethers.hexlify(randomBytes(32));
    // Expiry is CHAIN time: the contract checks it against block.timestamp,
    // and devnet/drifted chain time can sit far from this host's wall clock.
    const chainNowSeconds = await this.#chainClock.nowSeconds();
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
      expiry: chainNowSeconds + BigInt(this.#deps.authTtlSeconds ?? DEFAULT_AUTH_TTL_SECONDS),
    });

    try {
      plan.meter.reserve(decision.bucketIndex, callId, decision.worstCaseCostWei);
    } catch (error) {
      if (error instanceof SoftCeilingExceededError) {
        // A concurrent call reserved between this call's route check and now.
        throw new MarketplaceRouteError('no-eligible-offer', [{ offerId: offer.offerId, reason: 'soft-ceiling' }]);
      }
      throw error;
    }
    try {
      const invokeResult = await this.#serve(offer, authorization, opts.payload);
      plan.meter.settle(callId, invokeResult.costWei);
      this.#recordDelivery(offer.sellerIdentityId, true);
      return invokeResult;
    } catch (error) {
      this.#recordDelivery(offer.sellerIdentityId, false);
      this.#resolveFailedReservation(plan.meter, callId, decision.worstCaseCostWei, authorization.expiry, error);
      throw error;
    }
  }

  /**
   * Resolve the meter reservation of a failed call by delivery knowledge:
   * provably-not-served voids now; provably-served settles the worst case
   * (the seller holds a claimable receipt); anything ambiguous HOLDS the
   * reservation until the authorization expiry passes — only then is the
   * exposure provably dead on-chain and safe to void.
   */
  #resolveFailedReservation(
    meter: BuyerMeter,
    callId: string,
    worstCaseCostWei: bigint,
    expirySeconds: bigint,
    error: unknown,
  ): void {
    const delivery = error instanceof MarketplaceInvokeError ? error.delivery : 'ambiguous';
    if (delivery === 'not-served') {
      meter.voidReservation(callId);
      return;
    }
    if (delivery === 'served') {
      meter.settle(callId, worstCaseCostWei);
      return;
    }
    this.#deferredVoids.push({ meter, callId, expirySeconds });
    this.#deps.log.warn(
      `[marketplace] call ${callId} failed with delivery state unknown — holding the ${worstCaseCostWei} wei `
      + `reservation until the authorization expires at ${expirySeconds}`,
    );
    // Best-effort wall-clock sweep so the hold releases without further calls;
    // releaseExpiredReservations() is the deterministic path (and test seam).
    const delayMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1_000, Number(expirySeconds - this.#chainClock.nowSecondsSync() + 2n) * 1000),
    );
    const timer = setTimeout(() => this.releaseExpiredReservations(), delayMs);
    timer.unref?.();
  }

  /** Void every held reservation whose authorization expiry has passed. */
  releaseExpiredReservations(): number {
    const nowSeconds = this.#chainClock.nowSecondsSync();
    const remaining: DeferredVoid[] = [];
    let released = 0;
    for (const entry of this.#deferredVoids) {
      if (entry.expirySeconds >= nowSeconds) {
        remaining.push(entry);
        continue;
      }
      try {
        entry.meter.voidReservation(entry.callId);
        released += 1;
        this.#deps.log.info(
          `[marketplace] released the held reservation for ${entry.callId} (authorization expired)`,
        );
      } catch {
        // Already settled/voided through another path — nothing held anymore.
      }
    }
    this.#deferredVoids = remaining;
    return released;
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
      // Request-owned: a quote probe must never park in the durable outbox
      // and get retried hours later against a long-gone routing decision.
      const sent = await this.#deps.messenger.sendRequestOwned(
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
    // Request-owned send: it either completes on the wire or throws — the
    // durable outbox must never retry a serve in the background after the
    // meter already resolved this call (the seller would serve + claim with
    // nothing reserved). A throw that proves the dial never reached the
    // seller voids immediately; everything else stays ambiguous.
    let sent;
    try {
      sent = await this.#deps.messenger.sendRequestOwned(
        offer.sellerPeerId,
        PROTOCOL_MARKETPLACE_SERVE,
        request,
        this.#deps.serveTimeoutMs !== undefined ? { timeoutMs: this.#deps.serveTimeoutMs } : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDefinitelyUndelivered(message)) {
        throw new MarketplaceInvokeError('NOT_DELIVERED', message, 'not-served');
      }
      throw new MarketplaceInvokeError('DELIVERY_UNKNOWN', `serve transport failed mid-flight: ${message}`, 'ambiguous');
    }
    if (!sent.delivered) {
      // Request-owned sends never queue; this is the in-flight dedup shape —
      // another attempt owns the wire, so the outcome is unknown here.
      throw new MarketplaceInvokeError('DELIVERY_UNKNOWN', sent.error ?? 'serve request state unknown', 'ambiguous');
    }
    const response = decodeMarketplaceServeResponse(sent.response);
    if (!response.ok) {
      // An explicit refusal: the seller rejected BEFORE serving — no claim exists.
      throw new MarketplaceInvokeError(
        response.errorCode ?? 'SELLER_ERROR', `seller ${offer.sellerPeerId} refused`, 'not-served',
      );
    }
    // From here on the seller HAS served (ok response): failures settle
    // pessimistically, because a claim for this authorization exists.
    if (
      !response.resultCommitment || response.resultCommitment.byteLength !== 32
      || !response.sellerSignature || response.sellerSignature.byteLength !== 65
      || !response.authDigest || response.authDigest.byteLength !== 32
      || !response.receiptValueWei || !response.result
    ) {
      throw new MarketplaceInvokeError('MALFORMED_RECEIPT', 'serve response is missing receipt fields', 'served');
    }
    const receipt: QueryInferenceReceipt = {
      authDigest: ethers.hexlify(response.authDigest),
      servedUnits: BigInt((response.servedUnits ?? 0).toString()),
      receiptValueWei: BigInt(response.receiptValueWei),
      resultCommitment: ethers.hexlify(response.resultCommitment),
      sellerSig: ethers.hexlify(response.sellerSignature),
    };
    if (receipt.authDigest !== authorization.authDigest) {
      throw new MarketplaceInvokeError('MALFORMED_RECEIPT', 'receipt settles a different authorization', 'served');
    }
    // Recover the receipt signer FIRST, then verify everything against the
    // recovered wallet and resolve its on-chain identity. The offer's
    // RDF-published sellerAddress is unauthenticated data — a spoofed offer
    // must not decide which wallet a receipt verifies against.
    let signerAddress: string;
    try {
      signerAddress = eip191RecoverDigest(computeReceiptDigest(receipt), receipt.sellerSig);
    } catch (error) {
      throw new MarketplaceInvokeError(
        'BAD_RECEIPT', `sellerSig unrecoverable: ${error instanceof Error ? error.message : String(error)}`, 'served',
      );
    }
    const verification = verifyReceiptAgainstAuthorization(receipt, authorization, {
      sellerAddress: signerAddress,
      resultBytes: response.result,
    });
    if (!verification.ok) {
      throw new MarketplaceInvokeError('BAD_RECEIPT', verification.errors.join('; '), 'served');
    }
    const signerIdentityId = await this.#resolveSignerIdentity(signerAddress);
    if (signerIdentityId !== authorization.sellerIdentityId) {
      throw new MarketplaceInvokeError(
        'BAD_RECEIPT',
        `receipt signer ${signerAddress} resolves to identity ${signerIdentityId}, `
        + `the authorization binds seller ${authorization.sellerIdentityId}`,
        'served',
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(new TextDecoder().decode(response.result));
    } catch {
      throw new MarketplaceInvokeError('MALFORMED_RESULT', 'result bytes are not valid JSON', 'served');
    }
    return {
      result,
      resultBytes: response.result,
      receipt,
      authorization,
      seller: {
        peerId: offer.sellerPeerId,
        identityId: authorization.sellerIdentityId,
        // The RECOVERED, identity-verified signer — never the offer hint.
        address: signerAddress,
      },
      servedUnits: receipt.servedUnits,
      costWei: receipt.receiptValueWei,
    };
  }

  /**
   * Resolve the recovered receipt signer to its on-chain identityId
   * (`IdentityStorage.getIdentityId`). Fails CLOSED: without a trustworthy
   * resolution the receipt cannot be attributed to the authorized seller.
   * The seller HAS served, so callers settle pessimistically on this error.
   */
  async #resolveSignerIdentity(signerAddress: string): Promise<bigint> {
    const cacheKey = signerAddress.toLowerCase();
    const cached = this.#signerIdentityCache.get(cacheKey);
    if (cached !== undefined && cached > 0n) return cached;
    if (typeof this.#deps.chain.getIdentityIdForAddress !== 'function') {
      throw new MarketplaceInvokeError(
        'UNVERIFIABLE_SELLER', 'chain adapter cannot resolve wallet identities', 'served',
      );
    }
    let identityId: bigint;
    try {
      identityId = await this.#deps.chain.getIdentityIdForAddress(signerAddress);
    } catch (error) {
      throw new MarketplaceInvokeError(
        'UNVERIFIABLE_SELLER',
        `identity lookup for receipt signer ${signerAddress} failed: ${error instanceof Error ? error.message : String(error)}`,
        'served',
      );
    }
    if (identityId > 0n) {
      rememberBounded(this.#signerIdentityCache, cacheKey, identityId, SIGNER_IDENTITY_CACHE_BOUND);
    }
    return identityId;
  }

  /** History is KEYED by identityId; the router looks sellers up by peer id. */
  #deliveryHistoryByPeer(offers: readonly MarketplaceOffer[]): Map<string, DeliveryStats> {
    const byPeer = new Map<string, DeliveryStats>();
    for (const offer of offers) {
      const stats = this.#deliveryHistory.get(offer.sellerIdentityId.toString());
      if (stats) byPeer.set(offer.sellerPeerId, stats);
    }
    return byPeer;
  }

  #recordDelivery(sellerIdentityId: bigint, success: boolean): void {
    const key = sellerIdentityId.toString();
    const stats = this.#deliveryHistory.get(key) ?? { successes: 0, failures: 0 };
    if (success) stats.successes += 1;
    else stats.failures += 1;
    this.#deliveryHistory.set(key, stats);
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
