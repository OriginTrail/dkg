// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_KEY_RE, MarketplaceError, errorOf, isMarketplaceAbsent, isMarketplaceOff, marketplaceApi, marketplaceGateway, needsNodeAdmin,
} from '../src/ui/marketplace/api/client.js';
import { FIXTURE_IDS, FIXTURE_SECRET, FIXTURE_SCENARIOS, fixtureAnswer, fixtureFetch, fixtureWorld, tracWei } from '../src/ui/marketplace/api/fixtures.js';
import { copy } from '../src/ui/marketplace/copy.generated.js';
import { describeError } from '../src/ui/marketplace/shared.js';

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const NODE_TOKEN = 'node-admin-token-for-tests';

interface Sent { url: string; method: string; headers: Record<string, string>; credentials?: RequestCredentials; body?: unknown }

/** Stub fetch with the fixture node and keep what each call sent. */
function stubNode(scenario: (typeof FIXTURE_SCENARIOS)[number] = 'active'): Sent[] {
  const sent: Sent[] = [];
  const node = fixtureFetch(scenario, NOW);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    sent.push({ url: String(input), method: init?.method ?? 'GET', headers, credentials: init?.credentials, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return node(input, init);
  });
  return sent;
}

/** Every `…Trac` field beside its wei field, in whole tokens, all through an answer. */
function checkSiblings(value: unknown, path = '$'): string[] {
  const bad: string[] = [];
  if (Array.isArray(value)) value.forEach((v, i) => bad.push(...checkSiblings(v, `${path}[${i}]`)));
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k.endsWith('Trac') && k !== 'Trac') {
        const wei = o[k.slice(0, -4)];
        if (typeof wei !== 'string' || typeof v !== 'string' || !/^\d+$/.test(wei) || !/^\d+\.\d+$/.test(v) || tracWei(v) !== BigInt(wei)) bad.push(`${path}.${k}`);
      }
      bad.push(...checkSiblings(v, `${path}.${k}`));
    }
  }
  return bad;
}

