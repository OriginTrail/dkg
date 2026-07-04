// @vitest-environment happy-dom
//
// A1 — PCA client helpers + `describePcaError`. Two halves:
//  1. `describePcaError` / `isPcaFeatureUnavailable` are pure (no transport) —
//     pin every daemon error-code branch and the terminology discipline
//     ("approved publishing wallet", never "agent").
//  2. The `fetchPca`/`createPca`/`pca*` helpers are exercised against a mocked
//     `globalThis.fetch` (the same transport-boundary mock the rest of the
//     api.ts tests use), asserting URL/method/session/body shaping and that
//     failures surface as `HttpError` (incl. the DELETE path via `delJson`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpError,
  describePcaError,
  isPcaFeatureUnavailable,
  isRpcTransportError,
  isPcaReadFailed,
  fetchPca,
  fetchMyPcas,
  listDesignatableNodes,
  createPca,
  pcaAddAgent,
  pcaRemoveAgent,
  pcaTopUp,
  pcaSettle,
  registerContextGraph,
} from '../src/ui/api.js';
import { resetDashboardSession, useAuthenticatedDashboardSession } from './helpers/dashboard-session.js';

describe('describePcaError', () => {
  it('returns null for non-HttpError throwables (falls back to err.message)', () => {
    expect(describePcaError(new Error('network'))).toBeNull();
    expect(describePcaError('string error' as unknown)).toBeNull();
    expect(describePcaError(undefined)).toBeNull();
  });

  it('maps any 503 to FEATURE_UNAVAILABLE regardless of body', () => {
    const out = describePcaError(new HttpError(503, 'whatever', { error: 'long message' }));
    expect(out).not.toBeNull();
    expect(out!.code).toBe('FEATURE_UNAVAILABLE');
    expect(out!.message.toLowerCase()).toContain("aren't available");
  });

  it('isPcaFeatureUnavailable is true only for a CAPABILITY 503 (not a transport blip)', () => {
    expect(isPcaFeatureUnavailable(new HttpError(503))).toBe(true);
    expect(isPcaFeatureUnavailable(new HttpError(503, 'x', { error: 'not available' }))).toBe(true);
    expect(isPcaFeatureUnavailable(new HttpError(400))).toBe(false);
    expect(isPcaFeatureUnavailable(new Error('x'))).toBe(false);
    // A transient RPC-transport 503 must NOT gate the tab.
    expect(
      isPcaFeatureUnavailable(new HttpError(503, 'x', { code: 'RPC_ENDPOINTS_EXHAUSTED' })),
    ).toBe(false);
  });

  it('isPcaReadFailed pins the retryable read-fail apart from a capability 503', () => {
    // The /mine route's retryable chain-read failure — isPcaFeatureUnavailable can't
    // tell it from a capability gap (both non-transport 503s), so this must.
    const readFail = new HttpError(503, 'x', { code: 'PCA_LOOKUP_READ_FAILED' });
    expect(isPcaReadFailed(readFail)).toBe(true);
    expect(isPcaFeatureUnavailable(readFail)).toBe(true); // (documents the overlap the caller resolves)
    expect(isPcaReadFailed(new HttpError(503, 'x', { error: 'FEATURE_UNAVAILABLE' }))).toBe(false);
    expect(isPcaReadFailed(new HttpError(503, 'x', { code: 'RPC_ENDPOINTS_EXHAUSTED' }))).toBe(false);
    expect(isPcaReadFailed(new Error('x'))).toBe(false);
  });

  it('isRpcTransportError detects RPC_* body codes regardless of status', () => {
    expect(isRpcTransportError(new HttpError(503, 'x', { code: 'RPC_ENDPOINTS_EXHAUSTED' }))).toBe(true);
    expect(isRpcTransportError(new HttpError(504, 'x', { code: 'RPC_TIMEOUT' }))).toBe(true);
    expect(isRpcTransportError(new HttpError(503, 'x', { error: 'not available' }))).toBe(false);
    expect(isRpcTransportError(new Error('x'))).toBe(false);
  });

  it('describePcaError maps a transport 503/504 to "try again", NOT "not available on this network"', () => {
    const t503 = describePcaError(new HttpError(503, 'x', { code: 'RPC_ENDPOINTS_EXHAUSTED' }));
    expect(t503!.code).toBe('ServerError');
    expect(t503!.message.toLowerCase()).toContain('temporarily unavailable');
    expect(t503!.message.toLowerCase()).not.toContain("aren't available");
    const t504 = describePcaError(new HttpError(504, 'x', { code: 'RPC_TIMEOUT' }));
    expect(t504!.code).toBe('ServerError');
    expect(t504!.message.toLowerCase()).toContain('temporarily unavailable');
  });

  it('maps 400 InvalidAmount to a friendly amount prompt', () => {
    const out = describePcaError(new HttpError(400, 'InvalidAmount', { error: 'InvalidAmount' }));
    expect(out!.code).toBe('InvalidAmount');
    expect(out!.message).toContain('greater than 0');
  });

  it('maps 400 PrimaryNodeNotInShardingTable', () => {
    const out = describePcaError(
      new HttpError(400, 'PrimaryNodeNotInShardingTable', { error: 'PrimaryNodeNotInShardingTable' }),
    );
    expect(out!.code).toBe('PrimaryNodeNotInShardingTable');
    expect(out!.message.toLowerCase()).toContain('sharding table');
  });

  it('maps 403 NotAccountOwner from the daemon sentence form and names PCA #N', () => {
    const out = describePcaError(
      new HttpError(403, 'x', { error: 'NotAccountOwner — daemon EOA is not the PCA owner' }),
      { accountId: '7' },
    );
    expect(out!.code).toBe('NotAccountOwner');
    expect(out!.message).toContain('PCA #7');
    expect(out!.message.toLowerCase()).toContain("isn't the owner");
  });

  it('maps the GET 404 sentence ("Unknown PCA accountId N") via the status fallback', () => {
    const out = describePcaError(new HttpError(404, 'x', { error: 'Unknown PCA accountId 7' }), {
      accountId: '7',
    });
    expect(out!.code).toBe('UnknownAccount');
    expect(out!.message).toContain("doesn't exist");
  });

  it('maps the write 404 code form (UnknownAccount)', () => {
    const out = describePcaError(new HttpError(404, 'UnknownAccount', { error: 'UnknownAccount' }));
    expect(out!.code).toBe('UnknownAccount');
  });

  it('AgentAlreadyRegistered degrades to "another PCA" without existingAccountId', () => {
    const out = describePcaError(
      new HttpError(409, 'AgentAlreadyRegistered', { error: 'AgentAlreadyRegistered' }),
    );
    expect(out!.code).toBe('AgentAlreadyRegistered');
    expect(out!.message).toContain('another PCA');
    // Terminology discipline: user copy refers to the operational/publishing
    // wallet, never the contract word "agent".
    expect(out!.message.toLowerCase()).not.toContain('agent');
    expect(out!.message).toContain('operational wallet');
    expect(out!.existingAccountId).toBeUndefined();
  });

  it('AgentAlreadyRegistered names PCA #M when the daemon surfaces existingAccountId (B10)', () => {
    const out = describePcaError(
      new HttpError(409, 'AgentAlreadyRegistered', {
        error: 'AgentAlreadyRegistered',
        existingAccountId: 9,
      }),
    );
    expect(out!.code).toBe('AgentAlreadyRegistered');
    expect(out!.existingAccountId).toBe('9');
    expect(out!.message).toContain('PCA #9');
    expect(out!.message).toContain('deregister it there first');
  });

  it('maps the remaining 409 conflict codes', () => {
    expect(
      describePcaError(new HttpError(409, 'x', { error: 'AgentNotRegistered' }))!.code,
    ).toBe('AgentNotRegistered');
    expect(
      describePcaError(new HttpError(409, 'x', { error: 'AgentCapReached' }), { accountId: '3' })!
        .message,
    ).toContain('100 approved publishing wallets');
    expect(describePcaError(new HttpError(409, 'x', { error: 'AccountExpired' }))!.code).toBe(
      'AccountExpired',
    );
    expect(
      describePcaError(new HttpError(409, 'x', { error: 'AccountAlreadyFullySettled' }))!.code,
    ).toBe('AccountAlreadyFullySettled');
  });

  it('falls back to the daemon validation sentence on an unrecognised 400 (BadRequest)', () => {
    const out = describePcaError(
      new HttpError(400, 'x', { error: 'tokens must be a positive decimal number of TRAC tokens' }),
    );
    expect(out!.code).toBe('BadRequest');
    expect(out!.message).toContain('positive decimal');
  });

  it('maps 5xx to a generic ServerError', () => {
    const out = describePcaError(new HttpError(500, 'x', { error: 'createPublishingConvictionAccount failed: boom' }));
    expect(out!.code).toBe('ServerError');
    expect(out!.message.toLowerCase()).toContain('something went wrong');
  });
});

