/**
 * #1365 round-1 🔴 — `pca_cost_covered` is WALLET-scoped, not CG-membership-
 * scoped, so the read + mark-read paths must fetch it by the caller's wallet
 * (not only via the member-CG read). A real PCA-covered publish needs a
 * StorageACK quorum (multi-node) and the live daemon runs in a child process,
 * so this drives `handleNotificationRoutes` directly with a fake ctx whose
 * caller is a member of NO context graph — proving the by-wallet fetch
 * (`callerConfirmationRows`) surfaces + marks-read the discount alert anyway.
 */
import { describe, it, expect } from 'vitest';
import { handleNotificationRoutes } from '../src/daemon/routes/notifications.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

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

function makeCtx(method: string, path: string, dashDb: any, body?: unknown): { ctx: RequestContext; res: any } {
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${path}`);
  const agent = {
    resolveAgentByToken: () => `did:dkg:agent:${CALLER}`,
    getDefaultAgentAddress: () => `did:dkg:agent:${CALLER}`,
    // Caller curates / belongs to NOTHING → memberCgIds + curatedCgIds empty.
    listContextGraphs: async () => [],
    listPendingJoinRequests: async () => [],
  };
  const ctx = {
    req: fakeReq(method, path, body), res, agent, dashDb,
    path: url.pathname, url, requestToken: TOKEN,
  } as unknown as RequestContext;
  return { ctx, res };
}

describe('#1365 🔴 — pca_cost_covered is wallet-scoped in GET/POST /api/notifications', () => {
  it('a NON-member publisher still receives its confirmed-discount alert (by-wallet fetch + badge)', async () => {
    const dashDb = {
      getNotificationsForContextGraphs: () => [],
      getNotificationsOfTypes: (types: string[]) =>
        types.includes('pca_cost_covered') ? [pcaRow(1, CALLER)] : [],
    };
    const { ctx, res } = makeCtx('GET', '/api/notifications', dashDb);
    await handleNotificationRoutes(ctx);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].type).toBe('pca_cost_covered');
    expect(body.notifications[0].meta.publisherAddress).toBe(CALLER);
    expect(body.notifications[0].meta.epoch).toBe(42);
    expect(body.badgeCount).toBe(1);
  });

  it('drops the alert for a DIFFERENT publisher wallet (no cross-wallet leak)', async () => {
    const dashDb = {
      getNotificationsForContextGraphs: () => [],
      getNotificationsOfTypes: () => [pcaRow(1, OTHER)],
    };
    const { ctx, res } = makeCtx('GET', '/api/notifications', dashDb);
    await handleNotificationRoutes(ctx);
    expect(JSON.parse(res.body).notifications).toHaveLength(0);
  });

  it('the non-member publisher can mark its PCA alert read (id in the caller-scoped set)', async () => {
    let marked: number[] = [];
    const dashDb = {
      getNotificationsForContextGraphs: () => [],
      getNotificationsOfTypes: () => [pcaRow(1, CALLER)],
      getScopedNotificationRowIds: () => new Set<number>(), // no member-CG rows
      markNotificationsRead: (ids: number[]) => { marked = ids; return ids.length; },
      resolveActivityDigestRowIds: () => [],
    };
    const { ctx, res } = makeCtx('POST', '/api/notifications/read', dashDb, { ids: [1] });
    await handleNotificationRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(marked).toContain(1);
    expect(JSON.parse(res.body).marked).toBe(1);
  });
});
