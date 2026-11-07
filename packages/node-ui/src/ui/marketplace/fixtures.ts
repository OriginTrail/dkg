// Fixture data for the marketplace section. Pure builders: every date is
// derived from the `now` passed in, so a render on any day looks the same.
// Numbers follow the section's design fixtures (two providers, a monthly plan
// twelve days from reset, the 1,238,400-unit statement). Addresses are
// synthetic placeholders, never real wallets.
import type {
  AccessKey, Activity, Allowance, Catalog, OperateStatus, Offer, PlanStatus,
  PurchaseIntent, PurchaseState, ShelfRow, Statement,
} from './types.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

const hex = (pair: string, bytes: number) => `0x${pair.repeat(bytes)}`;

export const FIXTURE_ADDRESSES = {
  buyer: hex('ab', 20),
  ops: hex('0d', 20),
  sellerA: hex('11', 20),
  sellerB: hex('22', 20),
  revenueA: hex('aa', 20),
  revenueB: hex('bb', 20),
  otherBuyer: hex('cd', 20),
  trac: hex('cc', 20),
  assetStorage: hex('ee', 20),
} as const;

const A = FIXTURE_ADDRESSES;
const iso = (ms: number) => new Date(ms).toISOString();
const FX = { tracUsd: 0.28, source: 'reference', asOf: null };
const PERIOD_MS = 30 * DAY;

/** The named fixture states the section can show. */
export type FixtureScenario =
  | 'plan-active'
  | 'plan-none'
  | 'plan-ended'
  | 'purchase-confirm'
  | 'purchase-pay'
  | 'purchase-key';

export const FIXTURE_SCENARIOS: readonly FixtureScenario[] = [
  'plan-active', 'plan-none', 'plan-ended', 'purchase-confirm', 'purchase-pay', 'purchase-key',
];

// ── catalog ─────────────────────────────────────────────────────────────────

const offer = (o: Partial<Offer> & Pick<Offer, 'offeringId' | 'modelId' | 'provenanceClass'>): Offer => ({
  tokenizerBundleRef: null, weightsDigest: null, ask: null, queuedAsk: null, available: true, ...o,
});

const tokenAsk = (askMicroPerUnit: number) => ({ askMicroPerUnit, unit: 'tokens' as const, effectiveFromCycle: 3 });

function shelves(now: number): ShelfRow[] {
  const fetchedAt = iso(now - 2 * MIN);
  return [
    {
      seller: A.sellerA, apiBase: 'https://provider-a.example', ok: true, fetchedAt, source: 'live',
      revenueWallet: A.revenueA, chainId: 8453, tracContract: A.trac, confirmationDepth: 3, addOn: true,
      offers: [
        offer({ offeringId: 'qwen25-14b', modelId: 'Qwen2.5 14B Instruct', provenanceClass: 'weights-pinned',
          tokenizerBundleRef: 'hf:Qwen/Qwen2.5-14B-Instruct', weightsDigest: `sha256:3f66aa10c2b944d1${'7e'.repeat(24)}`,
          ask: tokenAsk(0.6), ctx: 32_768 }),
        offer({ offeringId: 'qwen25-7b', modelId: 'Qwen2.5 7B Instruct', provenanceClass: 'weights-pinned',
          tokenizerBundleRef: 'hf:Qwen/Qwen2.5-7B-Instruct', weightsDigest: `sha256:9b20c4e1aa07f3d2${'4c'.repeat(24)}`,
          ask: tokenAsk(0.35), queuedAsk: { askMicroPerUnit: 0.32 }, ctx: 32_768 }),
        offer({ offeringId: 'gpt-5x', modelId: 'gpt-5.x', provenanceClass: 'upstream-claimed',
          tokenizerBundleRef: 'public:o200k_base', ask: tokenAsk(1.1), ctx: 128_000 }),
        offer({ offeringId: 'okf-knowledge', modelId: 'okf knowledge', provenanceClass: 'query',
          ask: { askMicroPerUnit: 15.24, unit: 'query-units', effectiveFromCycle: 3 } }),
        offer({ offeringId: 'gpt-6-astra', modelId: 'GPT-6 Astra', provenanceClass: 'upstream-claimed',
          tokenizerBundleRef: 'public:o200k_base', ask: tokenAsk(3.3), ctx: 200_000 }),
      ],
    },
    {
      seller: A.sellerB, apiBase: 'https://provider-b.example', ok: true, fetchedAt, source: 'live',
      revenueWallet: A.revenueB, chainId: 8453, tracContract: A.trac, confirmationDepth: 3,
      offers: [
        offer({ offeringId: 'qwen25-7b', modelId: 'Qwen2.5 7B Instruct', provenanceClass: 'weights-pinned',
          tokenizerBundleRef: 'hf:Qwen/Qwen2.5-7B-Instruct', weightsDigest: `sha256:9b20c4e1aa07f3d2${'4c'.repeat(24)}`,
          ask: tokenAsk(0.3), ctx: 32_768 }),
      ],
    },
  ];
}

