import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';

// NOTE (notifications-pane redesign, ADR-003): the `/api/notifications` +
// `/api/notifications/read` HTTP routes moved OUT of `handleNodeUIRequest`
// (node-ui has no `agent` to scope against) into the agent-aware daemon route
// `packages/cli/src/daemon/routes/notifications.ts`. The route-level
// behaviour (scoping, digest collapse, reconcile, digestKey read) is covered
// by `packages/cli/test/notifications-route.test.ts`. This file now covers
// only the DashboardDB STORE layer the daemon route builds on.

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
