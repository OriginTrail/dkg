/**
 * Buyer-side marketplace router: pick the seller for one request from the
 * discovered offers, live quotes, the plan policy, and the local meter. Pure
 * function — no I/O, no clock reads (`request.nowSeconds` is injected) — so
 * the policy matrix is exhaustively unit-testable.
 */
import { DEFAULT_SOFT_CEILING_BPS, softCeilingAllowanceWei } from './metering.js';
import type {
  DeliveryStats,
  MarketplaceOffer,
  MarketplaceQuote,
  MeterState,
  PlanPolicy,
  PolicyBucket,
  RouteDecision,
  RouteRejection,
  RouteRequest,
} from './types.js';

/** First policy bucket admitting the request, or -1. */
export function matchPolicyBucket(policy: PlanPolicy, request: Pick<RouteRequest, 'serviceType' | 'modelId'>): number {
  return policy.buckets.findIndex(
    (bucket) =>
      bucket.match.serviceType === request.serviceType &&
      (bucket.match.modelId === undefined || bucket.match.modelId === request.modelId),
  );
}

/** Net delivery score: deterministic integer tie-break input. */
function deliveryScore(stats: DeliveryStats | undefined): number {
  if (!stats) return 0;
  return stats.successes - stats.failures;
}

interface Candidate {
  offer: MarketplaceOffer;
  askPerUnitWei: bigint;
  worstCaseCostWei: bigint;
  maxUnits: bigint;
  /** Standing tier: 0 = trusted, 1 = deprioritized (denied never becomes a candidate). */
  tier: number;
}

/**
 * Deterministic candidate ordering: standing tier (trusted first), then the
 * lowest worst-case cost (`units × live ask` — asks alone are not comparable
 * across offers pinning different tokenizers), then the lowest live ask,
 * then better local delivery history (net successes), then lexicographic
 * peer id. With uniform units this orders exactly as lowest-ask-first.
 */
function preferCandidate(a: Candidate, b: Candidate, history: RouteRequest['deliveryHistory']): boolean {
  if (a.tier !== b.tier) return a.tier < b.tier;
  if (a.worstCaseCostWei !== b.worstCaseCostWei) return a.worstCaseCostWei < b.worstCaseCostWei;
  if (a.askPerUnitWei !== b.askPerUnitWei) return a.askPerUnitWei < b.askPerUnitWei;
  const scoreA = deliveryScore(history?.get(a.offer.sellerPeerId));
  const scoreB = deliveryScore(history?.get(b.offer.sellerPeerId));
  if (scoreA !== scoreB) return scoreA > scoreB;
  return a.offer.sellerPeerId < b.offer.sellerPeerId;
}

interface EvaluationContext {
  policy: PlanPolicy;
  bucket: PolicyBucket;
  meterBucket: MeterState['buckets'][number];
  softCeilingBps: number;
  request: RouteRequest;
}

