/**
 * OT-RFC-27 marketplace buyer runtime: session-key lifecycle (persisted under
 * the node data dir), the non-refundable period subscription (one TRAC
 * `transferFrom` into the epoch pool via `chain.marketplaceFundSubscription`),
 * and the Marketplace Router invoke pipeline — discover offers, probe live
 * quotes, `selectRoute` under the plan policy + local meter + recount
 * standing, admit through an optional spend guard, reserve, sign a bounded
 * seller-specific authorization with the session key, serve the call
 * off-chain, verify the seller-signed receipt (`buyer-transport.ts`), settle
 * the meter, then recount the delivery and record the seller's standing.
 *
 * The meter reserves the worst case (`maxUnits · ask`) at admission and only
 * settles the verified receipt value, so "remaining" is always safe against
 * in-flight calls. Failure settlement follows what is KNOWN about delivery:
 * a definitive non-delivery or seller refusal voids immediately; a response
 * that proves the seller served but cannot be verified settles pessimistically
 * at the reserved worst case (the seller can still claim); an AMBIGUOUS
 * transport failure (timeout mid-flight) holds the reservation until the
 * authorization expiry passes, then voids. A failure AFTER the receipt
 * verified (a malformed result, an invalid tool response) settles at the
 * receipt value: the receipt is trusted, so the charge is known.
 *
 * Recount never changes settlement (the RFC settles a seller-signed,
 * buyer-authorized receipt regardless); it drives the LOCAL standing that
 * steers routing (`trusted` → `deprioritized` → `denied`). Delivery history
 * and standing are keyed by seller identityId (the offer's sellerAddress is an
 * unauthenticated hint).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ethers } from 'ethers';
import type { ChainAdapter, TxResult } from '@origintrail-official/dkg-chain';
import {
  BuyerMeter,
  SoftCeilingExceededError,
  assertQueryWithinLimit,
  canonicalModelId,
  createSessionKey,
  loadSessionKey,
  persistSessionKey,
  recountQuery,
  selectRoute,
  signAuthorization,
  type ChatApiShape,
  type DeliveryStats,
  type MarketplaceOffer,
  type MarketplaceServiceType,
  type MeterState,
  type PlanPolicy,
  type RecountPolicy,
  type RecountVerdict,
  type RouteFailureReason,
  type RouteRejection,
  type SellerRecountRecord,
  type SellerStanding,
  type SessionKeyRecord,
} from '@origintrail-official/dkg-marketplace';
import { MarketplaceRequestError, type MarketplaceSpendGuard } from './buyer-errors.js';
import {
  BuyerTransport,
  MarketplaceInvokeError,
  type MarketplaceDeliveryState,
  type MarketplaceServedCall,
} from './buyer-transport.js';
import { createChainClock, type ChainClock } from './chain-clock.js';
import { MARKETPLACE_CALLER_FAULT_CODES } from './executors.js';
import type { MarketplaceOfferSource } from './offer-publisher.js';
import type { MarketplaceLogger, MarketplaceMessenger } from './seller-service.js';
import { SellerStandingStore } from './seller-standing-store.js';

export { MarketplaceInvokeError, type MarketplaceDeliveryState } from './buyer-transport.js';

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

export interface MarketplaceBuyerDeps {
  messenger: MarketplaceMessenger;
  chain: ChainAdapter;
  /** Funding wallet — the on-chain `msg.sender` of `fundSubscription`. */
  resolveBuyerAddress: () => Promise<string>;
  offerSource: MarketplaceOfferSource;
  /**
   * Idempotently (re)subscribe this node to the `marketplace` context graph so
   * SWM-shared offer KAs sync into the local store the offer source queries.
   * Invoked before every discovery.
   */
  ensureOfferSubscription?: () => void;
  /**
   * Fire-and-forget refresh nudge, invoked after EVERY discovery with whether
   * it found no offers (chain reconcile; an empty discovery also backfills
   * from peers). The implementation throttles itself and contains its own failures.
   */
  requestOfferBackfill?: (empty: boolean) => void;
  log: MarketplaceLogger;
  /**
   * Where the session key persists (JSON, mode 0o600). Omitted → an
   * ephemeral in-memory key with a warning; fine for tests, not for nodes.
   */
  sessionKeyPath?: string;
  /** Where the recount standing persists (0600); omitted → in memory only. */
  standingPath?: string;
  recountPolicy?: Partial<RecountPolicy>;
  /** Injectable unix-seconds clock (authorization expiry + offer staleness + standing). */
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

export interface MarketplaceInvokeResult extends MarketplaceServedCall {
  /** The buyer's recount of this delivery (local; never changes settlement). */
  recount: RecountVerdict;
}

