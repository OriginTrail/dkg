/**
 * #1365 🔴 — `pca_cost_covered` is WALLET-scoped, not CG-membership-scoped, and
 * (round-2) is fetched on a DEDICATED by-wallet query so a busy node's
 * higher-volume join/other confirmations can't age a non-member publisher's
 * older discount rows out of the shared window.
 *
 * A real PCA-covered publish needs a StorageACK quorum (multi-node) and the
 * live daemon runs in a child process, so this drives `handleNotificationRoutes`
 * directly with a fake `dashDb`/agent whose caller is a member of NO context
 * graph — proving the dedicated `getPcaCostCoveredRowsForWallet` fetch surfaces
 * + marks-read the discount alert, and that pca is NOT folded into the shared
 * join `getNotificationsOfTypes` window.
 */
import { describe, it, expect } from 'vitest';
import { handleNotificationRoutes } from '../src/daemon/routes/notifications.js';
import type { RouteRequestContext } from '../src/daemon/routes/context.js';

const CALLER = '0xaaaa000000000000000000000000000000000001';
const OTHER = '0xbbbb000000000000000000000000000000000002';
const TOKEN = 'tok-caller';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (s: number) => { res.statusCode = s; };
  res.end = (b: string) => { res.body = b; };
  return res;
}
function fakeReq(method: string, path: string, body?: unknown) {
  const req: any = { method, url: path };
  if (body !== undefined) {
    req.__dkgPrebufferedBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  }
  return req;
}

function pcaRow(id: number, publisher: string, read = 0) {
  return {
    id, ts: 1000 + id, type: 'pca_cost_covered',
    title: 'Publishing discount applied', message: 'm', source: 'pca', peer: null, read,
    // A CG the caller is NOT a member of (sponsored-edge scenario).
    context_graph_id: 'cg-published',
    meta: JSON.stringify({
      contextGraphId: 'cg-published', publisherAddress: publisher, accountId: '7', epoch: 42,
      baseCost: '1000', discountedCost: '700', drawnFromEpoch: '500', drawnFromTopUp: '200',
    }),
  };
}

// Default fake dashDb: caller is in no member CG, no join confirmations, and the
// dedicated by-wallet PCA fetch returns ONLY the caller's own rows (mirrors the
// SQL `WHERE meta.publisherAddress = ?`). Override per test.
function fakeDb(over: Record<string, any> = {}) {
  return {
    getNotificationsForContextGraphs: () => [],
    getNotificationsOfTypes: () => [],
    getPcaCostCoveredRowsForWallet: (w: string) => (w.toLowerCase() === CALLER ? [pcaRow(1, CALLER)] : []),
    getScopedNotificationRowIds: () => new Set<number>(),
    markNotificationsRead: (ids: number[]) => ids.length,
    resolveActivityDigestRowIds: () => [],
    ...over,
  };
}

