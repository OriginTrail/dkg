import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DashboardDB } from '../src/db.js';
import { handleNodeUIRequest } from '../src/api.js';

// --- DB test setup ---

let db: DashboardDB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-db-test-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeNotification(overrides: Partial<{ ts: number; type: string; title: string; message: string; source: string; peer: string }> = {}) {
  return {
    ts: overrides.ts ?? Date.now(),
    type: overrides.type ?? 'info',
    title: overrides.title ?? 'Test',
    message: overrides.message ?? 'test notification',
    source: overrides.source ?? null,
    peer: overrides.peer ?? null,
  };
}

// --- Real HTTP harness ---
//
// Boots an actual `node:http` server that delegates to `handleNodeUIRequest`,
// rebinding the active `db` reference per request via the `getDb` closure so
// each `beforeEach` swap of `db` is picked up automatically. Tests then make
// real `fetch` calls into the server — exactly the wire format production
// daemons receive (gzip streams, `Content-Length`, header casing, etc.) — so
// any divergence between the hand-rolled fake req/res and what node:http
// actually sends is no longer hidden.
let server: Server;
let baseUrl: string;
const getDb = (): DashboardDB => db;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    handleNodeUIRequest(req, res, url, getDb(), '/fake/static').then((handled) => {
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.end('Not Found');
      }
    }).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// --- DashboardDB notification tests ---

describe('DashboardDB — notifications', () => {
  it('insertNotification returns a numeric id', () => {
    const id = db.insertNotification(makeNotification());
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('getNotifications returns empty list and 0 unreadCount when no notifications', () => {
    const { notifications, unreadCount } = db.getNotifications();
    expect(notifications).toHaveLength(0);
    expect(unreadCount).toBe(0);
  });

  it('returns notifications sorted by ts DESC with correct unreadCount', () => {
    db.insertNotification(makeNotification({ ts: 1000, title: 'first' }));
    db.insertNotification(makeNotification({ ts: 2000, title: 'second' }));
    db.insertNotification(makeNotification({ ts: 3000, title: 'third' }));

    const { notifications, unreadCount } = db.getNotifications();
    expect(notifications).toHaveLength(3);
    expect(unreadCount).toBe(3);
    expect(notifications[0].ts).toBe(3000);
    expect(notifications[1].ts).toBe(2000);
    expect(notifications[2].ts).toBe(1000);
  });

  it('markNotificationsRead() with no ids marks all as read', () => {
    db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));
    db.insertNotification(makeNotification({ ts: 3000 }));

    db.markNotificationsRead();
    const { unreadCount } = db.getNotifications();
    expect(unreadCount).toBe(0);
  });

  it('markNotificationsRead([id]) marks only the specified one', () => {
    const id1 = db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));
    db.insertNotification(makeNotification({ ts: 3000 }));

    db.markNotificationsRead([id1]);
    const { notifications, unreadCount } = db.getNotifications();
    expect(unreadCount).toBe(2);
    const marked = notifications.find(n => n.id === id1);
    expect(marked!.read).toBe(1);
  });

  it('getNotifications({ limit: 2 }) limits results', () => {
    db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));
    db.insertNotification(makeNotification({ ts: 3000 }));

    const { notifications } = db.getNotifications({ limit: 2 });
    expect(notifications).toHaveLength(2);
  });

  it('getNotifications({ since: ts }) filters by timestamp', () => {
    db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));
    db.insertNotification(makeNotification({ ts: 3000 }));

    const { notifications } = db.getNotifications({ since: 1500 });
    expect(notifications).toHaveLength(2);
    expect(notifications.every(n => n.ts > 1500)).toBe(true);
  });

  it('stores and retrieves peer field for clickable notification routing', () => {
    const peerId = '12D3KooWExamplePeerId123';
    db.insertNotification(makeNotification({
      type: 'chat_message',
      title: 'New message',
      peer: peerId,
    }));
    const { notifications } = db.getNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].peer).toBe(peerId);
    expect(notifications[0].type).toBe('chat_message');
  });

  it('returns null peer for notifications without peer field', () => {
    db.insertNotification(makeNotification({ type: 'kc_published' }));
    const { notifications } = db.getNotifications();
    expect(notifications[0].peer).toBeNull();
  });

  it('pruning removes old notifications', () => {
    const db2 = new DashboardDB({ dataDir: dir, retentionDays: 0 });

    db2.insertNotification(makeNotification({ ts: Date.now() - 100_000 }));
    db2.insertNotification(makeNotification({ ts: Date.now() - 200_000 }));

    db2.prune();

    const { notifications, unreadCount } = db2.getNotifications();
    expect(notifications).toHaveLength(0);
    expect(unreadCount).toBe(0);

    db2.close();
  });
});

// --- API notification route tests ---

describe('handleNodeUIRequest — notification routes', () => {
  it('GET /api/notifications returns empty state', async () => {
    const res = await fetch(`${baseUrl}/api/notifications`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notifications).toEqual([]);
    expect(body.unreadCount).toBe(0);
  });

  it('GET /api/notifications returns notifications after inserting via db', async () => {
    db.insertNotification(makeNotification({ ts: 1000, title: 'A' }));
    db.insertNotification(makeNotification({ ts: 2000, title: 'B' }));

    const res = await fetch(`${baseUrl}/api/notifications`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notifications).toHaveLength(2);
    expect(body.unreadCount).toBe(2);
    expect(body.notifications[0].title).toBe('B');
  });

  it('GET /api/notifications?limit=1 limits results', async () => {
    db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));
    db.insertNotification(makeNotification({ ts: 3000 }));

    const res = await fetch(`${baseUrl}/api/notifications?limit=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notifications).toHaveLength(1);
  });

  it('GET /api/notifications?since=X filters by timestamp', async () => {
    db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));
    db.insertNotification(makeNotification({ ts: 3000 }));

    const res = await fetch(`${baseUrl}/api/notifications?since=1500`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notifications).toHaveLength(2);
    expect(body.notifications.every((n: any) => n.ts > 1500)).toBe(true);
  });

  it('POST /api/notifications/read with {} marks all as read', async () => {
    db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));

    const res = await fetch(`${baseUrl}/api/notifications/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.marked).toBe(2);

    const { unreadCount } = db.getNotifications();
    expect(unreadCount).toBe(0);
  });

  it('POST /api/notifications/read with { ids: [id] } marks specific notification', async () => {
    const id1 = db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));

    const res = await fetch(`${baseUrl}/api/notifications/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id1] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.marked).toBe(1);

    const { unreadCount } = db.getNotifications();
    expect(unreadCount).toBe(1);
  });
});