/** One routed call: what to route, how to size and build the payload per offer, and the post-receipt hooks. */
export interface MarketplaceRoutedInvoke {
  serviceType: MarketplaceServiceType;
  modelId?: string;
  /** The grant for every offer (ignored when `maxUnitsFor` is set). */
  maxUnits: bigint;
  maxUnitsFor?: (offer: MarketplaceOffer) => bigint;
  requireApiShape?: ChatApiShape;
  requiresTools?: boolean;
  /** Offers already discovered by the caller (skips a second discovery). */
  offers?: MarketplaceOffer[];
  payloadFor: (offer: MarketplaceOffer, maxUnits: bigint) => Record<string, unknown>;
  serveTimeoutMs?: number;
  /** Authorization TTL floor (seconds) — the chat path outlives a long upstream call. */
  minAuthTtlSeconds?: number;
  spendGuard?: MarketplaceSpendGuard;
  /** Recount of a verified delivery (recorded into the seller's standing). */
  recount: (offer: MarketplaceOffer, served: MarketplaceServedCall) => RecountVerdict;
  /** Post-receipt validation; a throw is a charged failure settled at the receipt value. */
  validate?: (offer: MarketplaceOffer, invoke: MarketplaceInvokeResult) => void;
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

const MAX_TIMEOUT_MS = 2_147_483_647;
const NOT_METERED = (servedUnits: bigint): RecountVerdict => ({ verdict: 'unverifiable', reason: 'not-metered', servedUnits });

/** A spend guard's single settlement, swallowing (and logging) its own faults. */
function guardSettler(guard: MarketplaceSpendGuard | undefined, log: MarketplaceLogger, callId: () => string) {
  let settled = false;
  return {
    get settled() { return settled || !guard; },
    settle(costWei: bigint, servedUnits: bigint, delivery: MarketplaceDeliveryState): void {
      if (!guard || settled) return;
      settled = true;
      try {
        guard.settle({ costWei, servedUnits, delivery });
      } catch (error) {
        log.warn(`[marketplace] spend guard settle failed for call ${callId()}: ${(error as Error)?.message ?? String(error)}`);
      }
    },
  };
}

export class MarketplaceBuyerService {
  readonly #deps: MarketplaceBuyerDeps;
  readonly #nowSeconds: () => number;
  readonly #chainClock: ChainClock;
  readonly #transport: BuyerTransport;
  readonly #standing: SellerStandingStore;
  /** Keyed by seller identityId (decimal string) — see the header note. */
  readonly #deliveryHistory = new Map<string, DeliveryStats>();
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
    this.#transport = new BuyerTransport({
      messenger: deps.messenger,
      chain: deps.chain,
      log: deps.log,
      ...(deps.quoteTimeoutMs !== undefined ? { quoteTimeoutMs: deps.quoteTimeoutMs } : {}),
    });
    this.#standing = new SellerStandingStore(deps.standingPath, deps.recountPolicy, deps.log);
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
    this.#deps.requestOfferBackfill?.(offers.length === 0);
    return offers;
  }

  /** The active plan (epoch + policy), or `MarketplaceNotSubscribedError`. */
  requirePlan(): { epoch: bigint; policy: PlanPolicy } {
    const plan = this.#plan;
    if (!plan) throw new MarketplaceNotSubscribedError();
    return { epoch: plan.epoch, policy: plan.policy };
  }

  activePolicy(): PlanPolicy | undefined {
    return this.#plan?.policy;
  }

  /**
   * The generic invoke (`{ prompt }` / `{ sparql }` payloads at a fixed
   * `maxUnits`). Never routes to an `apiShape` offer (symmetric api-shape).
   * Query deliveries from schedule-pinned offers are recounted; everything
   * else recounts `unverifiable` / `not-metered`.
   */
  async invoke(opts: {
    serviceType: MarketplaceServiceType;
    modelId?: string;
    /** JSON payload the executor consumes (`{ prompt }` / `{ sparql }`). */
    payload: Record<string, unknown>;
    maxUnits: bigint;
  }): Promise<MarketplaceInvokeResult> {
    this.requirePlan();
    let modelId: string | undefined;
    if (opts.modelId !== undefined) {
      modelId = canonicalModelId(opts.modelId);
      if (modelId === undefined) throw new MarketplaceRequestError('invalid_model', 'modelId is not a valid model id', 'modelId');
    }
    const sparql = opts.serviceType === 'query' && typeof opts.payload.sparql === 'string' ? opts.payload.sparql : undefined;
    if (sparql !== undefined) {
      try {
        assertQueryWithinLimit(sparql);
      } catch (error) {
        throw new MarketplaceRequestError('invalid_sparql', (error as Error).message, 'sparql');
      }
    }
    return this.invokeRouted({
      serviceType: opts.serviceType,
      ...(modelId !== undefined ? { modelId } : {}),
      maxUnits: opts.maxUnits,
      payloadFor: () => opts.payload,
      recount: (offer, served) => (sparql !== undefined
        ? recountQuery({ sparql, offerQueryCost: offer.queryCost, result: served.result, receiptServedUnits: served.servedUnits })
        : NOT_METERED(served.servedUnits)),
      validate: (offer, invoke) => {
        if (offer.queryCost && invoke.recount.reason === 'malformed-result') {
          throw new MarketplaceInvokeError('MALFORMED_RESULT', 'the query result does not conform to sparql-result/v1', 'served');
        }
      },
    });
  }

  /** The invoke pipeline (see the module comment for the settlement rules). */
  async invokeRouted(spec: MarketplaceRoutedInvoke): Promise<MarketplaceInvokeResult> {
    const plan = this.#plan;
    if (!plan) throw new MarketplaceNotSubscribedError();
    this.releaseExpiredReservations();
    const sessionKey = this.ensureSessionKey();
    const nowSeconds = this.#nowSeconds();
    const standings = this.#standing.standings(nowSeconds);

    const offers = spec.offers ?? await this.discoverOffers();
    const quotes = await this.#transport.probeQuotes(
      offers,
      (offer) => this.#worthProbing(offer, spec, plan.policy, standings, nowSeconds),
      this.#deps.maxQuoteProbes ?? DEFAULT_MAX_QUOTE_PROBES,
    );
    const decision = selectRoute(offers, quotes, plan.policy, plan.meter.snapshot(), {
      serviceType: spec.serviceType,
      ...(spec.modelId !== undefined ? { modelId: spec.modelId } : {}),
      maxUnits: spec.maxUnits,
      nowSeconds,
      deliveryHistory: this.#deliveryHistoryByPeer(offers),
      ...(spec.maxUnitsFor ? { maxUnitsFor: spec.maxUnitsFor } : {}),
      ...(spec.requireApiShape !== undefined ? { requireApiShape: spec.requireApiShape } : {}),
      ...(spec.requiresTools !== undefined ? { requiresTools: spec.requiresTools } : {}),
      sellerStanding: standings,
    });
    if (!decision.ok) throw new MarketplaceRouteError(decision.reason, decision.rejections);
    const { offer } = decision;

    // The payload is built before admission: a fault here leaves nothing to undo.
    const payload = spec.payloadFor(offer, decision.maxUnits);
    // Spend guard admission: errors propagate UNCHANGED, nothing is reserved.
    spec.spendGuard?.admit(decision.worstCaseCostWei);
    const callId = ethers.hexlify(randomBytes(32));
    const guard = guardSettler(spec.spendGuard, this.#deps.log, () => callId);
    try {
      try {
        plan.meter.reserve(decision.bucketIndex, callId, decision.worstCaseCostWei);
      } catch (error) {
        guard.settle(0n, 0n, 'not-served');
        if (error instanceof SoftCeilingExceededError) {
          // A concurrent call reserved between this call's route check and now.
          throw new MarketplaceRouteError('no-eligible-offer', [{ offerId: offer.offerId, reason: 'soft-ceiling' }]);
        }
        throw error;
      }

      let authorization;
      try {
        const chainId = await this.#deps.chain.getEvmChainId();
        const marketplaceAddress = await this.#deps.chain.marketplaceGetAddress?.();
        if (!marketplaceAddress) {
          throw new MarketplaceInvokeError('NO_MARKETPLACE_ADDRESS', 'chain adapter reports no Marketplace contract');
        }
        // Expiry is CHAIN time: the contract checks it against block.timestamp.
        const chainNowSeconds = await this.#chainClock.nowSeconds();
        const ttl = Math.max(this.#deps.authTtlSeconds ?? DEFAULT_AUTH_TTL_SECONDS, spec.minAuthTtlSeconds ?? 0);
        authorization = await signAuthorization(sessionKey, {
          chainId,
          marketplaceAddress,
          buyer: await this.#deps.resolveBuyerAddress(),
          sellerIdentityId: offer.sellerIdentityId,
          offeringId: offer.offeringId,
          callId,
          epoch: plan.epoch,
          maxUnits: decision.maxUnits,
          askPerUnitWei: decision.askPerUnitWei,
          expiry: chainNowSeconds + BigInt(ttl),
        });
      } catch (error) {
        plan.meter.voidReservation(callId);
        guard.settle(0n, 0n, 'not-served');
        throw error;
      }

      let served: MarketplaceServedCall;
      try {
        served = await this.#transport.serve(offer, authorization, payload, spec.serveTimeoutMs ?? this.#deps.serveTimeoutMs);
      } catch (error) {
        const delivery: MarketplaceDeliveryState = error instanceof MarketplaceInvokeError ? error.delivery : 'ambiguous';
        const code = error instanceof MarketplaceInvokeError ? error.code : undefined;
        if (!code || !MARKETPLACE_CALLER_FAULT_CODES.has(code)) this.#recordDelivery(offer.sellerIdentityId, false);
        this.#resolveFailedReservation(plan.meter, callId, decision.worstCaseCostWei, authorization.expiry, error);
        guard.settle(delivery === 'not-served' ? 0n : decision.worstCaseCostWei, 0n, delivery);
        throw error;
      }

      // The receipt is verified: the actual charge is known from here on.
      plan.meter.settle(callId, served.costWei);
      const invoke: MarketplaceInvokeResult = { ...served, recount: this.#recount(offer, served, spec) };
      try {
        spec.validate?.(offer, invoke);
      } catch (error) {
        this.#recordDelivery(offer.sellerIdentityId, false);
        guard.settle(served.costWei, served.servedUnits, 'served');
        throw error;
      }
      this.#recordDelivery(offer.sellerIdentityId, true);
      guard.settle(served.costWei, served.servedUnits, 'served');
      return invoke;
    } finally {
      // Unexpected faults: hold the worst case against the guard (conservative).
      if (!guard.settled) guard.settle(decision.worstCaseCostWei, 0n, 'ambiguous');
    }
  }

  /** Static router checks before a quote probe is spent (the same predicates `selectRoute` applies). */
  #worthProbing(
    offer: MarketplaceOffer,
    spec: MarketplaceRoutedInvoke,
    policy: PlanPolicy,
    standings: ReadonlyMap<string, SellerStanding>,
    nowSeconds: number,
  ): boolean {
    if (offer.serviceType !== spec.serviceType) return false;
    if (spec.modelId !== undefined && offer.modelId !== spec.modelId) return false;
    if (offer.apiShape !== spec.requireApiShape) return false;
    if (spec.requiresTools && offer.toolTransport !== 'native' && offer.toolTransport !== 'prompt') return false;
    if (offer.expiresAt !== undefined && offer.expiresAt <= nowSeconds) return false;
    if (offer.access === 'restricted' && !policy.sellerAllow?.includes(offer.sellerIdentityId)) return false;
    if (policy.sellerDeny?.includes(offer.sellerIdentityId)) return false;
    if (policy.sellerAllow && !policy.sellerAllow.includes(offer.sellerIdentityId)) return false;
    return standings.get(offer.sellerIdentityId.toString()) !== 'denied';
  }

  #recount(offer: MarketplaceOffer, served: MarketplaceServedCall, spec: MarketplaceRoutedInvoke): RecountVerdict {
    let verdict: RecountVerdict;
    try {
      verdict = spec.recount(offer, served);
    } catch (error) {
      this.#deps.log.warn(`[marketplace] recount failed for seller ${offer.sellerIdentityId}: ${(error as Error).message}`);
      verdict = NOT_METERED(served.servedUnits);
    }
    const standing = this.#standing.record(offer.sellerIdentityId, verdict, this.#nowSeconds());
    if (verdict.verdict === 'mismatch') {
      this.#deps.log.warn(
        `[marketplace] recount mismatch for seller ${offer.sellerIdentityId}: receipt ${verdict.servedUnits} units, `
        + `recount ${verdict.recountUnits ?? 'n/a'} (${verdict.reason ?? 'unknown'}); standing now ${standing}`,
      );
    }
    return verdict;
  }

  /** Operator override: forget a seller's recount history. */
  resetSellerStanding(sellerIdentityId: bigint): boolean {
    return this.#standing.reset(sellerIdentityId);
  }

  recountSnapshot(): Array<SellerRecountRecord & { standing: SellerStanding }> {
    return this.#standing.snapshot(this.#nowSeconds());
  }

  recountSummary(): { sellers: number; deprioritized: number; denied: number } {
    return this.#standing.summary(this.#nowSeconds());
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

  /** Local delivery history by seller identityId (decimal). */
  deliveryHistory(): Map<string, DeliveryStats> {
    return new Map([...this.#deliveryHistory].map(([key, stats]) => [key, { ...stats }]));
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