// ── plan ────────────────────────────────────────────────────────────────────

const PLAN_ID = 'plan_7f3c21';

function planWindow(now: number) {
  // twelve days (and a bit) left of a thirty-day period
  const expiresAt = now + 12 * DAY + 3 * HOUR;
  return { startedAt: expiresAt - PERIOD_MS, expiresAt };
}

function meters(): Allowance[] {
  const m = (offeringId: string, seller: string, unit: Allowance['unit'], guaranteedUnits: number, consumedUnits: number,
    state: Allowance['state'] = 'active'): Allowance =>
    ({ planId: PLAN_ID, offeringId, seller, unit, guaranteedUnits, consumedUnits, state, enrollment: 'enrolled' });
  return [
    m('qwen25-14b', A.sellerA, 'tokens', 4_500_000, 1_080_000),
    m('qwen25-7b', A.sellerB, 'tokens', 7_600_000, 912_000),
    m('gpt-5x', A.sellerA, 'tokens', 200_000, 200_000, 'exhausted'),
    m('okf-knowledge', A.sellerA, 'query-units', 50_000, 43_500),
  ];
}

/** Consumption spread over the period (sparks) with the last day itemized. */
function activity(now: number, startedAt: number): Activity[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const yesterday = startOfToday.getTime() - DAY;
  const at = (h: number, mm: number) => iso(yesterday + h * HOUR + mm * MIN);
  const row = (when: string, offeringId: string, seller: string, units: number, keyId: string): Activity =>
    ({ kind: 'consumed', at: when, planId: PLAN_ID, offeringId, seller, units, keyId, phase: 'delivery' });
  const recent: Activity[] = [
    row(at(14, 32), 'qwen25-14b', A.sellerA, 1_840, 'my-agent'),
    row(at(14, 31), 'okf-knowledge', A.sellerA, 41, 'my-agent'),
    row(at(14, 12), 'qwen25-7b', A.sellerB, 3_120, 'my-agent'),
    row(at(13, 58), 'gpt-5x', A.sellerA, 950, 'ci-bot'),
    row(at(13, 41), 'qwen25-14b', A.sellerA, 12_400, 'ci-bot'),
    row(at(13, 29), 'okf-knowledge', A.sellerA, 5, 'my-agent'),
  ];
  const spread: Activity[] = [];
  const offerings: Array<[string, string, number]> = [
    ['qwen25-14b', A.sellerA, 1], ['qwen25-7b', A.sellerB, 0.8], ['gpt-5x', A.sellerA, 0.35], ['okf-knowledge', A.sellerA, 0.02],
  ];
  for (let d = 1; d <= 16; d++) {
    const when = iso(startedAt + d * DAY + 9 * HOUR);
    for (const [offeringId, seller, w] of offerings) {
      spread.push(row(when, offeringId, seller, Math.round((20_000 + d * 4_200) * w), d % 3 === 0 ? 'ci-bot' : 'my-agent'));
    }
  }
  return [...recent, ...spread.reverse()];
}

