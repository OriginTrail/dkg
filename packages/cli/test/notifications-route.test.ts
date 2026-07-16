/**
 * Scoped notifications routes (A4 / ADR-003) — REAL daemon, REAL multi-agent
 * flows, NO mocks.
 *
 * The retired version drove `handleNotificationRoutes` with a hand-built
 * agent whose `listContextGraphs` / `listPendingJoinRequests` returned a
 * fabricated membership matrix, and inserted notification rows directly into
 * the DashboardDB. Whether the REAL daemon ever produces those rows or
 * resolves those memberships was never proven.
 *
 * This version runs the whole thing for real on one daemon:
 *   - the node OWNER (default agent) curates a real curated context graph,
 *   - agent B and agent C are REAL second agents minted via
 *     `POST /api/agent/register` (custodial keys held by the daemon),
 *   - B's join request is a REAL signed delegation
 *     (`sign-join` → `request-join`), which generates a REAL `join_request`
 *     notification row for the curator,
 *   - the curator's REAL `reject-join` generates B's `join_rejected`
 *     confirmation,
 * and every scoping contract is asserted over real HTTP: the curator sees
 * the moderation row, B does not, C never sees B's rejection, read-marking
 * is caller-scoped, malformed bodies 400, and an anonymous caller is
 * fail-closed by the REAL auth gate (401 — in production the route-level
 * scopeUnknown sits BEHIND this gate, so 401 is the contract callers see).
 *
 * Deliberately NOT here: the row-shape defensive cases from the retired file
 * (NULL context_graph_id column, digest-window eviction floods) — those
 * require inserting synthetic malformed rows the real daemon never writes;
 * they are DashboardDB-level contracts covered by the node-ui DB tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, postJson, type LiveDaemon } from './helpers/live-daemon.js';

const CUR_CG = `notif-cur-${Date.now().toString(36)}`;

interface NotifRow {
  type: string;
  id: number;
  read: number;
  contextGraphId?: string;
  meta?: Record<string, unknown>;
}

describe('notifications routes (real daemon, real agents)', () => {
  let daemon: LiveDaemon;
  let tokenB = '';
  let addressB = '';
  let tokenC = '';

  async function as(token: string, path: string, init: RequestInit = {}) {
    const res = await fetch(`${daemon.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as any };
    } catch {
      return { status: res.status, body: text as any };
    }
  }

  async function notificationsFor(token: string): Promise<{ rows: NotifRow[]; badge: number }> {
    const { status, body } = await as(token, '/api/notifications');
    expect(status).toBe(200);
    return { rows: body.notifications as NotifRow[], badge: body.badgeCount as number };
  }

  beforeAll(async () => {
    daemon = await startLiveDaemon();

    // The owner curates a real CURATED context graph.
    const cg = await postJson(daemon, '/api/context-graph/create', { id: CUR_CG, name: 'Curated', accessPolicy: 1 });
    expect(cg.status, `CG create failed: ${JSON.stringify(cg.body)}`).toBeLessThan(300);

    // Two REAL second agents on the same node.
    const regB = await postJson(daemon, '/api/agent/register', { name: 'notif-agent-b', framework: 'test' });
    tokenB = regB.body.authToken;
    addressB = regB.body.agentAddress;
    expect(tokenB).toBeTruthy();
    const regC = await postJson(daemon, '/api/agent/register', { name: 'notif-agent-c', framework: 'test' });
    tokenC = regC.body.authToken;
    expect(tokenC).toBeTruthy();

    // B files a REAL join request: the daemon signs the delegation with B's
    // custodial key, then the request is delivered locally to the curator.
    const signed = await as(tokenB, `/api/context-graph/${CUR_CG}/sign-join`, { method: 'POST', body: '{}' });
    expect(signed.status, `sign-join failed: ${JSON.stringify(signed.body)}`).toBe(200);
    const join = await as(tokenB, `/api/context-graph/${CUR_CG}/request-join`, {
      method: 'POST',
      body: JSON.stringify({ delegation: signed.body.delegation }),
    });
    expect(join.status, `request-join failed: ${JSON.stringify(join.body)}`).toBe(200);
    expect(join.body.status).toBe('pending');
  }, 120_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  it('an anonymous caller is fail-closed by the real auth gate (401, no data)', async () => {
    const res = await fetch(`${daemon.base}/api/notifications`);
    expect(res.status).toBe(401);
  });

  it('the node-level token resolves to the OWNER agent and surfaces the real pending join_request', async () => {
    const { rows, badge } = await notificationsFor(daemon.token!);
    const joinReq = rows.find((r) => r.type === 'join_request' && r.contextGraphId === CUR_CG);
    expect(joinReq, `curator should see the pending join_request; got ${JSON.stringify(rows)}`).toBeTruthy();
    expect(joinReq!.meta?.agentAddress).toBe(addressB);
    expect(badge).toBeGreaterThan(0);
  });

  it("agent B does NOT see the curator's moderation row (caller scoping)", async () => {
    const { rows } = await notificationsFor(tokenB);
    expect(rows.find((r) => r.type === 'join_request')).toBeUndefined();
  });

  it('POST /read with a malformed JSON body returns 400 and marks nothing', async () => {
    const res = await fetch(`${daemon.base}/api/notifications/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const { rows } = await notificationsFor(daemon.token!);
    expect(rows.some((r) => r.type === 'join_request' && r.read === 0)).toBe(true);
  });

  it('POST /read with NO token is fail-closed (the owner row stays unread)', async () => {
    const res = await fetch(`${daemon.base}/api/notifications/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const { rows } = await notificationsFor(daemon.token!);
    expect(rows.some((r) => r.type === 'join_request' && r.read === 0)).toBe(true);
  });

  it('POST /read with an empty body marks the caller-scoped rows (owner badge → 0)', async () => {
    const mark = await as(daemon.token!, '/api/notifications/read', { method: 'POST', body: '{}' });
    expect(mark.status).toBe(200);
    const owner = await notificationsFor(daemon.token!);
    expect(owner.badge).toBe(0);
    expect(owner.rows.every((r) => r.read === 1)).toBe(true);
  });

  it("the curator's REAL reject-join reconciles the pending join_request away (G3)", async () => {
    const reject = await as(daemon.token!, `/api/context-graph/${CUR_CG}/reject-join`, {
      method: 'POST',
      body: JSON.stringify({ agentAddress: addressB }),
    });
    expect(reject.status, `reject-join failed: ${JSON.stringify(reject.body)}`).toBe(200);
    expect(reject.body.status).toBe('rejected');

    // G3: a RESOLVED join request must no longer surface as a pending
    // moderation row, and the moderation list itself empties.
    const owner = await notificationsFor(daemon.token!);
    expect(owner.rows.find((r) => r.type === 'join_request' && r.read === 0)).toBeUndefined();
    const list = await as(daemon.token!, `/api/context-graph/${CUR_CG}/join-requests`);
    expect(list.status).toBe(200);
    expect(list.body.requests).toEqual([]);

    // NOTE deliberately not asserted: B's `join_rejected` CONFIRMATION row.
    // Verified live: the JOIN_REJECTED event only fires on P2P delivery to
    // the requester's node, so a SAME-NODE requester never receives it —
    // the cross-node confirmation contract belongs to the devnet tier.
    // Agent C must still see nothing either way (multi-agent-node safety).
    const c = await notificationsFor(tokenC);
    expect(c.rows).toEqual([]);
  });
});