describe('marketplace API client', () => {
  beforeEach(() => { (window as unknown as { __DKG_TOKEN__?: string }).__DKG_TOKEN__ = NODE_TOKEN; });
  afterEach(() => { vi.unstubAllGlobals(); delete (window as unknown as { __DKG_TOKEN__?: string }).__DKG_TOKEN__; });

  it('reads the node routes with the token the UI uses for /api', async () => {
    const sent = stubNode();
    const catalog = await marketplaceApi.catalog();
    expect(catalog.epoch).toBe(FIXTURE_IDS.epoch);
    expect(catalog.services.map((s) => s.label)).toContain('urn:dkg:model:qwen2.5-14b-instruct');
    await marketplaceApi.subscriptions(FIXTURE_IDS.epoch);
    await marketplaceApi.activity({ key: 'dkgmk_1a2b3c4d' });
    expect(sent.map((s) => s.url)).toEqual([
      '/api/marketplace/catalog', `/api/marketplace/subscriptions?epoch=${FIXTURE_IDS.epoch}`, '/api/marketplace/activity?key=dkgmk_1a2b3c4d',
    ]);
    for (const s of sent) expect(s.headers.authorization).toBe(`Bearer ${NODE_TOKEN}`);
  });

  it('makes a key with the node token and calls the gateway with that key alone', async () => {
    const sent = stubNode();
    const made = await marketplaceApi.makeKey({ label: 'playground', budget: '1000000000000000000', services: null, expiresAt: Math.floor(NOW / 1000) + 3_600 });
    expect(made.secret).toMatch(ACCESS_KEY_RE);
    expect(made.keyId).toBe(made.secret.slice(0, 14));
    const models = await marketplaceGateway.models(made.secret);
    const answer = await marketplaceGateway.chat(made.secret, { model: models.data[0].service_id, messages: [{ role: 'user', content: 'hello' }] });
    expect(answer.marketplace.serviceId).toBe(models.data[0].service_id);
    expect(answer.marketplace.budgetLeftTrac).toMatch(/^\d+\.\d+$/);
    const [keyCall, ...gatewayCalls] = sent;
    expect(keyCall.headers.authorization).toBe(`Bearer ${NODE_TOKEN}`);
    expect(gatewayCalls.map((s) => s.url)).toEqual(['/api/marketplace/v1/models', '/api/marketplace/v1/chat/completions']);
    for (const s of gatewayCalls) {
      expect(s.headers.authorization).toBe(`Bearer ${FIXTURE_SECRET}`);
      expect(JSON.stringify(s)).not.toContain(NODE_TOKEN);
      expect(s.credentials).toBe('omit');
    }
    expect((gatewayCalls[1].body as { stream?: unknown }).stream).toBeUndefined();
  });

  it('never sends anything but an access key to the gateway', async () => {
    const sent = stubNode();
    await expect(marketplaceGateway.models(NODE_TOKEN)).rejects.toMatchObject({ code: 'missing_key', status: 0 });
    expect(sent).toHaveLength(0);
  });

  it('reads both refusal shapes, with the gateway fork and Retry-After', async () => {
    stubNode('ending');
    const ending = await marketplaceGateway.chat(FIXTURE_SECRET, { model: FIXTURE_IDS.qwen14b, messages: [] }).catch((e: unknown) => e);
    expect(ending).toBeInstanceOf(MarketplaceError);
    expect(ending).toMatchObject({ status: 503, code: 'epoch_ending', retryAfter: 120, retryable: true });
    expect((ending as MarketplaceError).extra.nextEpochAt).toBeGreaterThan(NOW / 1000);
    vi.unstubAllGlobals();

    stubNode('active');
    const ceiling = await marketplaceGateway.chat(FIXTURE_SECRET, { model: FIXTURE_IDS.llama8b, messages: [] }).catch((e: unknown) => e as MarketplaceError);
    expect(ceiling).toMatchObject({ status: 402, code: 'soft_ceiling', extra: { left: '0', leftTrac: '0.0', fork: { topUp: true } } });
    const unfunded = await marketplaceGateway.chat(FIXTURE_SECRET, { model: FIXTURE_IDS.mistral24b, messages: [] }).catch((e: unknown) => e as MarketplaceError);
    expect(unfunded).toMatchObject({ status: 402, code: 'no_subscription', extra: { fork: { fund: true } } });
    vi.unstubAllGlobals();

    stubNode('off');
    const off = await marketplaceApi.catalog().catch((e: unknown) => e);
    expect(isMarketplaceOff(off)).toBe(true);
    expect(off).toMatchObject({ status: 503, retryable: true });
    expect(isMarketplaceOff(await marketplaceGateway.models(FIXTURE_SECRET).catch((e: unknown) => e))).toBe(true);
    vi.unstubAllGlobals();

    stubNode('viewer');
    expect(needsNodeAdmin(await marketplaceApi.keys().catch((e: unknown) => e))).toBe(true);
    expect(needsNodeAdmin(await marketplaceApi.makeKey({ label: 'x', budget: '1' }).catch((e: unknown) => e))).toBe(true);
  });

  it('reads a busy gateway and a top-up of unknown outcome as passing, with Retry-After, unless the refusal says not to', () => {
    const gateway = (code: string, message: string, more: Record<string, unknown> = {}) => ({ error: { code, message, type: 'marketplace' }, ...more });
    const budgetBusy = errorOf(429, gateway('budget_busy', 'too many calls wait on this service now; try again shortly'), '5');
    const gatewayBusy = errorOf(503, gateway('gateway_busy', 'the gateway has as many calls as it takes at once; try again shortly'), '5');
    const pending = errorOf(503, { error: 'TopUpOutcomeUnknown(k-1)', code: 'TopUpOutcomeUnknown', args: ['k-1'], retryable: true });
    expect(budgetBusy).toMatchObject({ status: 429, code: 'budget_busy', retryable: true, retryAfter: 5 });
    expect(gatewayBusy).toMatchObject({ status: 503, code: 'gateway_busy', retryable: true, retryAfter: 5 });
    expect(pending).toMatchObject({ status: 503, code: 'TopUpOutcomeUnknown', retryable: true });
    // A refusal that says it will not pass stays so, whatever its status.
    expect(errorOf(429, gateway('budget_busy', 'busy', { retry: false }), '5')).toMatchObject({ retryable: false, retryAfter: 5 });
    expect(errorOf(503, gateway('gateway_busy', 'busy', { retry: false }))).toMatchObject({ retryable: false });
    expect(describeError(budgetBusy)).toMatchObject({ copyKey: 'err.gw.busy', message: 'Too many calls are waiting on this service; try again in a moment', retryAfter: 5 });
    expect(describeError(gatewayBusy)).toMatchObject({ copyKey: 'err.gw.nodebusy', message: 'This node is taking as many calls as it can; try again in a moment', retryAfter: 5 });
    expect(describeError(pending)).toMatchObject({ copyKey: 'err.topup.pending', message: copy('err.topup.pending') });
    expect(copy('err.topup.pending')).toBe('The node cannot tell yet whether this top-up went through');
  });

  it('reads PlanNotFound as no plan, a node without the marketplace routes as absent, and a dead node as an error', async () => {
    stubNode('none');
    expect(await marketplaceApi.plan()).toBeNull();
    // A node with the routes names what it did not find.
    const missingService = await marketplaceApi.service(`0x${'99'.repeat(32)}`).catch((e: unknown) => e);
    expect(missingService).toMatchObject({ status: 404, code: 'ServiceNotFound' });
    expect(isMarketplaceAbsent(missingService)).toBe(false);
    vi.unstubAllGlobals();
    // A node without them answers 404 and names nothing, in JSON or not.
    for (const answer of [() => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }), () => new Response('<h1>Not Found</h1>', { status: 404 })]) {
      vi.stubGlobal('fetch', async () => answer());
      for (const read of [() => marketplaceApi.catalog(), () => marketplaceApi.plan(), () => marketplaceApi.sellerStatus()]) {
        const absent = await read().catch((e: unknown) => e);
        expect(absent).toMatchObject({ status: 404, code: 'MarketplaceAbsent', retryable: false });
        expect(isMarketplaceAbsent(absent)).toBe(true);
        expect(isMarketplaceOff(absent)).toBe(false);
      }
      vi.unstubAllGlobals();
    }
    expect(errorOf(404, { error: 'Not found' })).toMatchObject({ code: 'NotFound', retryable: false });
    expect(errorOf(409, { error: 'InsufficientAllowance(7, 664, 5, 2)', code: 'InsufficientAllowance', args: ['7', '664', '5', '2'], retryable: false }))
      .toMatchObject({ code: 'InsufficientAllowance', args: ['7', '664', '5', '2'] });
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await expect(marketplaceApi.funding()).rejects.toMatchObject({ status: 0, code: 'Offline', retryable: true });
  });

  it('takes a success whose body cannot be read for no answer, and a refusal without a readable body for what its status says', async () => {
    // The body stops partway, or the connection drops while it comes.
    const cut = () => new Response('{"txHash":"0xc2c2', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const dropped = () => ({ ok: true, status: 200, headers: new Headers(), json: () => Promise.reject(new TypeError('network error')) }) as unknown as Response;
    const topUp = { services: [{ serviceId: FIXTURE_IDS.llama8b, serviceClass: 'inference' as const, value: '1', maxPricePerUnit: '1' }], idempotencyKey: '0f8fad5b-d9cb-469f-a165-70867728950e' };
    for (const answer of [cut, dropped]) {
      vi.stubGlobal('fetch', async () => answer());
      await expect(marketplaceApi.topUp(`0x${'98'.repeat(32)}`, topUp)).rejects.toMatchObject({ status: 200, code: 'UnreadableAnswer', retryable: true });
      await expect(marketplaceGateway.models(FIXTURE_SECRET)).rejects.toMatchObject({ status: 200, code: 'UnreadableAnswer' });
      vi.unstubAllGlobals();
    }
    vi.stubGlobal('fetch', async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(marketplaceApi.funding()).rejects.toMatchObject({ status: 502, code: 'HTTP_502', retryable: true });
  });
});

