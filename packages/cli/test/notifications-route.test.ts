import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB, ASSERTION_ACTIVITY_TYPE, ACTIVITY_DIGEST_WINDOW_MS, buildActivityDigestKey, handleNodeUIRequest } from '@origintrail-official/dkg-node-ui';
import { handleNotificationRoutes } from '../src/daemon/routes/notifications.js';

// Caller wallet (the "me" agent). Member of CG_CURATED (as curator) and
// CG_JOINED (as participant); NOT a member of CG_FOREIGN.
const CALLER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const REQUESTER = '0x3333333333333333333333333333333333333333';
const CG_CURATED = `${CALLER}/curated`;
const CG_JOINED = 'someone/joined';
const CG_FOREIGN = 'someone/foreign';

describe('GET/POST /api/notifications (scoped daemon route, A4)', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let db: DashboardDB;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-notif-route-test-'));
    db = new DashboardDB({ dataDir: dir });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
      server = undefined;
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeAgent(opts: { pending?: Record<string, string[]> } = {}) {
    return {
      listContextGraphs: vi.fn(async () => [
        { id: CG_CURATED, uri: '', name: 'Curated CG', curator: `did:dkg:agent:${CALLER}`, callerInvolved: true, isSystem: false },
        { id: CG_JOINED, uri: '', name: 'Joined CG', curator: `did:dkg:agent:${OTHER}`, callerInvolved: true, isSystem: false },
        { id: CG_FOREIGN, uri: '', name: 'Foreign CG', curator: `did:dkg:agent:${OTHER}`, callerInvolved: false, isSystem: false },
      ]),
      listPendingJoinRequests: vi.fn(async (cgId: string) =>
        (opts.pending?.[cgId] ?? []).map((addr) => ({ agentAddress: addr, signature: 's', timestamp: 1, status: 'pending' })),
      ),
    };
  }

  async function startRoute(agent: ReturnType<typeof makeAgent>, requestAgentAddress: string) {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const ctx = {
        req, res, agent, dashDb: db,
        url, path: url.pathname,
        requestAgentAddress,
        requestToken: undefined,
      } as any;
      try {
        await handleNotificationRoutes(ctx);
        if (!res.writableEnded) { res.statusCode = 404; res.end(); }
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  const getNotifs = async () => {
    const res = await fetch(`${baseUrl}/api/notifications`);
    return { status: res.status, body: await res.json() };
  };
  const postRead = async (body: Record<string, unknown>) => {
    const res = await fetch(`${baseUrl}/api/notifications/read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  function activityRow(cgId: string, kind: string, ts: number, actorAddr: string) {
    return db.insertNotification({
      ts, type: ASSERTION_ACTIVITY_TYPE, title: 'a', message: 'm',
      contextGraphId: cgId,
      meta: JSON.stringify({ contextGraphId: cgId, kind, actorAgentDid: `did:dkg:agent:${actorAddr}` }),
    });
  }
  function joinRequestRow(cgId: string, addr: string, ts = 1000) {
    return db.insertNotification({
      ts, type: 'join_request', title: 'j', message: 'm',
      contextGraphId: cgId,
      meta: JSON.stringify({ contextGraphId: cgId, agentAddress: addr, agentName: 'Req' }),
    });
  }

  it('fails closed (scopeUnknown) when the caller is not a wallet agent (peerId fallback)', async () => {
    await startRoute(makeAgent(), '12D3KooWNotAWallet');
    const { status, body } = await getNotifs();
    expect(status).toBe(200);
    expect(body.scopeUnknown).toBe(true);
    expect(body.notifications).toEqual([]);
    expect(body.badgeCount).toBe(0);
  });

  it('scopes activity to member CGs and drops foreign-CG rows + legacy noise', async () => {
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    activityRow(CG_JOINED, 'created', baseTs, OTHER);   // member → kept
    activityRow(CG_FOREIGN, 'created', baseTs, OTHER);  // non-member → dropped
    db.insertNotification({ ts: baseTs, type: 'kc_published', title: 'x', message: 'x', contextGraphId: CG_JOINED }); // noise → dropped

    await startRoute(makeAgent(), CALLER);
    const { body } = await getNotifs();
    expect(body.scopeUnknown).toBeUndefined();
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].type).toBe('assertion_activity');
    expect(body.notifications[0].contextGraphId).toBe(CG_JOINED);
    expect(body.notifications[0].meta.contextGraphName).toBe('Joined CG');
  });

  it('keeps a pending join_request on a curated CG and reconciles away resolved ones (G3)', async () => {
    joinRequestRow(CG_CURATED, REQUESTER);            // still pending → kept
    joinRequestRow(CG_CURATED, OTHER);                // not in pending set → dropped (resolved)
    joinRequestRow(CG_JOINED, REQUESTER);             // joined (not curated) → dropped

    await startRoute(makeAgent({ pending: { [CG_CURATED]: [REQUESTER] } }), CALLER);
    const { body } = await getNotifs();
    const joins = body.notifications.filter((n: any) => n.type === 'join_request');
    expect(joins).toHaveLength(1);
    expect(joins[0].contextGraphId).toBe(CG_CURATED);
    expect(joins[0].meta.agentAddress).toBe(REQUESTER);
    // join_request counts toward the badge.
    expect(body.badgeCount).toBe(1);
  });

  it('POST /read resolves a digestKey to underlying rows AND accepts numeric ids together', async () => {
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    const a1 = activityRow(CG_JOINED, 'created', baseTs, OTHER);
    const a2 = activityRow(CG_JOINED, 'created', baseTs + 10, OTHER);
    const jr = joinRequestRow(CG_CURATED, REQUESTER, baseTs);

    await startRoute(makeAgent({ pending: { [CG_CURATED]: [REQUESTER] } }), CALLER);

    const digestKey = buildActivityDigestKey(CG_JOINED, 'created', baseTs);
    const read = await postRead({ ids: [digestKey, jr] });
    // 2 activity rows (resolved from digestKey) + 1 join_request = 3 rows marked.
    expect(read.body.marked).toBe(3);

    // All now read → badge 0 (rejections never counted; here none).
    const { body } = await getNotifs();
    expect(body.badgeCount).toBe(0);
    // Sanity: the underlying activity rows are marked read.
    const all = db.getNotifications().notifications;
    expect(all.find((n) => n.id === a1)!.read).toBe(1);
    expect(all.find((n) => n.id === a2)!.read).toBe(1);
    expect(all.find((n) => n.id === jr)!.read).toBe(1);
  });

  it('POST /read with empty body marks all read (legacy behaviour preserved)', async () => {
    joinRequestRow(CG_CURATED, REQUESTER);
    await startRoute(makeAgent({ pending: { [CG_CURATED]: [REQUESTER] } }), CALLER);
    const read = await postRead({});
    expect(read.body.marked).toBeGreaterThanOrEqual(1);
  });

  // Dispatch-order guard (ADR-003): in lifecycle.ts the node-ui handler runs
  // BEFORE the agent-aware daemon dispatch. After the clean cut, node-ui must
  // NOT claim /api/notifications (return false) so the request falls through
  // to the daemon route — no double-handling, no leftover 404.
  it('handleNodeUIRequest does NOT claim the notification routes (falls through to daemon)', async () => {
    const noopRes = () => {
      const res: any = {
        statusCode: 200, headersSent: false, _ended: false,
        setHeader() {}, write() {}, writeHead() {},
        end() { this._ended = true; this.headersSent = true; },
      };
      return res;
    };
    const getRes = noopRes();
    const getHandled = await handleNodeUIRequest(
      { method: 'GET', headers: {}, url: '/api/notifications' } as any,
      getRes as any,
      new URL('http://127.0.0.1/api/notifications'),
      db,
      '/fake/static',
    );
    expect(getHandled).toBe(false);
    expect(getRes._ended).toBe(false);

    const postRes = noopRes();
    const postHandled = await handleNodeUIRequest(
      { method: 'POST', headers: {}, url: '/api/notifications/read' } as any,
      postRes as any,
      new URL('http://127.0.0.1/api/notifications/read'),
      db,
      '/fake/static',
    );
    expect(postHandled).toBe(false);
    expect(postRes._ended).toBe(false);
  });
});
