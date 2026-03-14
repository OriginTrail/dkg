import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
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

// --- API test helpers ---

function createMockReq(opts: {
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): { req: IncomingMessage; url: URL } {
  const stream = Readable.from(opts.body != null ? [Buffer.from(opts.body, 'utf8')] : []);
  const req = stream as unknown as IncomingMessage & {
    method: string;
    headers: Record<string, string>;
  };
  req.method = opts.method;
  req.headers = opts.headers ?? {};
  return {
    req: req as IncomingMessage,
    url: new URL(`http://localhost${opts.path}`),
  };
}

function createMockRes(): {
  res: ServerResponse;
  state: { statusCode: number; headers: Record<string, string>; body: string };
} {
  const chunks: Buffer[] = [];
  const state = { statusCode: 0, headers: {} as Record<string, string>, body: '' };
  const res: any = {
    writableEnded: false,
    destroyed: false,
    writeHead(code: number, headers?: Record<string, string>) {
      state.statusCode = code;
      state.headers = headers ?? {};
      return res;
    },
    write(chunk: Buffer | string) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
      }
      state.body = Buffer.concat(chunks).toString('utf8');
      res.writableEnded = true;
      return res;
    },
  };
  return { res: res as ServerResponse, state };
}

function parseJsonBody(body: string): any {
  return body ? JSON.parse(body) : {};
}

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
    const { req, url } = createMockReq({ method: 'GET', path: '/api/notifications' });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(req, res, url, db, '/fake/static');
    expect(handled).toBe(true);
    expect(state.statusCode).toBe(200);

    const body = parseJsonBody(state.body);
    expect(body.notifications).toEqual([]);
    expect(body.unreadCount).toBe(0);
  });

  it('GET /api/notifications returns notifications after inserting via db', async () => {
    db.insertNotification(makeNotification({ ts: 1000, title: 'A' }));
    db.insertNotification(makeNotification({ ts: 2000, title: 'B' }));

    const { req, url } = createMockReq({ method: 'GET', path: '/api/notifications' });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(req, res, url, db, '/fake/static');
    expect(handled).toBe(true);
    expect(state.statusCode).toBe(200);

    const body = parseJsonBody(state.body);
    expect(body.notifications).toHaveLength(2);
    expect(body.unreadCount).toBe(2);
    expect(body.notifications[0].title).toBe('B');
  });

  it('GET /api/notifications?limit=1 limits results', async () => {
    db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));
    db.insertNotification(makeNotification({ ts: 3000 }));

    const { req, url } = createMockReq({ method: 'GET', path: '/api/notifications?limit=1' });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(req, res, url, db, '/fake/static');
    expect(handled).toBe(true);

    const body = parseJsonBody(state.body);
    expect(body.notifications).toHaveLength(1);
  });

  it('GET /api/notifications?since=X filters by timestamp', async () => {
    db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));
    db.insertNotification(makeNotification({ ts: 3000 }));

    const { req, url } = createMockReq({ method: 'GET', path: '/api/notifications?since=1500' });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(req, res, url, db, '/fake/static');
    expect(handled).toBe(true);

    const body = parseJsonBody(state.body);
    expect(body.notifications).toHaveLength(2);
    expect(body.notifications.every((n: any) => n.ts > 1500)).toBe(true);
  });

  it('POST /api/notifications/read with {} marks all as read', async () => {
    db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));

    const { req, url } = createMockReq({
      method: 'POST',
      path: '/api/notifications/read',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(req, res, url, db, '/fake/static');
    expect(handled).toBe(true);
    expect(state.statusCode).toBe(200);

    const body = parseJsonBody(state.body);
    expect(body.marked).toBe(2);

    const { unreadCount } = db.getNotifications();
    expect(unreadCount).toBe(0);
  });

  it('POST /api/notifications/read with { ids: [id] } marks specific notification', async () => {
    const id1 = db.insertNotification(makeNotification({ ts: 1000 }));
    db.insertNotification(makeNotification({ ts: 2000 }));

    const { req, url } = createMockReq({
      method: 'POST',
      path: '/api/notifications/read',
      body: JSON.stringify({ ids: [id1] }),
      headers: { 'content-type': 'application/json' },
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(req, res, url, db, '/fake/static');
    expect(handled).toBe(true);
    expect(state.statusCode).toBe(200);

    const body = parseJsonBody(state.body);
    expect(body.marked).toBe(1);

    const { unreadCount } = db.getNotifications();
    expect(unreadCount).toBe(1);
  });
});