describe('marketplace fixture node', () => {
  const world = fixtureWorld(NOW);

  it('answers every read in the shapes of the node, each amount with its TRAC sibling', () => {
    const reads = ['/catalog', `/services/${FIXTURE_IDS.qwen14b}`, `/sellers/${FIXTURE_IDS.sellerA}`, '/subscriptions', '/plan', '/funding',
      '/accounts', '/accounts/contracts', '/activity', '/reconciliation', '/keys', '/seller'];
    for (const path of reads) {
      const a = fixtureAnswer('active', { method: 'GET', url: `/api/marketplace${path}` }, NOW);
      expect(a?.status, path).toBe(200);
      expect(checkSiblings(a!.body), path).toEqual([]);
    }
  });

  it('keeps a budget\'s numbers consistent: left is value less landed, the ceiling 95% of value', () => {
    for (const b of world.current.budgets) {
      expect(BigInt(b.left)).toBe(BigInt(b.value) - BigInt(b.used));
      expect(BigInt(b.softCeiling)).toBe((BigInt(b.value) * 95n) / 100n);
    }
    const covered = world.catalog(true).services.find((s) => s.serviceId === FIXTURE_IDS.qwen14b)!.covered!;
    const b = world.current.budgets[0];
    expect(BigInt(covered.left)).toBe(BigInt(b.left) - BigInt(b.held));
  });

  it('refuses the gateway to anything but an access key', () => {
    const asNode = fixtureAnswer('active', { method: 'GET', url: '/api/marketplace/v1/models', headers: { Authorization: `Bearer ${NODE_TOKEN}` } }, NOW);
    expect(asNode).toMatchObject({ status: 401, body: { error: { code: 'unknown_key', type: 'marketplace' } } });
  });
});