function keys(now: number): AccessKey[] {
  const key = (keyId: string, label: string, budgetMicroTrac: number, spentMicroTrac: number, extra: Partial<AccessKey> = {}): AccessKey => ({
    keyId, mintedAt: iso(now - 9 * DAY), revoked: false, spentMicroTrac,
    scopes: { label, budgetMicroTrac, expiresAt: null, modelAllowlist: null, allowQuery: true, rps: 5 },
    ...extra,
  });
  return [
    key('k_op', 'operator', 5_000_000, 410_000, { implicit: true }),
    key('my-agent', 'my-agent', 1_000_000, 610_000),
    key('ci-bot', 'ci-bot', 500_000, 90_000, {
      scopes: { label: 'ci-bot', budgetMicroTrac: 500_000, expiresAt: iso(now + 23 * DAY), modelAllowlist: ['gpt-5x', 'qwen25-14b'], allowQuery: false, rps: 2 },
    }),
    key('old-demo', 'old-demo', 10_000, 1_200, { revoked: true, mintedAt: iso(now - 40 * DAY) }),
  ];
}

const agreedStatement: Statement = {
  pair: `this node <-> ${A.sellerA}`,
  periodId: 'p-2026-10',
  items: [
    { offeringId: 'qwen25-14b', unit: 'tokens', buyerCount: 1_200_000, sellerCount: 1_200_000 },
    { offeringId: 'okf-knowledge', unit: 'query-units', buyerCount: 38_400, sellerCount: 38_400 },
  ],
  resolution: 'agreed',
};

const disputedStatement: Statement = {
  pair: `${A.otherBuyer} <-> this node`,
  periodId: 'p-2026-10',
  items: [{ offeringId: 'qwen25-7b', unit: 'tokens', buyerCount: 1_200_000, sellerCount: 1_274_000 }],
  resolution: 'disputed',
};

function basePlanStatus(): PlanStatus {
  return {
    plan: null, meters: [], summaryPct: null, activity: [], freshness: [], statements: [], keys: [],
    pendingSwitches: [], cycle: 3, openPurchase: null, planHistory: { count: 0, last: null },
    seat: { configured: true, buyer: A.buyer, rpc: true },
  };
}

function activePlanStatus(now: number): PlanStatus {
  const { startedAt, expiresAt } = planWindow(now);
  const allocations = [
    { offeringId: 'qwen25-14b', seller: A.sellerA, unit: 'tokens', allocationMicroTrac: 2_700_000, frozenAskMicroPerUnit: 0.6 },
    { offeringId: 'qwen25-7b', seller: A.sellerB, unit: 'tokens', allocationMicroTrac: 2_280_000, frozenAskMicroPerUnit: 0.3 },
    { offeringId: 'gpt-5x', seller: A.sellerA, unit: 'tokens', allocationMicroTrac: 220_000, frozenAskMicroPerUnit: 1.1 },
    { offeringId: 'okf-knowledge', seller: A.sellerA, unit: 'query-units', allocationMicroTrac: 762_000, frozenAskMicroPerUnit: 15.24 },
  ];
  return {
    ...basePlanStatus(),
    plan: { planId: PLAN_ID, buyer: A.buyer, periodId: 'p-2026-11', periodMs: PERIOD_MS, startedAt: iso(startedAt), expiresAt: iso(expiresAt), cycle: 3, allocations },
    meters: meters(),
    summaryPct: 34,
    activity: activity(now, startedAt),
    freshness: [{ pair: agreedStatement.pair, agree: true, checkedAgoMs: 4 * MIN }],
    statements: [agreedStatement],
    keys: keys(now),
    planHistory: { count: 2, last: { planId: 'plan_5a0e98', periodId: 'p-2026-10', expiresAt: iso(startedAt), lines: allocations.map(({ offeringId, seller, allocationMicroTrac }) => ({ offeringId, seller, allocationMicroTrac })) } },
  };
}

