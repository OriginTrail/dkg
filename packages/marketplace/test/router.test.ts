import { describe, expect, it } from 'vitest';
import { BuyerMeter, matchPolicyBucket, selectRoute, softCeilingAllowanceWei } from '../src/index.js';
import type {
  MarketplaceOffer,
  MarketplaceQuote,
  MeterState,
  PlanPolicy,
  RouteRequest,
} from '../src/index.js';

const TRAC = 10n ** 18n;

function offer(overrides: Partial<MarketplaceOffer> = {}): MarketplaceOffer {
  return {
    offerId: 'ual:offer-a',
    sellerIdentityId: 1n,
    sellerPeerId: 'peer-a',
    offeringId: '0x' + '11'.repeat(32),
    serviceType: 'inference',
    modelId: 'devnet-llm',
    unit: 'token',
    askPerUnitWei: 500_000_000_000n,
    ...overrides,
  };
}

function quoteFor(source: MarketplaceOffer, overrides: Partial<MarketplaceQuote> = {}): MarketplaceQuote {
  return {
    offeringId: source.offeringId,
    sellerIdentityId: source.sellerIdentityId,
    available: true,
    askPerUnitWei: source.askPerUnitWei,
    ...overrides,
  };
}

function policyWith(overrides: Partial<PlanPolicy> = {}): PlanPolicy {
  return {
    totalBudgetWei: 10n * TRAC,
    buckets: [
      {
        match: { serviceType: 'inference' },
        budgetWei: 6n * TRAC,
        priceCapWeiPerUnit: 1_000_000_000_000n,
        maxUnitsPerCall: 4096n,
      },
      {
        match: { serviceType: 'query' },
        budgetWei: 4n * TRAC,
        priceCapWeiPerUnit: 20_000_000_000_000n,
        maxUnitsPerCall: 512n,
      },
    ],
    ...overrides,
  };
}

function meterFor(policy: PlanPolicy): MeterState {
  return new BuyerMeter(policy).snapshot();
}

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { serviceType: 'inference', modelId: 'devnet-llm', maxUnits: 1000n, nowSeconds: 1_700_000_000, ...overrides };
}

describe('matchPolicyBucket', () => {
  it('matches by serviceType and honours model-scoped buckets', () => {
    const policy = policyWith({
      buckets: [
        { match: { serviceType: 'inference', modelId: 'other' }, budgetWei: TRAC, priceCapWeiPerUnit: 1n, maxUnitsPerCall: 1n },
        { match: { serviceType: 'inference' }, budgetWei: TRAC, priceCapWeiPerUnit: 1n, maxUnitsPerCall: 1n },
      ],
    });
    expect(matchPolicyBucket(policy, request())).toBe(1);
    expect(matchPolicyBucket(policy, request({ modelId: 'other' }))).toBe(0);
    expect(matchPolicyBucket(policy, request({ serviceType: 'reasoning' }))).toBe(-1);
  });
});