describe('PCA api helpers (transport shaping)', () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    useAuthenticatedDashboardSession({
      csrfToken: 'csrf-123',
      expiresAt: Date.now() + 60_000,
    });
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    resetDashboardSession();
  });

  function ok(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as any;
  }
  function fail(status: number, body: unknown) {
    return { ok: false, status, json: async () => body } as any;
  }

  it('fetchPca GETs the snapshot with session credentials and no key by default', async () => {
    fetchMock.mockResolvedValueOnce(ok({ accountId: '1', owner: '0xowner' }));
    const snap = await fetchPca('1');
    expect(snap.accountId).toBe('1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/pca/1');
    expect(init?.method ?? 'GET').toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(init?.credentials).toBe('same-origin');
  });

  it('fetchPca appends ?key= when probing a wallet', async () => {
    fetchMock.mockResolvedValueOnce(ok({ accountId: '1', probedKey: { key: '0xabc', registered: true } }));
    await fetchPca('1', '0xABC');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/pca/1?key=0xABC');
  });

  it('fetchPca appends ?extended=1 only when opts.extended is set (P2), and combines with key', async () => {
    fetchMock.mockResolvedValueOnce(ok({ accountId: '1', primaryNode: '42' }));
    const extended = await fetchPca('1', undefined, { extended: true });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pca/1?extended=1');
    expect(extended.extendedRequested).toBe(true);

    fetchMock.mockResolvedValueOnce(ok({ accountId: '1' }));
    const probedExtended = await fetchPca('1', '0xabc', { extended: true });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/pca/1?key=0xabc&extended=1');
    expect(probedExtended.extendedRequested).toBe(true);

    // P0 default: no extended param.
    fetchMock.mockResolvedValueOnce(ok({ accountId: '1' }));
    const basic = await fetchPca('1');
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/pca/1');
    expect(basic.extendedRequested).toBeUndefined();
  });

  it('fetchMyPcas GETs /api/pca/mine, adding ?hydrate=1 only when requested', async () => {
    fetchMock.mockResolvedValueOnce(ok({ accounts: [] }));
    await fetchMyPcas();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pca/mine');

    fetchMock.mockResolvedValueOnce(ok({ accounts: [] }));
    await fetchMyPcas({ hydrate: true });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/pca/mine?hydrate=1');
  });

  it('listDesignatableNodes GETs the whole list in one shot (R4 — no pagination), +?fresh=1 on demand', async () => {
    fetchMock.mockResolvedValueOnce(ok({ nodes: [], total: 0 }));
    await listDesignatableNodes();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pca/designatable-nodes');

    // M4 — fresh:true appends ?fresh=1 (cache-bust); absent otherwise.
    fetchMock.mockResolvedValueOnce(ok({ nodes: [], total: 0 }));
    await listDesignatableNodes({ fresh: true });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/pca/designatable-nodes?fresh=1');
  });

  // T1 — a GET failure must throw an HttpError that CARRIES the body, so the tab-gate
  // can tell a transient transport 503 (RPC_* code) from the capability 503. Guards
  // against a bodyless-HttpError regression.
  it('fetchPca GET-failure carries the body — transport 503 (RPC_*) ≠ capability 503', async () => {
    fetchMock.mockResolvedValueOnce(fail(503, { code: 'RPC_ENDPOINTS_EXHAUSTED' }));
    const transportErr = await fetchPca('0').catch((e) => e);
    expect(transportErr).toBeInstanceOf(HttpError);
    expect(isRpcTransportError(transportErr)).toBe(true);
    expect(isPcaFeatureUnavailable(transportErr)).toBe(false); // transport, NOT capability
    expect(describePcaError(transportErr)?.message).toContain('temporarily unavailable');

    fetchMock.mockResolvedValueOnce(fail(503, { error: 'FEATURE_UNAVAILABLE' }));
    const capErr = await fetchPca('0').catch((e) => e);
    expect(isPcaFeatureUnavailable(capErr)).toBe(true); // capability gate
  });

  it('createPca POSTs { tokens, primaryNode } as JSON with session CSRF', async () => {
    fetchMock.mockResolvedValueOnce(ok({ accountId: '5', committedTokens: '100000.0' }));
    const res = await createPca({ tokens: '100000', primaryNode: '42' });
    expect(res.accountId).toBe('5');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/pca');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-DKG-CSRF']).toBe('csrf-123');
    expect(JSON.parse(init.body as string)).toEqual({ tokens: '100000', primaryNode: '42' });
  });

  it('pcaAddAgent POSTs { agent } to the /agent route', async () => {
    fetchMock.mockResolvedValueOnce(ok({ accountId: '1', agent: '0xabc', registered: true }));
    await pcaAddAgent('1', '0xabc');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/pca/1/agent');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ agent: '0xabc' });
  });

  it('pcaTopUp POSTs { tokens } to /funds and pcaSettle POSTs {} to /settle', async () => {
    fetchMock.mockResolvedValueOnce(ok({ accountId: '1', addedTokens: '50000.0' }));
    await pcaTopUp('1', '50000');
    let [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/pca/1/funds');
    expect(JSON.parse(init.body as string)).toEqual({ tokens: '50000' });

    fetchMock.mockResolvedValueOnce(ok({ accountId: '1', settled: true }));
    await pcaSettle('1');
    [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('/api/pca/1/settle');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('pcaRemoveAgent DELETEs the wallet and surfaces failures as HttpError (delJson)', async () => {
    fetchMock.mockResolvedValueOnce(ok({ accountId: '1', agent: '0xabc', deregistered: true }));
    const res = await pcaRemoveAgent('1', '0xabc');
    expect(res.deregistered).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/pca/1/agent/0xabc');
    expect(init.method).toBe('DELETE');

    // A 403 on DELETE must throw an HttpError (NOT the bare Error the legacy
    // `del` throws), so the UI can map it via describePcaError.
    fetchMock.mockResolvedValueOnce(fail(403, { error: 'NotAccountOwner — daemon EOA is not the PCA owner' }));
    await expect(pcaRemoveAgent('1', '0xabc')).rejects.toBeInstanceOf(HttpError);
  });

  it('a POST failure surfaces as an HttpError carrying status + body', async () => {
    fetchMock.mockResolvedValueOnce(fail(409, { error: 'AgentAlreadyRegistered' }));
    const err = await pcaAddAgent('1', '0xabc').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    const mapped = describePcaError(err);
    expect(mapped!.code).toBe('AgentAlreadyRegistered');
  });

  // R1 — the CG→PCA bind key is financially load-bearing: a dropped/misspelled
  // `pcaAccountId` means the daemon ignores the binding and publishes silently
  // fall through to full price (the #1 PCA footgun). Guard the WIRE body + the
  // conditional spread (the component-level C6 test only pins the helper args).
  it('registerContextGraph POSTs { id, pcaAccountId } and omits it with no opts (CG-bind wire guard)', async () => {
    fetchMock.mockResolvedValueOnce(ok({ registered: 'cg-1', onChainId: '1', txHash: '0x1' }));
    await registerContextGraph('cg-1', { pcaAccountId: '7' });
    let [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/context-graph/register');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'cg-1', pcaAccountId: '7' });

    // Conditional spread: no opts → no pcaAccountId key (never `pcaAccountId: undefined`).
    fetchMock.mockResolvedValueOnce(ok({ registered: 'cg-1', onChainId: '1', txHash: '0x2' }));
    await registerContextGraph('cg-1');
    [url, init] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(init.body as string)).toEqual({ id: 'cg-1' });

    // O3 — the S3 bind forces curated publishPolicy:0 alongside pcaAccountId
    // (publishPolicy:0 must serialize even though it's falsy).
    fetchMock.mockResolvedValueOnce(ok({ registered: 'cg-1', onChainId: '1', txHash: '0x3' }));
    await registerContextGraph('cg-1', { pcaAccountId: '7', publishPolicy: 0 });
    [url, init] = fetchMock.mock.calls[2]!;
    expect(JSON.parse(init.body as string)).toEqual({ id: 'cg-1', pcaAccountId: '7', publishPolicy: 0 });
  });
});