// ── purchases ───────────────────────────────────────────────────────────────

const NEXT: Record<PurchaseState, PurchaseIntent['nextAction']> = {
  draft: 'freeze_terms', terms_frozen: 'sign_binding', binding_required: 'sign_binding', binding_signed: 'pay', paying: 'pay',
  payment_confirming: 'wait_confirmations', payment_confirmed: 'enroll', plan_built: 'enroll', enrolling: 'enroll', active: 'done',
  cancelled: 'none', wallet_rejected: 'pay', payment_failed: 'pay', enrollment_blocked: 'none', expired: 'freeze_terms',
};

const TX_A = `0x${'f1'.repeat(32)}`;

/** A subscription to both providers: 2.8 TRAC to the first, 0.8 TRAC to the second. */
export function fixtureIntent(state: PurchaseState, now: number): PurchaseIntent {
  const at = iso(now - 6 * MIN);
  const frozen = state === 'draft' ? null : {
    at, validUntil: iso(now + 4 * MIN), chainId: 8453, tracContract: A.trac,
    sellers: {
      [A.sellerA]: {
        apiBase: 'https://provider-a.example', revenueWallet: A.revenueA, confirmationDepth: 3, sellerCycle: 3,
        lines: [
          { offeringId: 'qwen25-14b', unit: 'tokens', askMicroPerUnit: 0.6, effectiveFromCycle: 3, allocationMicroTrac: 1_800_000, guaranteedUnits: 3_000_000 },
          { offeringId: 'gpt-5x', unit: 'tokens', askMicroPerUnit: 1.1, effectiveFromCycle: 3, allocationMicroTrac: 220_000, guaranteedUnits: 200_000 },
          { offeringId: 'okf-knowledge', unit: 'query-units', askMicroPerUnit: 15.24, effectiveFromCycle: 3, allocationMicroTrac: 780_000, guaranteedUnits: 51_181 },
        ],
        amountMicroTrac: 2_800_000, amountWei: '2800000000000000000',
      },
      [A.sellerB]: {
        apiBase: 'https://provider-b.example', revenueWallet: A.revenueB, confirmationDepth: 3, sellerCycle: 3,
        lines: [
          { offeringId: 'qwen25-7b', unit: 'tokens', askMicroPerUnit: 0.3, effectiveFromCycle: 3, allocationMicroTrac: 800_000, guaranteedUnits: 2_666_666 },
        ],
        amountMicroTrac: 800_000, amountWei: '800000000000000000',
      },
    },
    balances: { tracMicro: 12_345_678, ethWei: '20000000000000000', gasEstimateWei: '210000000000000', source: 'node-rpc', checkedAt: at },
  };
  const paying = state === 'paying';
  return {
    id: 'pi_0123456789abcdef', kind: 'subscribe', createdAt: iso(now - 9 * MIN), updatedAt: at, state,
    buyer: A.buyer, periodMs: PERIOD_MS,
    lines: [
      { offeringId: 'qwen25-14b', seller: A.sellerA, allocationMicroTrac: 1_800_000 },
      { offeringId: 'gpt-5x', seller: A.sellerA, allocationMicroTrac: 220_000 },
      { offeringId: 'okf-knowledge', seller: A.sellerA, allocationMicroTrac: 780_000 },
      { offeringId: 'qwen25-7b', seller: A.sellerB, allocationMicroTrac: 800_000 },
    ],
    topUp: null,
    frozen,
    bindingStatement: frozen
      ? `wallet-binding:v1\nbuyer ${A.buyer}\nchain 8453\nnotAfter ${iso(now + PERIOD_MS)}\nkey sha256:5d1c0b7e`
      : null,
    payments: paying
      ? {
          [A.sellerA]: { state: 'confirmed', txHash: TX_A, logIndex: 0, blockNumber: 23_841_207, confirmations: 3, required: 3, promptedAt: iso(now - 4 * MIN) },
          [A.sellerB]: { state: 'pending' },
        }
      : {},
    planId: state === 'active' ? PLAN_ID : null,
    error: null,
    nextAction: NEXT[state],
    nextPaySeller: paying ? A.sellerB : ['binding_signed', 'wallet_rejected', 'payment_failed'].includes(state) ? A.sellerA : null,
  };
}