describe('selectRoute policy matrix', () => {
  it('routes the lowest live ask among eligible offers', () => {
    const cheap = offer();
    const expensive = offer({ offerId: 'ual:offer-b', sellerIdentityId: 2n, sellerPeerId: 'peer-b' });
    const policy = policyWith();
    const decision = selectRoute(
      [expensive, cheap],
      [quoteFor(expensive, { askPerUnitWei: 700_000_000_000n }), quoteFor(cheap)],
      policy,
      meterFor(policy),
      request(),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.offer.offerId).toBe('ual:offer-a');
    expect(decision.askPerUnitWei).toBe(500_000_000_000n);
    expect(decision.worstCaseCostWei).toBe(1000n * 500_000_000_000n);
    expect(decision.bucketIndex).toBe(0);
  });

  it('enforces the bucket price cap against the LIVE quote, not the advertised ask', () => {
    const cheapOnPaper = offer();
    const policy = policyWith();
    const decision = selectRoute(
      [cheapOnPaper],
      [quoteFor(cheapOnPaper, { askPerUnitWei: 2_000_000_000_000n })],
      policy,
      meterFor(policy),
      request(),
    );
    expect(decision).toMatchObject({ ok: false, reason: 'no-eligible-offer' });
    expect(decision.rejections).toEqual([{ offerId: 'ual:offer-a', reason: 'price-cap' }]);
  });

  it('applies allow and deny lists by seller identity', () => {
    const a = offer();
    const b = offer({ offerId: 'ual:offer-b', sellerIdentityId: 2n, sellerPeerId: 'peer-b' });
    const quotes = [quoteFor(a), quoteFor(b)];
    const denyPolicy = policyWith({ sellerDeny: [1n] });
    const denied = selectRoute([a, b], quotes, denyPolicy, meterFor(denyPolicy), request());
    expect(denied.ok && denied.offer.sellerIdentityId).toBe(2n);
    expect(denied.rejections).toEqual([{ offerId: 'ual:offer-a', reason: 'deny-list' }]);

    const allowPolicy = policyWith({ sellerAllow: [1n] });
    const allowed = selectRoute([a, b], quotes, allowPolicy, meterFor(allowPolicy), request());
    expect(allowed.ok && allowed.offer.sellerIdentityId).toBe(1n);
    expect(allowed.rejections).toEqual([{ offerId: 'ual:offer-b', reason: 'allow-list' }]);
  });

  it('rejects service/model mismatches, expired offers, and missing or declined quotes', () => {
    const wrongService = offer({ offerId: 'ual:service', serviceType: 'query' });
    const wrongModel = offer({ offerId: 'ual:model', modelId: 'other-model', sellerIdentityId: 2n });
    const expired = offer({ offerId: 'ual:expired', sellerIdentityId: 3n, expiresAt: 1_700_000_000 });
    const unquoted = offer({ offerId: 'ual:unquoted', sellerIdentityId: 4n });
    const declined = offer({ offerId: 'ual:declined', sellerIdentityId: 5n });
    const policy = policyWith();
    const decision = selectRoute(
      [wrongService, wrongModel, expired, unquoted, declined],
      [quoteFor(expired), quoteFor(declined, { available: false })],
      policy,
      meterFor(policy),
      request(),
    );
    expect(decision).toMatchObject({ ok: false, reason: 'no-eligible-offer' });
    expect(decision.rejections).toEqual([
      { offerId: 'ual:service', reason: 'service-mismatch' },
      { offerId: 'ual:model', reason: 'model-mismatch' },
      { offerId: 'ual:expired', reason: 'offer-expired' },
      { offerId: 'ual:unquoted', reason: 'no-quote' },
      { offerId: 'ual:declined', reason: 'unavailable' },
    ]);
  });

  it('rejects sellers whose quoted capacity cannot cover the request', () => {
    const tight = offer();
    const policy = policyWith();
    const decision = selectRoute(
      [tight],
      [quoteFor(tight, { capacityUnitsPerMin: 999n })],
      policy,
      meterFor(policy),
      request({ maxUnits: 1000n }),
    );
    expect(decision.rejections).toEqual([{ offerId: 'ual:offer-a', reason: 'capacity' }]);
  });

  it('refuses a call whose worst case crosses the soft ceiling of the bucket', () => {
    const a = offer();
    const policy = policyWith();
    // A meter snapshot with only 4e14 wei of inference headroom left: the 95%
    // soft allowance is then 3.8e14 wei, i.e. exactly 760 units at the 5e11
    // ask. Built literally — `reserve()` itself now enforces the ceiling, so
    // a meter cannot be driven into this state in one reservation.
    const settledWei = 6n * TRAC - 400_000_000_000_000n;
    const snapshot = {
      ...new BuyerMeter(policy).snapshot(),
      totalSettledWei: settledWei,
      buckets: [
        { budgetWei: 6n * TRAC, settledWei, reservedWei: 0n },
        { budgetWei: 5n * TRAC, settledWei: 0n, reservedWei: 0n },
      ],
    };
    expect(softCeilingAllowanceWei(snapshot.buckets[0], snapshot.softCeilingBps)).toBe(380_000_000_000_000n);
    const within = selectRoute([a], [quoteFor(a)], policy, snapshot, request({ maxUnits: 760n }));
    expect(within.ok).toBe(true);
    const over = selectRoute([a], [quoteFor(a)], policy, snapshot, request({ maxUnits: 761n }));
    expect(over).toMatchObject({ ok: false, reason: 'no-eligible-offer' });
    expect(over.rejections).toEqual([{ offerId: 'ual:offer-a', reason: 'soft-ceiling' }]);
  });

  it('fails fast when no bucket admits the request or maxUnits is out of policy', () => {
    const policy = policyWith();
    const meter = meterFor(policy);
    expect(selectRoute([offer()], [], policy, meter, request({ serviceType: 'graph-ml' }))).toMatchObject({
      ok: false,
      reason: 'no-bucket',
    });
    expect(selectRoute([offer()], [], policy, meter, request({ maxUnits: 4097n }))).toMatchObject({
      ok: false,
      reason: 'max-units',
    });
    expect(selectRoute([offer()], [], policy, meter, request({ maxUnits: 0n }))).toMatchObject({
      ok: false,
      reason: 'max-units',
    });
  });

  it("reports 'no-offers' (not 'no-eligible-offer') when discovery handed the router nothing", () => {
    const policy = policyWith();
    const meter = meterFor(policy);
    const empty = selectRoute([], [], policy, meter, request());
    expect(empty).toMatchObject({ ok: false, reason: 'no-offers' });
    expect(empty.rejections).toEqual([]);
    // Policy faults still win over the empty-discovery diagnosis.
    expect(selectRoute([], [], policy, meter, request({ serviceType: 'graph-ml' }))).toMatchObject({
      ok: false,
      reason: 'no-bucket',
    });
  });

  it('breaks ask ties by delivery history, then lexicographic peer id', () => {
    const a = offer({ offerId: 'ual:offer-a', sellerIdentityId: 1n, sellerPeerId: 'peer-b' });
    const b = offer({ offerId: 'ual:offer-b', sellerIdentityId: 2n, sellerPeerId: 'peer-a' });
    const policy = policyWith();
    const meter = meterFor(policy);
    const quotes = [quoteFor(a), quoteFor(b)];

    // No history: lexicographic peer id wins deterministically.
    const lexicographic = selectRoute([a, b], quotes, policy, meter, request());
    expect(lexicographic.ok && lexicographic.offer.sellerPeerId).toBe('peer-a');
    // Order of the offers array must not matter.
    const reversed = selectRoute([b, a], quotes, policy, meter, request());
    expect(reversed.ok && reversed.offer.sellerPeerId).toBe('peer-a');

    // Better net delivery history outranks the lexicographic winner.
    const history = new Map([
      ['peer-a', { successes: 1, failures: 3 }],
      ['peer-b', { successes: 5, failures: 0 }],
    ]);
    const preferred = selectRoute([a, b], quotes, policy, meter, request({ deliveryHistory: history }));
    expect(preferred.ok && preferred.offer.sellerPeerId).toBe('peer-b');
  });

  it('throws when the meter snapshot does not align with the policy buckets', () => {
    const policy = policyWith();
    const foreign = meterFor(policyWith({ buckets: policy.buckets.slice(0, 1) }));
    expect(() => selectRoute([offer()], [], policy, foreign, request())).toThrow('bucket mismatch');
  });
});
