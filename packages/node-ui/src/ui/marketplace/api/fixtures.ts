// Answers in the shapes of the node's marketplace API, for the section's
// tests, its standalone fixture page and its screenshots: a node with a
// subscription this epoch and the next, a node that never subscribed, one
// whose plan ended, one with the marketplace off, a caller without the
// node-admin token, and an epoch that is ending. Addresses, hashes, keys and
// service ids are synthetic.
import type {
  Account, ActivityAnswer, Budget, Call, CatalogAnswer, ChatCompletion, Consent, Contracts, FundedAnswer, Funding,
  FundingRequest, GatewayModels, Key, KeysAnswer, LandNowAnswer, Listing, MadeKey, Offer, Offering, Plan, PlanRequest, Preview,
  ReconciliationAnswer, SellerStatus, Service, ServiceDetail, ServiceRequest, Source, SourceRequest, Storefront,
  Subscription, TopUpAnswer,
} from './types.js';

export const FIXTURE_SCENARIOS = ['active', 'none', 'ended', 'off', 'viewer', 'ending'] as const;
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

const HOUR = 3_600;
const DAY = 86_400;
const WEI = 10n ** 18n;

/** Wei of a TRAC amount written as a decimal (`'0.72'`). */
export function tracWei(trac: string): bigint {
  const [w, f = ''] = trac.split('.');
  return BigInt(w) * WEI + BigInt(f.padEnd(18, '0'));
}
const microWei = (micro: string): bigint => tracWei(micro) / 1_000_000n;

