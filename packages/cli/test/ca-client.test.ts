/**
 * `ApiClient.ca`: the daemon API client of Conviction Account service
 * spending (OT-RFC-27). Each method sends its route's method, path and body
 * with the bearer token; a funding carries a period id so a lost answer can be
 * repeated; error answers keep the route's body.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient, DaemonOutcomeUnknownError } from '../src/api-client.js';
import { newCaPeriodId, type CaConsentResponse } from '../src/ca-client.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Sent { method: string; url: string; body: unknown; authorization: string | undefined }

/** A daemon that answers every request with `body` and `status`, recording what it was sent. */
function daemon(body: unknown = {}, status = 200): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return sent;
}

const BUYER = '0x' + '22'.repeat(20);
const TERMS = {
  accountId: '42', assignee: BUYER, maxCostPerPeriod: '1', maxInferenceCostPerPeriod: '1', maxQueryCostPerPeriod: '0',
  maxCostPerWindow: '0', maxTotalCost: '1', maxPeriodSeconds: 86_400, expiresAt: 4_000_000_000, nonce: '0',
};
const PLAN = {
  periodSeconds: 2_592_000, planDigest: '0x' + 'd1'.repeat(32),
  buckets: [{ bucketId: '0x' + '01'.repeat(32), serviceClass: 'inference' as const, value: '10', maxAskWeiPerUnit: '2500000000000' }],
};

describe('ApiClient.ca', () => {
  it('sends each route its method, path and body, with the token', async () => {
    const sent = daemon();
    const client = new ApiClient(8899, 'test-token');
    const consent: CaConsentResponse = {
      terms: TERMS, digest: '0x' + 'aa'.repeat(32), assigneeSignature: '0x' + 'bb'.repeat(65),
      domain: { name: 'DKGConvictionServices', version: '1', chainId: 31337, verifyingContract: BUYER },
    };
    await client.ca.contracts();
    await client.ca.mine();
    await client.ca.status(42n);
    await client.ca.setServices('42', true);
    await client.ca.consent(42, { maxCostPerPeriod: '25', maxTotalCost: '1000', expiresAt: '2026-11-30T00:00:00Z' });
    // A consent answer is an assignment body as it is.
    await client.ca.assign(42, consent);
    await client.ca.assignments(42);
    await client.ca.revoke(42, BUYER);
    await client.ca.updateCaps(42, BUYER, { maxCostPerWindow: '50' });
    await client.ca.advanceNonce(42);
    await client.ca.labels(42);
    await client.ca.labels(42, { from: 1201, to: 1210 });
    await client.ca.periods(42, { offset: 50, limit: 10 });
    await client.ca.fund(42, { ...PLAN, periodId: '0x' + 'a1'.repeat(32) });
    const base = 'http://127.0.0.1:8899/api/ca';
    expect(sent.map((s) => [s.method, s.url.replace(base, ''), s.body])).toEqual([
      ['GET', '/contracts', undefined],
      ['GET', '/mine', undefined],
      ['GET', '/42', undefined],
      ['POST', '/42/services', { enabled: true }],
      ['POST', '/42/consent', { maxCostPerPeriod: '25', maxTotalCost: '1000', expiresAt: '2026-11-30T00:00:00Z' }],
      ['POST', '/42/assignments', consent],
      ['GET', '/42/assignments', undefined],
      ['DELETE', `/42/assignments/${BUYER}`, undefined],
      ['POST', `/42/assignments/${BUYER}/caps`, { maxCostPerWindow: '50' }],
      ['POST', '/42/nonce', {}],
      ['GET', '/42/labels', undefined],
      ['GET', '/42/labels?from=1201&to=1210', undefined],
      ['GET', '/42/periods?offset=50&limit=10', undefined],
      ['POST', '/42/periods', { ...PLAN, periodId: '0x' + 'a1'.repeat(32) }],
    ]);
    expect(new Set(sent.map((s) => s.authorization))).toEqual(new Set(['Bearer test-token']));
  });

  it('encodes the path parameters', async () => {
    const sent = daemon();
    await new ApiClient(8899).ca.revoke('4 2', 'a/b');
    expect(sent[0]!.url).toBe('http://127.0.0.1:8899/api/ca/4%202/assignments/a%2Fb');
  });

  it('funds with a period id of its own when the plan has none', async () => {
    const sent = daemon();
    const client = new ApiClient(8899);
    await client.ca.fund(42, PLAN);
    await client.ca.fund(42, PLAN);
    const [first, second] = sent.map((s) => (s.body as { periodId: string }).periodId);
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(newCaPeriodId()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reports a funding whose answer never came as outcome unknown, naming its period id', async () => {
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch;
    const client = new ApiClient(8899, undefined, { readTimeoutMs: 20, longTimeoutMs: 50 });
    const periodId = '0x' + 'a7'.repeat(32);
    const err = await client.ca.fund(42, { ...PLAN, periodId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonOutcomeUnknownError);
    expect((err as Error).message).toContain(`repeat with periodId ${periodId}`);
    const assign = await client.ca.assign(42, { terms: TERMS, assigneeSignature: '0x00' }).catch((e: unknown) => e);
    expect(assign).toBeInstanceOf(DaemonOutcomeUnknownError);
    expect((assign as Error).message).toContain('GET /api/ca/42/assignments');
  });

  it('throws an error answer with its status and the route\'s body', async () => {
    const body = { error: 'CapExceeded', accountId: '42', args: { cap: 'maxTotalCost', limit: '5', attempted: '7' } };
    daemon(body, 409);
    const err = await new ApiClient(8899).ca.fund(42, PLAN).catch((e: unknown) => e);
    expect(err).toMatchObject({ httpStatus: 409, message: 'CapExceeded', responseBody: body });
  });
});