/** Per-offer checks in normative order; the first failing check names the rejection. */
function evaluateOffer(
  offer: MarketplaceOffer,
  quote: MarketplaceQuote | undefined,
  ctx: EvaluationContext,
): Candidate | RouteRejection {
  const { policy, bucket, request } = ctx;
  const reject = (reason: RouteRejection['reason']): RouteRejection => ({ offerId: offer.offerId, reason });
  if (offer.serviceType !== request.serviceType) return reject('service-mismatch');
  if (request.modelId !== undefined && offer.modelId !== request.modelId) return reject('model-mismatch');
  // Symmetric: a raw `{prompt}`/`{sparql}` request never reaches a chat offer, and vice versa.
  if (offer.apiShape !== request.requireApiShape) return reject('api-shape');
  if (request.requiresTools && offer.toolTransport !== 'native' && offer.toolTransport !== 'prompt') {
    return reject('tools-unsupported');
  }
  if (offer.expiresAt !== undefined && offer.expiresAt <= request.nowSeconds) return reject('offer-expired');
  if (offer.access === 'restricted' && !policy.sellerAllow?.includes(offer.sellerIdentityId)) return reject('restricted');
  if (policy.sellerDeny?.includes(offer.sellerIdentityId)) return reject('deny-list');
  if (policy.sellerAllow && !policy.sellerAllow.includes(offer.sellerIdentityId)) return reject('allow-list');
  const standing = request.sellerStanding?.get(offer.sellerIdentityId.toString()) ?? 'trusted';
  if (standing === 'denied') return reject('recount-denied');
  let units = request.maxUnits;
  if (request.maxUnitsFor) {
    units = request.maxUnitsFor(offer);
    if (units <= 0n || units > bucket.maxUnitsPerCall) return reject('max-units');
  }
  if (!quote) return reject('no-quote');
  if (!quote.available) return reject('unavailable');
  if (quote.askPerUnitWei > bucket.priceCapWeiPerUnit) return reject('price-cap');
  const capacity = quote.capacityUnitsPerMin ?? offer.capacityUnitsPerMin;
  if (capacity !== undefined && capacity < units) return reject('capacity');
  const worstCaseCostWei = units * quote.askPerUnitWei;
  if (worstCaseCostWei > softCeilingAllowanceWei(ctx.meterBucket, ctx.softCeilingBps)) return reject('soft-ceiling');
  return {
    offer,
    askPerUnitWei: quote.askPerUnitWei,
    worstCaseCostWei,
    maxUnits: units,
    tier: standing === 'deprioritized' ? 1 : 0,
  };
}

/**
 * Select the route for one request. Quotes are matched to offers by
 * `(offeringId, sellerIdentityId)`; an offer without a usable quote is
 * rejected rather than routed on its advertised ask, because the
 * authorization must carry the ask the seller actually accepted.
 */
export function selectRoute(
  offers: readonly MarketplaceOffer[],
  quotes: readonly MarketplaceQuote[],
  policy: PlanPolicy,
  meter: MeterState,
  request: RouteRequest,
): RouteDecision {
  if (meter.buckets.length !== policy.buckets.length) {
    throw new Error(
      `meter/policy bucket mismatch: ${meter.buckets.length} meter buckets for ${policy.buckets.length} policy buckets`,
    );
  }
  const rejections: RouteRejection[] = [];
  const bucketIndex = matchPolicyBucket(policy, request);
  if (bucketIndex < 0) return { ok: false, reason: 'no-bucket', rejections };
  const bucket = policy.buckets[bucketIndex];
  if (!request.maxUnitsFor && (request.maxUnits <= 0n || request.maxUnits > bucket.maxUnitsPerCall)) {
    return { ok: false, reason: 'max-units', rejections };
  }
  const ctx: EvaluationContext = {
    policy,
    bucket,
    meterBucket: meter.buckets[bucketIndex],
    softCeilingBps: policy.softCeilingBps ?? DEFAULT_SOFT_CEILING_BPS,
    request,
  };
  const quoteByKey = new Map(quotes.map((quote) => [`${quote.offeringId}:${quote.sellerIdentityId}`, quote]));

  let best: Candidate | undefined;
  for (const offer of offers) {
    const quote = quoteByKey.get(`${offer.offeringId}:${offer.sellerIdentityId}`);
    const outcome = evaluateOffer(offer, quote, ctx);
    if ('reason' in outcome) {
      rejections.push(outcome);
      continue;
    }
    if (!best || preferCandidate(outcome, best, request.deliveryHistory)) best = outcome;
  }
  // An empty discovery is a sync/visibility fault, not a policy one: calling
  // it `no-eligible-offer` with zero rejections hides that the router never
  // saw an offer at all.
  if (!best) return { ok: false, reason: offers.length === 0 ? 'no-offers' : 'no-eligible-offer', rejections };
  return {
    ok: true,
    offer: best.offer,
    askPerUnitWei: best.askPerUnitWei,
    worstCaseCostWei: best.worstCaseCostWei,
    maxUnits: best.maxUnits,
    bucketIndex,
    rejections,
  };
}