/** The `…Trac` sibling as the node writes it: whole tokens, at least one decimal place. */
function tokens(wei: bigint): string {
  const whole = wei / WEI;
  const frac = (wei % WEI).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}.${frac || '0'}`;
}

/** `{ [name]: wei, [name + 'Trac']: tokens }`, as the node's views build every amount. */
function amount<N extends string>(name: N, wei: bigint): Record<N | `${N}Trac`, string> {
  return { [name]: wei.toString(), [`${name}Trac`]: tokens(wei) } as Record<N | `${N}Trac`, string>;
}

const hex = (pair: string, bytes: number) => `0x${pair.repeat(bytes)}`;

export const FIXTURE_IDS = {
  qwen14b: hex('14', 32),
  qwen7b: hex('07', 32),
  llama8b: hex('08', 32),
  mistral24b: hex('24', 32),
  buyerWallet: hex('b0', 20),
  nodeWallet: hex('a0', 20),
  ownerWallet: hex('c0', 20),
  publisherWallet: hex('e0', 20),
  sellerWallet: hex('f0', 20),
  sellerA: 12,
  sellerB: 31,
  epoch: 664,
} as const;
const I = FIXTURE_IDS;

const LABELS: Record<string, string> = {
  [I.qwen14b]: 'urn:dkg:model:qwen2.5-14b-instruct',
  [I.qwen7b]: 'urn:dkg:model:qwen2.5-7b-instruct',
  [I.llama8b]: 'urn:dkg:model:llama-3.1-8b-instruct',
  [I.mistral24b]: 'urn:dkg:model:mistral-small-24b-instruct',
};

/** The secret `POST /keys` answers with here: shaped like a real one, good for nothing. */
export const FIXTURE_SECRET = `dkgmk_${'0123456789abcdef'.repeat(3)}`;
const txHash = (n: number) => hex(n.toString(16).padStart(2, '0'), 32);

/** Every sample, its times placed around `nowMs` so countdowns read the same on any day. */
export function fixtureWorld(nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const epoch = I.epoch;
  const startsAt = now - 9 * HOUR;
  const endsAt = now + 15 * HOUR;
  const fx = { tracUsd: 0.28, source: 'config', asOf: now - 2 * HOUR };

  const offer = (serviceId: string, seller: number, micro: string, next: string | null, provenance: Offer['provenance'], latencyMs: number | null, available: boolean | null = true): Offer => ({
    serviceId, seller, epoch, unit: 'token', ...amount('pricePerUnit', microWei(micro)),
    ...(next ? amount('nextPricePerUnit', microWei(next)) : {}),
    provenance, available, ...(available === null ? {} : { quotedAt: now - 240 }), measured: { latencyMs, tokensPerSecond: null },
  });
  const offers: Record<string, Offer[]> = {
    [I.qwen14b]: [offer(I.qwen14b, I.sellerA, '0.6', '0.6', 'weights-pinned', 312), offer(I.qwen14b, I.sellerB, '0.7', '0.65', 'weights-pinned', 488)],
    [I.qwen7b]: [offer(I.qwen7b, I.sellerA, '0.3', '0.32', 'weights-pinned', 205), offer(I.qwen7b, I.sellerB, '0.35', '0.35', 'weights-pinned', null)],
    [I.llama8b]: [offer(I.llama8b, I.sellerB, '1.1', '1.1', 'upstream-claimed', 640)],
    [I.mistral24b]: [offer(I.mistral24b, I.sellerA, '3.3', '3.0', 'upstream-claimed', null, null)],
  };
  const budgetsNow: Array<[string, string, string, string, string]> = [
    // serviceId, value, cap (µTRAC per token), used, held
    [I.qwen14b, '3', '0.8', '0.72', '0.12'],
    [I.qwen7b, '1.5', '0.4', '0.18', '0.03'],
    [I.llama8b, '0.5', '1.2', '0.47', '0.005'],
  ];
  const budget = (i: number, [serviceId, value, cap, used, held]: [string, string, string, string, string]): Budget => {
    const v = tracWei(value);
    return {
      budgetIndex: i, serviceId, serviceClass: 'inference', ...amount('value', v), ...amount('maxPricePerUnit', microWei(cap)),
      ...amount('used', tracWei(used)), ...amount('held', tracWei(held)), ...amount('left', v - tracWei(used)),
      ...amount('softCeiling', (v * 95n) / 100n),
    };
  };
  const wallet: Source = { kind: 'wallet' };
  const subscription = (e: number, budgets: Budget[], source: Source = wallet): Subscription => {
    const value = budgets.reduce((s, b) => s + BigInt(b.value), 0n);
    const cost = source.kind === 'account' ? (value * BigInt(10_000 - source.discountBps)) / 10_000n : value;
    return {
      subscriptionId: hex((e % 256).toString(16).padStart(2, '0'), 32), epoch: e,
      startsAt: e === epoch ? startsAt : endsAt, endsAt: e === epoch ? endsAt : endsAt + DAY,
      source, ...amount('value', value), ...amount('cost', cost), sessionKey: hex('5e', 20), budgets,
    };
  };
  const current = subscription(epoch, budgetsNow.map((b, i) => budget(i, b)));
  const next = subscription(epoch + 1, budgetsNow.map(([s, v, c], i) => budget(i, [s, v, c, '0', '0'])));
  const covered = new Map(current.budgets.map((b) => [b.serviceId, BigInt(b.left) - BigInt(b.held)]));

  const service = (serviceId: string, withCover: boolean): Service => {
    const own = offers[serviceId];
    const left = covered.get(serviceId);
    return {
      serviceId, serviceClass: 'inference', label: LABELS[serviceId], offers: own,
      ...amount('priceMin', BigInt(own[0].pricePerUnit)), ...amount('priceMax', BigInt(own[own.length - 1].pricePerUnit)),
      ...(withCover && left !== undefined ? { covered: amount('left', left > 0n ? left : 0n) } : {}),
    };
  };
  const catalog = (withCover: boolean): CatalogAnswer => ({
    epoch, fx, services: Object.keys(offers).sort().map((id) => service(id, withCover)),
  });
  const gate = { profile: true, shardingTable: true, ...amount('stake', tracWei('50000')), ...amount('minimumStake', tracWei('50000')) };
  const storefront = (identityId: number): Storefront => ({
    identityId, gate, stakeFactor18: identityId === I.sellerA ? '1000000000000000000' : '1250000000000000000',
    available: true,
    offers: Object.values(offers).flat().filter((o) => o.seller === identityId),
    recent: [0, 1, 2].map((k) => ({
      epoch: epoch - k, ...amount('servedValue', tracWei(identityId === I.sellerA ? ['0.25', '1.8', '1.6'][k] : ['0.41', '2.2', '1.9'][k])),
      ...amount('weightedValue', tracWei(identityId === I.sellerA ? ['0.25', '1.8', '1.6'][k] : ['0.51', '2.75', '2.37'][k])),
    })),
  });
  const detail = (serviceId: string, withCover: boolean): ServiceDetail => ({
    ...service(serviceId, withCover), fx, sellers: [...new Set(offers[serviceId].map((o) => o.seller))].map(storefront),
  });

  const grant = { buyer: I.buyerWallet, ...amount('maxCostPerEpoch', tracWei('20')), expiresAt: now + 30 * DAY, revokedAt: 0, live: true };
  const accounts: Account[] = [
    {
      accountId: '7', ownedByNode: true, serviceCapable: true, discountBps: 1_000,
      window: { index: 3, ...amount('baseRemaining', tracWei('120')), ...amount('topUpBuffer', tracWei('30')), expired: false },
      grant, buyerWallets: [grant], publisherWallets: [I.nodeWallet, I.publisherWallet],
    },
    {
      accountId: '9', ownedByNode: false, serviceCapable: false, refusal: 'ServiceSpendingDisabled', discountBps: 500,
      window: { index: 1, ...amount('baseRemaining', tracWei('40')), ...amount('topUpBuffer', 0n), expired: false },
      buyerWallets: [], publisherWallets: [I.publisherWallet],
    },
  ];
  const funding: Funding = {
    buyerWallet: {
      address: I.buyerWallet, eth: tracWei('0.0123').toString(), ethEther: '0.0123',
      ...amount('trac', tracWei('42.5')), ...amount('walletContractAllowance', tracWei('10')),
    },
    accounts, epoch, epochEndsAt: endsAt,
  };
  const contracts: Contracts = {
    chainId: 84532, buyerWallet: I.buyerWallet,
    addresses: {
      ServiceSubscriptions: hex('11', 20), ServiceSubscriptionsWallet: hex('12', 20), ServiceSubscriptionsStorage: hex('13', 20),
      QueryInferenceSettlement: hex('21', 20), QueryInferenceStorage: hex('22', 20), DKGPublishingConvictionNFT: hex('31', 20), Token: hex('41', 20),
    },
    grantDomain: { name: 'ServiceSubscriptions', version: '1', chainId: 84532, verifyingContract: hex('11', 20) },
    grantTypes: { BuyerGrant: [
      { name: 'accountId', type: 'uint256' }, { name: 'buyer', type: 'address' }, { name: 'maxCostPerEpoch', type: 'uint96' },
      { name: 'expiresAt', type: 'uint40' }, { name: 'nonce', type: 'uint64' },
    ] },
  };
  const consent = (accountId: string, maxCostPerEpoch: string, expiresAt: number): Consent => ({
    terms: { accountId, buyer: I.buyerWallet, maxCostPerEpoch, expiresAt, nonce: '0' }, digest: hex('9a', 32), buyerSignature: hex('9b', 64),
  });

  const KEY_A = 'dkgmk_1a2b3c4d';
  const KEY_B = 'dkgmk_5e6f7a8b';
  const calls: Call[] = [
    [5, I.qwen14b, I.sellerA, KEY_A, 412, 'held'], [12, I.qwen7b, I.sellerA, KEY_B, 980, 'held'],
    [26, I.qwen14b, I.sellerA, KEY_A, 1_830, 'landed'], [41, I.llama8b, I.sellerB, KEY_A, 2_210, 'landed'],
    [63, I.qwen14b, I.sellerB, KEY_B, 640, 'landed'], [95, I.qwen7b, I.sellerA, KEY_A, 1_120, 'landed'],
    [140, I.llama8b, I.sellerB, KEY_B, 3_050, 'landed'], [210, I.qwen14b, I.sellerA, KEY_A, 2_400, 'landed'],
  ].map(([mins, serviceId, seller, keyId, units, state], i) => {
    const price = BigInt(offers[serviceId as string].find((o) => o.seller === seller)!.pricePerUnit);
    return {
      callId: txHash(0x60 + i), at: now - (mins as number) * 60, serviceId: serviceId as string, seller: seller as number,
      keyId: keyId as string, units: units as number, ...amount('value', price * BigInt(units as number)), state: state as Call['state'],
    };
  });
  const activity: ActivityAnswer = { calls };
  const reconciliation = (e: number, final: boolean): ReconciliationAnswer => ({
    epoch: e, final, rows: [
      { subscriptionId: current.subscriptionId, budgetIndex: 0, serviceId: I.qwen14b, seller: I.sellerA,
        held: { count: final ? 0 : 14, ...amount('value', final ? 0n : tracWei('0.12')) },
        landed: { count: 80, matched: 80, ...amount('value', tracWei('0.72')), ...amount('counted', tracWei('0.72')), txs: [txHash(0xa1)] } },
      { subscriptionId: current.subscriptionId, budgetIndex: 1, serviceId: I.qwen7b, seller: I.sellerA,
        held: { count: final ? 0 : 4, ...amount('value', final ? 0n : tracWei('0.03')) },
        landed: { count: 24, matched: 24, ...amount('value', tracWei('0.18')), ...amount('counted', tracWei('0.18')), txs: [txHash(0xa2)] } },
      { subscriptionId: current.subscriptionId, budgetIndex: 2, serviceId: I.llama8b, seller: I.sellerB,
        held: { count: final ? 0 : 1, ...amount('value', final ? 0n : tracWei('0.005')) },
        landed: { count: 96, matched: 95, ...amount('value', tracWei('0.47')), ...amount('counted', tracWei('0.465')), txs: [txHash(0xa2), txHash(0xa3)] } },
    ],
  });
  const keys: Key[] = [
    { keyId: KEY_A, label: 'my-agent', budget: tracWei('2').toString(), spent: tracWei('0.61').toString(), reserved: '0', services: null, rps: 5, expiresAt: null, revoked: false, lastUsedAt: now - 300 },
    { keyId: KEY_B, label: 'ci-bot', budget: tracWei('0.5').toString(), spent: tracWei('0.09').toString(), reserved: tracWei('0.2').toString(), services: [I.qwen14b, I.qwen7b], rps: 2, expiresAt: now + 23 * DAY, revoked: false, lastUsedAt: now - 3_600 },
    { keyId: 'dkgmk_9c0d1e2f', label: 'old-demo', budget: tracWei('0.2').toString(), spent: tracWei('0.02').toString(), reserved: '0', services: null, rps: 5, expiresAt: null, revoked: true, lastUsedAt: now - 40 * DAY },
  ];
  const batch = (n: number, minsAgo: number, items: number, value: string, counted: string) => ({
    tx: txHash(0xb0 + n), at: now - minsAgo * 60, items, ...amount('value', tracWei(value)), ...amount('counted', tracWei(counted)), gasUsed: 182_000 + items * 1_900,
  });
  const offering = (serviceId: string, connector: Offering['connector'], price: string, nextPrice: string, listing: Listing | null): Offering => ({
    serviceId, connector, ...amount('price', microWei(price)), ...amount('nextPrice', microWei(nextPrice)), listing,
  });
  // One offer listed, one this node cannot publish for want of TRAC, and one withdrawn.
  const listings: Record<string, Listing> = {
    [I.qwen14b]: { listed: true, kaId: '81', validUntilEpoch: epoch + 2, withdrawn: false },
    [I.qwen7b]: {
      listed: false, problem: 'no-trac', retryAt: now + 15 * 60,
      message: 'No publisher wallet holds enough TRAC to publish to Verifiable Memory',
    },
    [I.mistral24b]: { listed: false, kaId: '83', validUntilEpoch: epoch, withdrawn: true },
  };
  const sellerStatus: SellerStatus = {
    epoch, startsAt, endsAt,
    identityId: I.sellerA, gate, scoredThisEpoch: true,
    wallets: [{ address: I.sellerWallet, eth: '42000000000000000', ethEther: '0.042' }],
    offerings: [offering(I.qwen14b, 'up', '0.6', '0.6', listings[I.qwen14b]), offering(I.qwen7b, 'up', '0.3', '0.32', listings[I.qwen7b]), offering(I.mistral24b, 'down', '3.3', '3.0', listings[I.mistral24b])],
    ledger: {
      served: 412, sent: 380, landed: 360, refused: 2, missed: 0,
      ...amount('heldValue', tracWei('0.0213')), ...amount('landedValue', tracWei('0.23')), ...amount('counted', tracWei('0.2')),
    },
    nextLandingAt: now + 20 * 60,
    batches: [batch(1, 40, 120, '0.08', '0.07'), batch(2, 160, 140, '0.09', '0.08'), batch(3, 280, 100, '0.06', '0.05')],
    thisEpoch: { ...amount('servedValue', tracWei('0.25')), ...amount('weightedValue', tracWei('0.25')), ...amount('poolSoFar', tracWei('12.5')) },
    ended: [663, 662, 661].map((e, k) => ({ epoch: e, ...amount('pool', tracWei(['31.2', '28.4', '26.9'][k])), ...amount('gross', tracWei(['1.8', '1.6', '1.1'][k])) })),
    lastLanding: { sent: [{ txHash: txHash(0xb1), items: 120, ...amount('value', tracWei('0.08')), ...amount('counted', tracWei('0.07')) }], refused: 0, waiting: false },
  };
  const landNow: LandNowAnswer = { batches: [batch(4, 0, 32, '0.0213', '0.02')], refused: 0, waiting: false };
  const models: GatewayModels = {
    object: 'list', data: current.budgets.map((b) => ({ id: LABELS[b.serviceId], object: 'model' as const, owned_by: 'dkg-marketplace', service_id: b.serviceId })),
  };
  const chat = (model: string, serviceId: string): ChatCompletion => {
    const price = BigInt(offers[serviceId][0].pricePerUnit);
    const left = (covered.get(serviceId) ?? 0n) - price * 412n;
    return {
      id: txHash(0x70), object: 'chat.completion', created: now, model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'A knowledge graph links facts as nodes and edges, so an answer can cite where each fact came from.' }, finish_reason: 'stop' }],
      usage: { total_tokens: 412 },
      marketplace: { callId: txHash(0x70), serviceId, seller: offers[serviceId][0].seller, units: 412, ...amount('value', price * 412n), ...amount('budgetLeft', left > 0n ? left : 0n) },
    };
  };
  const plan = (renew: boolean): Plan => ({
    services: current.budgets.map((b) => ({ serviceId: b.serviceId, serviceClass: 'inference', ...amount('value', BigInt(b.value)), ...amount('maxPricePerUnit', BigInt(b.maxPricePerUnit)) })),
    source: wallet, renew, ...(renew ? { renewUntilEpoch: epoch + 6 } : {}),
  });
  return {
    now, epoch, startsAt, endsAt, fx, offers, current, next, catalog, detail, storefront, accounts, funding, contracts,
    consent, activity, reconciliation, keys, sellerStatus, landNow, models, chat, plan, labels: LABELS,
  };
}

type FixtureWorld = ReturnType<typeof fixtureWorld>;

// ── the fixture node ────────────────────────────────────────────────────────

export interface FixtureRequest { method: string; url: string; headers?: Record<string, string>; body?: unknown }
export interface FixtureAnswer { status: number; body: unknown; headers?: Record<string, string> }

const flat = (status: number, code: string, error: string, args: string[] = []): FixtureAnswer =>
  ({ status, body: { error, code, ...(args.length ? { args } : {}), retryable: status === 503 } });
const gatewayRefusal = (status: number, code: string, message: string, more: Record<string, unknown> = {}, headers?: Record<string, string>): FixtureAnswer =>
  ({ status, body: { error: { code, message, type: 'marketplace' }, ...more }, ...(headers ? { headers } : {}) });

function sourceOf(world: FixtureWorld, s: SourceRequest): Source {
  if (s.kind === 'wallet') return { kind: 'wallet' };
  return { kind: 'account', accountId: s.accountId, discountBps: world.accounts.find((a) => a.accountId === s.accountId)?.discountBps ?? 0 };
}

function previewOf(world: FixtureWorld, r: FundingRequest): Preview {
  const epoch = r.epoch === 'current' ? world.epoch : r.epoch === 'next' ? world.epoch + 1 : r.epoch;
  const value = r.services.reduce((s, x) => s + BigInt(x.value), 0n);
  const source = sourceOf(world, r.source);
  const cost = source.kind === 'account' ? (value * BigInt(10_000 - source.discountBps)) / 10_000n : value;
  const account = source.kind === 'account' ? world.accounts.find((a) => a.accountId === source.accountId) : undefined;
  const refusal = account && !account.serviceCapable ? { code: account.refusal ?? 'ServiceSpendingDisabled', args: [account.accountId] }
    : source.kind === 'wallet' && value > BigInt(world.funding.buyerWallet.trac) ? { code: 'ERC20InsufficientBalance', args: [I.buyerWallet, world.funding.buyerWallet.trac, value.toString()] }
      : undefined;
  return { epoch, source, ...amount('value', value), ...amount('cost', cost), discountBps: source.kind === 'account' ? source.discountBps : 0, ...(refusal ? { refusal } : {}) };
}

function budgetsOf(services: ServiceRequest[], from = 0): Budget[] {
  return services.map((s, i) => ({
    budgetIndex: from + i, serviceId: s.serviceId, serviceClass: s.serviceClass, ...amount('value', BigInt(s.value)), ...amount('maxPricePerUnit', BigInt(s.maxPricePerUnit)),
    ...amount('used', 0n), ...amount('held', 0n), ...amount('left', BigInt(s.value)), ...amount('softCeiling', (BigInt(s.value) * 95n) / 100n),
  }));
}

function planOf(world: FixtureWorld, r: PlanRequest): Plan {
  return {
    services: r.services.map((s) => ({ serviceId: s.serviceId, serviceClass: s.serviceClass, ...amount('value', BigInt(s.value)), ...amount('maxPricePerUnit', BigInt(s.maxPricePerUnit)), ...(s.pinnedSeller !== undefined ? { pinnedSeller: s.pinnedSeller } : {}) })),
    source: sourceOf(world, r.source), renew: r.renew, ...(r.renewUntilEpoch !== undefined ? { renewUntilEpoch: r.renewUntilEpoch } : {}),
  };
}

const ADMIN_ONLY_READS = new Set(['/keys', '/activity']);
const SELLERS: number[] = [I.sellerA, I.sellerB];

/**
 * The fixture node's answer to one request under /api/marketplace, or null for
 * any other path. Gateway calls need an access key and nothing else, as on a
 * real node.
 */
export function fixtureAnswer(scenario: FixtureScenario, req: FixtureRequest, nowMs = Date.now()): FixtureAnswer | null {
  const url = new URL(req.url, 'http://fixture.localhost');
  if (!url.pathname.startsWith('/api/marketplace')) return null;
  const route = url.pathname.slice('/api/marketplace'.length);
  const method = req.method.toUpperCase();
  const world = fixtureWorld(nowMs);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const auth = Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';

  if (route.startsWith('/v1/')) {
    if (scenario === 'off') return gatewayRefusal(503, 'MarketplaceOff', 'The marketplace is off on this node');
    if (!/^Bearer dkgmk_[0-9a-f]{48}$/.test(auth)) return gatewayRefusal(401, 'unknown_key', 'an access key of this node is needed');
    const funded = scenario === 'active' || scenario === 'viewer' || scenario === 'ending';
    if (method === 'GET' && route === '/v1/models') return { status: 200, body: funded ? world.models : { object: 'list', data: [] } };
    if (method === 'POST' && route === '/v1/chat/completions') {
      const model = String(body.model ?? '');
      const serviceId = /^0x[0-9a-f]{64}$/.test(model) ? model : Object.entries(world.labels).find(([, l]) => l === model)?.[0] ?? '';
      if (scenario === 'ending') return gatewayRefusal(503, 'epoch_ending', 'the epoch is ending; calls resume when the next one starts', { nextEpochAt: world.endsAt }, { 'Retry-After': '120' });
      if (!funded || !world.current.budgets.some((b) => b.serviceId === serviceId)) return gatewayRefusal(402, 'no_subscription', 'no subscription funds this service in this epoch', { serviceId, fork: { fund: true } });
      if (serviceId === I.llama8b) return gatewayRefusal(402, 'soft_ceiling', 'the budget is at its soft ceiling', { serviceId, ...amount('left', 0n), fork: { topUp: true, nextEpochAt: world.endsAt } });
      return { status: 200, body: world.chat(model, serviceId) };
    }
    return null;
  }

  const selling = route === '/seller' || route.startsWith('/seller/');
  if (scenario === 'off') {
    return flat(503, 'MarketplaceOff', selling ? 'Selling is off on this node' : 'The marketplace is off on this node');
  }
  if (scenario === 'viewer' && (method !== 'GET' || ADMIN_ONLY_READS.has(route))) {
    return flat(403, 'NodeAdminRequired', 'A node-admin token is required');
  }
  const funded = scenario === 'active' || scenario === 'viewer' || scenario === 'ending';
  const epochOf = (fallback: number) => (url.searchParams.has('epoch') ? Number(url.searchParams.get('epoch')) : fallback);

  if (method === 'GET') {
    if (route === '/catalog') return { status: 200, body: world.catalog(funded) };
    const service = /^\/services\/(0x[0-9a-f]{64})$/.exec(route);
    if (service) return world.offers[service[1]] ? { status: 200, body: world.detail(service[1], funded) } : flat(404, 'ServiceNotFound', `ServiceNotFound(${service[1]})`, [service[1]]);
    const seller = /^\/sellers\/(\d+)$/.exec(route);
    if (seller) return SELLERS.includes(Number(seller[1])) ? { status: 200, body: world.storefront(Number(seller[1])) } : flat(404, 'SellerNotFound', `SellerNotFound(${seller[1]})`, [seller[1]]);
    if (route === '/subscriptions') {
      const all = funded ? [world.current, world.next] : [];
      const asked = url.searchParams.has('epoch') ? all.filter((s) => s.epoch === epochOf(world.epoch)) : all;
      return { status: 200, body: { subscriptions: asked } };
    }
    if (route === '/plan') return scenario === 'none' ? flat(404, 'PlanNotFound', 'PlanNotFound()') : { status: 200, body: world.plan(funded) };
    if (route === '/funding') return { status: 200, body: world.funding };
    if (route === '/accounts') return { status: 200, body: { accounts: world.accounts } };
    if (route === '/accounts/contracts') return { status: 200, body: world.contracts };
    if (route === '/activity') return { status: 200, body: funded ? { calls: world.activity.calls.filter((c) => !url.searchParams.has('key') || c.keyId === url.searchParams.get('key')) } : { calls: [] } };
    if (route === '/reconciliation') {
      const e = epochOf(world.epoch);
      return { status: 200, body: funded || e < world.epoch ? world.reconciliation(e, e < world.epoch) : { epoch: e, final: false, rows: [] } };
    }
    if (route === '/keys') return { status: 200, body: { keys: world.keys } satisfies KeysAnswer };
    if (route === '/seller') return { status: 200, body: world.sellerStatus };
    return { status: 404, body: { error: 'Not found' } };
  }

  if (method === 'POST' && route === '/subscriptions/preview') return { status: 200, body: previewOf(world, body as unknown as FundingRequest) };
  if (method === 'POST' && route === '/subscriptions') {
    const r = body as unknown as FundingRequest;
    const p = previewOf(world, r);
    if (p.refusal) return flat(409, p.refusal.code, `${p.refusal.code}(${p.refusal.args.join(', ')})`, p.refusal.args);
    const s: Subscription = { ...(p.epoch === world.epoch ? world.current : world.next), source: p.source, ...amount('value', BigInt(p.value)), ...amount('cost', BigInt(p.cost)), budgets: budgetsOf(r.services) };
    return { status: 200, body: { txHash: txHash(0xc1), blockNumber: 18_204_331, subscription: s } satisfies FundedAnswer };
  }
  const topUpPreview = /^\/subscriptions\/(0x[0-9a-f]{64})\/top-up\/preview$/.exec(route);
  if (method === 'POST' && topUpPreview) {
    const s = topUpPreview[1] === world.next.subscriptionId ? world.next : world.current;
    const services = (body.services ?? []) as ServiceRequest[];
    const source: SourceRequest = s.source.kind === 'account' ? { kind: 'account', accountId: s.source.accountId } : { kind: 'wallet' };
    return { status: 200, body: { ...previewOf(world, { epoch: s.epoch, source, services }), epoch: s.epoch } satisfies Preview };
  }
  const topUp = /^\/subscriptions\/(0x[0-9a-f]{64})\/top-up$/.exec(route);
  if (method === 'POST' && topUp) {
    const services = (body.services ?? []) as ServiceRequest[];
    const s = topUp[1] === world.next.subscriptionId ? world.next : world.current;
    const budgets = s.budgets.map((b) => {
      const add = services.find((x) => x.serviceId === b.serviceId);
      if (!add) return b;
      const value = BigInt(b.value) + BigInt(add.value);
      return { ...b, ...amount('value', value), ...amount('left', BigInt(b.left) + BigInt(add.value)), ...amount('softCeiling', (value * 95n) / 100n) };
    });
    const added = budgetsOf(services.filter((x) => !s.budgets.some((b) => b.serviceId === x.serviceId)), budgets.length);
    return { status: 200, body: { txHash: txHash(0xc2), blockNumber: 18_204_390, subscription: { ...s, budgets: [...budgets, ...added] } } satisfies TopUpAnswer };
  }
  if (method === 'PUT' && route === '/plan') return { status: 200, body: planOf(world, body as unknown as PlanRequest) };
  if (method === 'POST' && route === '/keys') {
    const made: MadeKey = {
      keyId: FIXTURE_SECRET.slice(0, 14), label: String(body.label ?? 'key'), budget: String(body.budget ?? '0'), spent: '0', reserved: '0',
      services: (body.services as string[] | null | undefined) ?? null, rps: Number(body.rps ?? 5), expiresAt: (body.expiresAt as number | null | undefined) ?? null,
      revoked: false, lastUsedAt: null, secret: FIXTURE_SECRET,
    };
    return { status: 200, body: made };
  }
  const revoke = /^\/keys\/([^/]+)\/revoke$/.exec(route);
  if (method === 'POST' && revoke) {
    const key = world.keys.find((k) => k.keyId === decodeURIComponent(revoke[1]));
    return key ? { status: 200, body: { ...key, revoked: true } } : flat(404, 'KeyNotFound', `KeyNotFound(${revoke[1]})`, [revoke[1]]);
  }
  const onAccount = /^\/accounts\/(\d+)\/(buyer-consent|service-spending|buyers)$/.exec(route);
  if (method === 'POST' && onAccount) {
    if (onAccount[2] === 'buyer-consent') return { status: 200, body: world.consent(onAccount[1], String(body.maxCostPerEpoch ?? '0'), Number(body.expiresAt ?? 0)) };
    return { status: 200, body: { txHash: txHash(0xd1), blockNumber: 18_204_402 } };
  }
  if (/^\/accounts\/\d+\/buyers\/0x[0-9a-fA-F]{40}(\/limits)?$/.test(route) && (method === 'POST' || method === 'DELETE')) {
    return { status: 200, body: { txHash: txHash(0xd2), blockNumber: 18_204_410 } };
  }
  if (method === 'POST' && route === '/seller/land') return { status: 200, body: world.landNow };
  const price = /^\/seller\/offerings\/(0x[0-9a-f]{64})\/price$/.exec(route);
  if (method === 'PUT' && price) {
    const o = world.sellerStatus.offerings.find((x) => x.serviceId === price[1]);
    if (!o) return flat(404, 'ServiceNotFound', `ServiceNotFound(${price[1]})`, [price[1]]);
    return { status: 200, body: { ...o, ...amount('nextPrice', BigInt(String(body.price ?? '0'))) } satisfies Offering };
  }
  return { status: 404, body: { error: 'Not found' } };
}

/** A `fetch` that answers /api/marketplace from the fixture node, for tests. */
export function fixtureFetch(scenario: FixtureScenario, nowMs?: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const answer = fixtureAnswer(scenario, { method: init?.method ?? 'GET', url, headers, body }, nowMs);
    if (!answer) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json', ...answer.headers } });
  }) as typeof fetch;
}
