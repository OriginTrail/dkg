/**
 * Buyer-side marketplace router: pick the seller for one request from the
 * discovered offers, live quotes, the plan policy, and the local meter. Pure
 * function — no I/O, no clock reads (`request.nowSeconds` is injected) — so
 * the policy matrix is exhaustively unit-testable.
 */
import { DEFAULT_SOFT_CEILING_BPS } from './metering.js';
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

const BPS_DENOMINATOR = 10_000n;

/** First policy bucket admitting the request, or -1. */
export function matchPolicyBucket(policy: PlanPolicy, request: RouteRequest): number {
  return policy.buckets.findIndex(
    (bucket) =>
      bucket.match.serviceType === request.serviceType &&
      (bucket.match.modelId === undefined || bucket.match.modelId === request.modelId),
  );
}

/** Remaining spend a bucket admits under the soft ceiling (wei, floored). */
export function softCeilingAllowanceWei(
  bucket: { budgetWei: bigint; settledWei: bigint; reservedWei: bigint },
  softCeilingBps: number,
): bigint {
  const remaining = bucket.budgetWei - bucket.settledWei - bucket.reservedWei;
  if (remaining <= 0n) return 0n;
  return (remaining * BigInt(softCeilingBps)) / BPS_DENOMINATOR;
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
}

/**
 * Deterministic candidate ordering: lowest live ask first, ties broken by
 * better local delivery history (net successes), then lexicographic peer id.
 */
function preferCandidate(a: Candidate, b: Candidate, history: RouteRequest['deliveryHistory']): boolean {
  if (a.askPerUnitWei !== b.askPerUnitWei) return a.askPerUnitWei < b.askPerUnitWei;
  const scoreA = deliveryScore(history?.get(a.offer.sellerPeerId));
  const scoreB = deliveryScore(history?.get(b.offer.sellerPeerId));
  if (scoreA !== scoreB) return scoreA > scoreB;
  return a.offer.sellerPeerId < b.offer.sellerPeerId;
}

function evaluateOffer(
  offer: MarketplaceOffer,
  quote: MarketplaceQuote | undefined,
  policy: PlanPolicy,
  bucket: PolicyBucket,
  meterBucket: MeterState['buckets'][number],
  softCeilingBps: number,
  request: RouteRequest,
): Candidate | RouteRejection {
  if (offer.serviceType !== request.serviceType) return { offerId: offer.offerId, reason: 'service-mismatch' };
  if (request.modelId !== undefined && offer.modelId !== request.modelId) {
    return { offerId: offer.offerId, reason: 'model-mismatch' };
  }
  if (offer.expiresAt !== undefined && offer.expiresAt <= request.nowSeconds) {
    return { offerId: offer.offerId, reason: 'offer-expired' };
  }
  if (policy.sellerDeny?.includes(offer.sellerIdentityId)) return { offerId: offer.offerId, reason: 'deny-list' };
  if (policy.sellerAllow && !policy.sellerAllow.includes(offer.sellerIdentityId)) {
    return { offerId: offer.offerId, reason: 'allow-list' };
  }
  if (!quote) return { offerId: offer.offerId, reason: 'no-quote' };
  if (!quote.available) return { offerId: offer.offerId, reason: 'unavailable' };
  if (quote.askPerUnitWei > bucket.priceCapWeiPerUnit) return { offerId: offer.offerId, reason: 'price-cap' };
  const capacity = quote.capacityUnitsPerMin ?? offer.capacityUnitsPerMin;
  if (capacity !== undefined && capacity < request.maxUnits) return { offerId: offer.offerId, reason: 'capacity' };
  const worstCaseCostWei = request.maxUnits * quote.askPerUnitWei;
  if (worstCaseCostWei > softCeilingAllowanceWei(meterBucket, softCeilingBps)) {
    return { offerId: offer.offerId, reason: 'soft-ceiling' };
  }
  return { offer, askPerUnitWei: quote.askPerUnitWei, worstCaseCostWei };
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
  if (request.maxUnits <= 0n || request.maxUnits > bucket.maxUnitsPerCall) {
    return { ok: false, reason: 'max-units', rejections };
  }
  const softCeilingBps = policy.softCeilingBps ?? DEFAULT_SOFT_CEILING_BPS;
  const quoteByKey = new Map(quotes.map((quote) => [`${quote.offeringId}:${quote.sellerIdentityId}`, quote]));

  let best: Candidate | undefined;
  for (const offer of offers) {
    const quote = quoteByKey.get(`${offer.offeringId}:${offer.sellerIdentityId}`);
    const outcome = evaluateOffer(offer, quote, policy, bucket, meter.buckets[bucketIndex], softCeilingBps, request);
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
    bucketIndex,
    rejections,
  };
}