// ── public builders ─────────────────────────────────────────────────────────

export function fixtureCatalog(now: number, scenario: FixtureScenario = 'plan-active'): Catalog {
  const status = fixturePlanStatus(scenario, now);
  return {
    shelves: shelves(now),
    meters: status.meters,
    plan: status.plan ? { periodId: status.plan.periodId, expiresAt: status.plan.expiresAt } : null,
    fx: FX,
  };
}

export function fixturePlanStatus(scenario: FixtureScenario, now: number): PlanStatus {
  switch (scenario) {
    case 'plan-active':
      return activePlanStatus(now);
    case 'plan-none':
      return basePlanStatus();
    case 'plan-ended': {
      const active = activePlanStatus(now - 13 * DAY);
      return { ...basePlanStatus(), keys: active.keys, planHistory: active.planHistory && { count: 3, last: { ...active.planHistory.last!, expiresAt: active.plan!.expiresAt } } };
    }
    case 'purchase-confirm':
      return { ...basePlanStatus(), openPurchase: fixtureIntent('terms_frozen', now) };
    case 'purchase-pay':
      return { ...basePlanStatus(), openPurchase: fixtureIntent('paying', now) };
    case 'purchase-key':
      return { ...basePlanStatus(), openPurchase: fixtureIntent('active', now) };
  }
}

const ual = (id: number) => `did:dkg:base:8453/${A.assetStorage}/${id}`;

export function fixtureOperateStatus(now: number): OperateStatus {
  const { expiresAt } = planWindow(now);
  return {
    sellerActive: true,
    cycle: 3,
    offerings: [
      { id: 'qwen25-14b', modelId: 'Qwen2.5 14B Instruct', tokenizerBundleRef: 'hf:Qwen/Qwen2.5-14B-Instruct', offeringUal: ual(381_220), ask: tokenAsk(0.6), queuedAsk: null },
      { id: 'qwen25-7b', modelId: 'Qwen2.5 7B Instruct', tokenizerBundleRef: 'hf:Qwen/Qwen2.5-7B-Instruct', offeringUal: ual(381_221), ask: tokenAsk(0.35), queuedAsk: { askMicroPerUnit: 0.32, effectiveFromCycle: 4 } },
      { id: 'gpt-5x', modelId: 'gpt-5.x', tokenizerBundleRef: 'public:o200k_base', offeringUal: null, ask: tokenAsk(1.1), queuedAsk: null },
      { id: 'okf-knowledge', modelId: 'okf knowledge', tokenizerBundleRef: 'query', offeringUal: ual(381_224), ask: { askMicroPerUnit: 15.24, unit: 'query-units', effectiveFromCycle: 3 }, queuedAsk: null },
    ],
    subscribers: [
      { buyer: A.buyer, periodId: 'p-2026-11', expiresAt: iso(expiresAt), offerings: ['qwen25-14b', 'gpt-5x', 'okf-knowledge'], paymentIdentity: `8453:${TX_A}:0:1` },
      { buyer: A.otherBuyer, periodId: 'p-2026-11', expiresAt: iso(now + 3 * DAY), offerings: ['qwen25-7b'], paymentIdentity: `8453:0x${'f2'.repeat(32)}:0:1` },
    ],
    revenueWallet: A.revenueA,
    statements: [agreedStatement, disputedStatement],
    checkpointChains: [{ pair: agreedStatement.pair, length: 14, freshness: { agree: true, checkedAgoMs: 2 * MIN } }],
    keys: [],
  };
}

export const FIXTURE_OPS_WALLET = A.ops;
