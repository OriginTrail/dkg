// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_KEY_RE, MarketplaceError, errorOf, isMarketplaceOff, marketplaceApi, marketplaceGateway, needsNodeAdmin,
} from '../src/ui/marketplace/api/client.js';
import { FIXTURE_IDS, FIXTURE_SECRET, FIXTURE_SCENARIOS, fixtureAnswer, fixtureFetch, fixtureWorld, tracWei } from '../src/ui/marketplace/api/fixtures.js';

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

  it('reads PlanNotFound as no plan, and a missing route or a dead node as errors', async () => {
    stubNode('none');
    expect(await marketplaceApi.plan()).toBeNull();
    expect(errorOf(404, { error: 'Not found' })).toMatchObject({ code: 'NotFound', retryable: false });
    expect(errorOf(409, { error: 'InsufficientAllowance(7, 664, 5, 2)', code: 'InsufficientAllowance', args: ['7', '664', '5', '2'], retryable: false }))
      .toMatchObject({ code: 'InsufficientAllowance', args: ['7', '664', '5', '2'] });
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await expect(marketplaceApi.funding()).rejects.toMatchObject({ status: 0, code: 'Offline', retryable: true });
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