function makeCtx(
  method: string,
  path: string,
  dashDb: any,
  body?: unknown,
  agentOverrides: Record<string, unknown> = {},
): { ctx: RouteRequestContext; res: any } {
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${path}`);
  const agent = {
    resolveAgentByToken: () => `did:dkg:agent:${CALLER}`,
    getDefaultAgentAddress: () => `did:dkg:agent:${CALLER}`,
    // Caller curates / belongs to NOTHING → memberCgIds + curatedCgIds empty.
    listContextGraphs: async () => [],
    listPendingJoinRequests: async () => [],
    ...agentOverrides,
  };
  const ctx = {
    req: fakeReq(method, path, body), res, agent, dashDb,
    path: url.pathname, url, requestToken: TOKEN,
  } as unknown as RouteRequestContext;
  return { ctx, res };
}

describe('#1365 — pca_cost_covered is wallet-scoped via a dedicated fetch (GET/POST /api/notifications)', () => {
  it('a NON-member publisher receives its confirmed-discount alert (+ badge)', async () => {
    const { ctx, res } = makeCtx('GET', '/api/notifications', fakeDb());
    await handleNotificationRoutes(ctx);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].type).toBe('pca_cost_covered');
    expect(body.notifications[0].meta.publisherAddress).toBe(CALLER);
    expect(body.notifications[0].meta.epoch).toBe(42);
    expect(body.badgeCount).toBe(1);
  });

  it('does NOT fold pca into the shared join window, and an older PCA row survives many newer join confirmations (no cap-hiding, round-2)', async () => {
    let typesAsked: string[] = [];
    let pcaFetchedFor: string | undefined;
    // The shared join window is "full" of newer join confirmations...
    const joinRows = Array.from({ length: 200 }, (_, i) => ({
      id: 1000 + i, ts: 50_000 + i, type: 'join_approved',
      title: 'j', message: 'j', source: null, peer: null, read: 0,
      context_graph_id: 'cg-x',
      meta: JSON.stringify({ contextGraphId: 'cg-x', agentAddress: CALLER }),
    }));
    const dashDb = fakeDb({
      getNotificationsOfTypes: (types: string[]) => { typesAsked = types; return joinRows; },
      // ...but the OLDER discount row comes from its OWN dedicated fetch.
      getPcaCostCoveredRowsForWallet: (w: string) => { pcaFetchedFor = w; return [pcaRow(1, CALLER)]; },
    });
    const { ctx, res } = makeCtx('GET', '/api/notifications', dashDb);
    await handleNotificationRoutes(ctx);
    const body = JSON.parse(res.body);
    // pca is NOT in the cap-shared join fetch...
    expect(typesAsked).not.toContain('pca_cost_covered');
    // ...it's pulled by the dedicated by-wallet fetch...
    expect(pcaFetchedFor?.toLowerCase()).toBe(CALLER);
    // ...so the discount row is present despite the full join window.
    expect(body.notifications.some((n: any) => n.type === 'pca_cost_covered')).toBe(true);
  });

  it('drops a wrong-wallet discount row at the wire layer (defense in depth)', async () => {
    // Even if the fetch returned a foreign row, scopeNotifications re-enforces.
    const dashDb = fakeDb({ getPcaCostCoveredRowsForWallet: () => [pcaRow(1, OTHER)] });
    const { ctx, res } = makeCtx('GET', '/api/notifications', dashDb);
    await handleNotificationRoutes(ctx);
    expect(JSON.parse(res.body).notifications).toHaveLength(0);
  });

  it('the non-member publisher can mark its PCA alert read (id in the caller-scoped set)', async () => {
    let marked: number[] = [];
    const dashDb = fakeDb({ markNotificationsRead: (ids: number[]) => { marked = ids; return ids.length; } });
    const { ctx, res } = makeCtx('POST', '/api/notifications/read', dashDb, { ids: [1] });
    await handleNotificationRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(marked).toContain(1);
    expect(JSON.parse(res.body).marked).toBe(1);
  });

  it('does not let same-CG membership mark another publisher’s PCA discount row read', async () => {
    let marked: number[] = [];
    let memberRowsLimit: number | undefined;
    const dashDb = fakeDb({
      getScopedNotificationRowIds: () => new Set<number>([2, 9]),
      getNotificationsForContextGraphs: (_cgIds: string[], limit: number) => {
        memberRowsLimit = limit;
        return [pcaRow(2, OTHER)];
      },
      getPcaCostCoveredRowsForWallet: () => [pcaRow(1, CALLER)],
      markNotificationsRead: (ids: number[]) => { marked = ids; return ids.length; },
    });
    const { ctx, res } = makeCtx(
      'POST',
      '/api/notifications/read',
      dashDb,
      { ids: [1, 2, 9] },
      {
        listContextGraphs: async () => [{
          id: 'cg-published',
          name: 'Published CG',
          curator: `did:dkg:agent:${OTHER}`,
          callerInvolved: true,
        }],
      },
    );
    await handleNotificationRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(memberRowsLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(marked.sort((a, b) => a - b)).toEqual([1, 9]);
    expect(marked).not.toContain(2);
  });
});
