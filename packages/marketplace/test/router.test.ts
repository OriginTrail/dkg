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

describe('selectRoute: chat offers, per-offer units and standing (sellers + gateway)', () => {
  const chatOffer = (overrides: Partial<MarketplaceOffer> = {}): MarketplaceOffer =>
    offer({ modelId: 'stub-chat', apiShape: 'openai-chat/v1', toolTransport: 'native', ...overrides });
  const chatRequest = (overrides: Partial<RouteRequest> = {}): RouteRequest =>
    request({ modelId: 'stub-chat', requireApiShape: 'openai-chat/v1', ...overrides });

  it('reports decision.maxUnits = request.maxUnits on the generic path', () => {
    const a = offer();
    const policy = policyWith();
    const decision = selectRoute([a], [quoteFor(a)], policy, meterFor(policy), request({ maxUnits: 777n }));
    expect(decision.ok && decision.maxUnits).toBe(777n);
  });

  it('api-shape is symmetric: generic requests skip chat offers and chat requests skip raw offers', () => {
    const chat = chatOffer({ offerId: 'ual:chat', modelId: 'devnet-llm' });
    const raw = offer({ offerId: 'ual:raw', sellerIdentityId: 2n, sellerPeerId: 'peer-b' });
    const policy = policyWith();
    const quotes = [quoteFor(chat), quoteFor(raw)];
    const generic = selectRoute([chat, raw], quotes, policy, meterFor(policy), request());
    expect(generic.ok && generic.offer.offerId).toBe('ual:raw');
    expect(generic.rejections).toEqual([{ offerId: 'ual:chat', reason: 'api-shape' }]);
    const chatOnly = selectRoute([chat, raw], quotes, policy, meterFor(policy), request({ requireApiShape: 'openai-chat/v1' }));
    expect(chatOnly.ok && chatOnly.offer.offerId).toBe('ual:chat');
    expect(chatOnly.rejections).toEqual([{ offerId: 'ual:raw', reason: 'api-shape' }]);
  });

  it('tools-unsupported unless the offer transports tools natively or by prompt', () => {
    const none = chatOffer({ offerId: 'ual:none', toolTransport: 'none' });
    const absent = chatOffer({ offerId: 'ual:absent', toolTransport: undefined, sellerIdentityId: 2n });
    const prompt = chatOffer({ offerId: 'ual:prompt', toolTransport: 'prompt', sellerIdentityId: 3n });
    const policy = policyWith();
    const offers = [none, absent, prompt];
    const quotes = offers.map((o) => quoteFor(o));
    const withTools = selectRoute(offers, quotes, policy, meterFor(policy), chatRequest({ requiresTools: true }));
    expect(withTools.ok && withTools.offer.offerId).toBe('ual:prompt');
    expect(withTools.rejections).toEqual([
      { offerId: 'ual:none', reason: 'tools-unsupported' },
      { offerId: 'ual:absent', reason: 'tools-unsupported' },
    ]);
    const plain = selectRoute(offers, quotes, policy, meterFor(policy), chatRequest());
    expect(plain.ok).toBe(true);
    expect(plain.rejections).toEqual([]);
  });

  it('restricted offers route only for buyers who allow-list the seller; restricted ranks before deny-list', () => {
    const restricted = chatOffer({ offerId: 'ual:restricted', access: 'restricted', sellerIdentityId: 7n });
    const policy = policyWith();
    const open = selectRoute([restricted], [quoteFor(restricted)], policy, meterFor(policy), chatRequest());
    expect(open.rejections).toEqual([{ offerId: 'ual:restricted', reason: 'restricted' }]);
    const allowPolicy = policyWith({ sellerAllow: [7n] });
    const allowed = selectRoute([restricted], [quoteFor(restricted)], allowPolicy, meterFor(allowPolicy), chatRequest());
    expect(allowed.ok).toBe(true);
    const denyPolicy = policyWith({ sellerDeny: [7n] });
    const denied = selectRoute([restricted], [quoteFor(restricted)], denyPolicy, meterFor(denyPolicy), chatRequest());
    expect(denied.rejections).toEqual([{ offerId: 'ual:restricted', reason: 'restricted' }]);
    const openAccess = chatOffer({ access: 'open' });
    expect(selectRoute([openAccess], [quoteFor(openAccess)], policy, meterFor(policy), chatRequest()).ok).toBe(true);
  });

  it('rejects recount-denied sellers and prefers trusted over a cheaper deprioritized seller', () => {
    const cheap = chatOffer({ offerId: 'ual:cheap', sellerIdentityId: 1n, sellerPeerId: 'peer-a' });
    const pricey = chatOffer({ offerId: 'ual:pricey', sellerIdentityId: 3n, sellerPeerId: 'peer-c' });
    const policy = policyWith();
    const quotes = [quoteFor(cheap), quoteFor(pricey, { askPerUnitWei: 800_000_000_000n })];
    const meter = meterFor(policy);
    expect(selectRoute([cheap, pricey], quotes, policy, meter, chatRequest()).ok && 'cheapest wins').toBe('cheapest wins');
    const deprioritized = selectRoute(
      [cheap, pricey],
      quotes,
      policy,
      meter,
      chatRequest({ sellerStanding: new Map([['1', 'deprioritized']]) }),
    );
    expect(deprioritized.ok && deprioritized.offer.offerId).toBe('ual:pricey');
    const denied = selectRoute([cheap, pricey], quotes, policy, meter, chatRequest({ sellerStanding: new Map([['1', 'denied']]) }));
    expect(denied.ok && denied.offer.offerId).toBe('ual:pricey');
    expect(denied.rejections).toEqual([{ offerId: 'ual:cheap', reason: 'recount-denied' }]);
    const bothDeprioritized = selectRoute(
      [cheap, pricey],
      quotes,
      policy,
      meter,
      chatRequest({ sellerStanding: new Map([['1', 'deprioritized'], ['3', 'deprioritized']]) }),
    );
    expect(bothDeprioritized.ok && bothDeprioritized.offer.offerId).toBe('ual:cheap');
  });

  it('sizes the grant per offer and prefers the lowest worst-case cost over the lowest ask', () => {
    // A pins a tokenizer that counts this prompt at 3000 units; B at 1000.
    const a = chatOffer({ offerId: 'ual:a', sellerIdentityId: 1n, sellerPeerId: 'peer-a' });
    const b = chatOffer({ offerId: 'ual:b', sellerIdentityId: 2n, sellerPeerId: 'peer-b' });
    const units = new Map([
      ['ual:a', 3000n],
      ['ual:b', 1000n],
    ]);
    const policy = policyWith();
    const quotes = [quoteFor(a, { askPerUnitWei: 400_000_000_000n }), quoteFor(b, { askPerUnitWei: 600_000_000_000n })];
    const decision = selectRoute([a, b], quotes, policy, meterFor(policy), chatRequest({ maxUnits: 0n, maxUnitsFor: (o) => units.get(o.offerId)! }));
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.offer.offerId).toBe('ual:b');
    expect(decision.maxUnits).toBe(1000n);
    expect(decision.askPerUnitWei).toBe(600_000_000_000n);
    expect(decision.worstCaseCostWei).toBe(1000n * 600_000_000_000n);
  });

  it('per-offer max-units: skips the global early return, rejects ≤ 0 or above the bucket cap, and is evaluated after the cheap checks', () => {
    const big = chatOffer({ offerId: 'ual:big', sellerIdentityId: 1n });
    const zero = chatOffer({ offerId: 'ual:zero', sellerIdentityId: 2n });
    const fits = chatOffer({ offerId: 'ual:fits', sellerIdentityId: 3n });
    const wrongModel = chatOffer({ offerId: 'ual:model', modelId: 'other', sellerIdentityId: 4n });
    const units = new Map([
      ['ual:big', 4097n],
      ['ual:zero', 0n],
      ['ual:fits', 4096n],
    ]);
    const asked: string[] = [];
    const maxUnitsFor = (o: MarketplaceOffer) => {
      asked.push(o.offerId);
      return units.get(o.offerId)!;
    };
    const policy = policyWith();
    const offers = [big, zero, fits, wrongModel];
    const decision = selectRoute(
      offers,
      offers.map((o) => quoteFor(o)),
      policy,
      meterFor(policy),
      chatRequest({ maxUnits: 999_999n, maxUnitsFor }),
    );
    expect(decision.ok && decision.maxUnits).toBe(4096n);
    expect(decision.rejections).toEqual([
      { offerId: 'ual:big', reason: 'max-units' },
      { offerId: 'ual:zero', reason: 'max-units' },
      { offerId: 'ual:model', reason: 'model-mismatch' },
    ]);
    expect(asked).toEqual(['ual:big', 'ual:zero', 'ual:fits']);
    const allTooBig = selectRoute([big], [quoteFor(big)], policy, meterFor(policy), chatRequest({ maxUnitsFor }));
    expect(allTooBig).toMatchObject({ ok: false, reason: 'no-eligible-offer', rejections: [{ offerId: 'ual:big', reason: 'max-units' }] });
  });

  it('checks capacity and the soft ceiling against the per-offer units', () => {
    const a = chatOffer();
    const policy = policyWith();
    const tight = selectRoute(
      [a],
      [quoteFor(a, { capacityUnitsPerMin: 1500n })],
      policy,
      meterFor(policy),
      chatRequest({ maxUnits: 1n, maxUnitsFor: () => 2000n }),
    );
    expect(tight.rejections).toEqual([{ offerId: 'ual:offer-a', reason: 'capacity' }]);
    const settledWei = 6n * TRAC - 400_000_000_000_000n;
    const snapshot = {
      ...meterFor(policy),
      totalSettledWei: settledWei,
      buckets: [
        { budgetWei: 6n * TRAC, settledWei, reservedWei: 0n },
        { budgetWei: 4n * TRAC, settledWei: 0n, reservedWei: 0n },
      ],
    };
    expect(selectRoute([a], [quoteFor(a)], policy, snapshot, chatRequest({ maxUnitsFor: () => 760n })).ok).toBe(true);
    expect(selectRoute([a], [quoteFor(a)], policy, snapshot, chatRequest({ maxUnitsFor: () => 761n })).rejections).toEqual([
      { offerId: 'ual:offer-a', reason: 'soft-ceiling' },
    ]);
  });

  it('applies the normative check order (api-shape before expiry, restricted before allow-list, denied before quotes)', () => {
    const expiredRaw = offer({ offerId: 'ual:expired-raw', modelId: 'stub-chat', expiresAt: 1 });
    const restrictedOutsideAllow = chatOffer({ offerId: 'ual:restricted', access: 'restricted', sellerIdentityId: 9n });
    const deniedUnquoted = chatOffer({ offerId: 'ual:denied', sellerIdentityId: 5n });
    const policy = policyWith({ sellerAllow: [5n] });
    const decision = selectRoute(
      [expiredRaw, restrictedOutsideAllow, deniedUnquoted],
      [],
      policy,
      meterFor(policy),
      chatRequest({ sellerStanding: new Map([['5', 'denied']]) }),
    );
    expect(decision.rejections).toEqual([
      { offerId: 'ual:expired-raw', reason: 'api-shape' },
      { offerId: 'ual:restricted', reason: 'restricted' },
      { offerId: 'ual:denied', reason: 'recount-denied' },
    ]);
  });

  it('matchPolicyBucket accepts just the service type and model', () => {
    expect(matchPolicyBucket(policyWith(), { serviceType: 'query' })).toBe(1);
  });
});
