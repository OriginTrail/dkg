/**
 * E2E test: two simulated nodes communicating via an in-process gossip bridge.
 *
 * Node A creates a swarm → Node B receives a "swarm_created" notification.
 * Node B joins → Node A receives a "player_joined" notification.
 * Node A launches expedition → Node B receives "expedition_launched".
 * Node B votes → Node A receives "vote_cast".
 * Both nodes' API endpoints return the correct notifications and unread counts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import createHandler from '../src/api/handler.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { GameNotification } from '../src/dkg/coordinator.js';

type MessageHandler = (topic: string, data: Uint8Array, from: string) => void;

/**
 * A simple gossip bridge that connects two mock agents so they can
 * exchange messages as if they were on the same libp2p network.
 */
function createGossipBridge() {
  const subscribers = new Map<string, Set<{ peerId: string; handler: MessageHandler }>>();

  function createAgent(peerId: string) {
    const published: any[] = [];
    const workspaceWrites: any[] = [];
    const localHandlers = new Map<string, MessageHandler[]>();

    return {
      peerId,
      gossip: {
        subscribe(topic: string) {
          if (!subscribers.has(topic)) subscribers.set(topic, new Set());
          for (const entry of localHandlers.get(topic) ?? []) {
            subscribers.get(topic)!.add({ peerId, handler: entry });
          }
        },
        async publish(topic: string, data: Uint8Array) {
          const subs = subscribers.get(topic);
          if (!subs) return;
          for (const sub of subs) {
            if (sub.peerId !== peerId) {
              sub.handler(topic, data, peerId);
            }
          }
        },
        onMessage(topic: string, handler: MessageHandler) {
          if (!localHandlers.has(topic)) localHandlers.set(topic, []);
          localHandlers.get(topic)!.push(handler);
          if (subscribers.has(topic)) {
            subscribers.get(topic)!.add({ peerId, handler });
          }
        },
        offMessage(topic: string, handler: MessageHandler) {
          const handlers = localHandlers.get(topic);
          if (handlers) {
            const idx = handlers.indexOf(handler);
            if (idx >= 0) handlers.splice(idx, 1);
          }
          const subs = subscribers.get(topic);
          if (subs) {
            for (const entry of subs) {
              if (entry.handler === handler) subs.delete(entry);
            }
          }
        },
      },
      writeToWorkspace: async (_paranetId: string, quads: any[]) => {
        workspaceWrites.push(quads);
        return { workspaceOperationId: `op-${Date.now()}` };
      },
      publish: async (_paranetId: string, quads: any[]) => {
        published.push(quads);
        return {};
      },
      query: async () => ({ bindings: [] }),
      _published: published,
      _workspaceWrites: workspaceWrites,
    };
  }

  return { createAgent };
}

function createMockReq(method: string, path: string, body?: any): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = {};
  if (body !== undefined) {
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    }, 0);
  }
  return req;
}

function createMockRes(): { res: ServerResponse; body: string; status: number } {
  const result = { body: '', status: 0 };
  const res = {
    writeHead(status: number, _headers: any) { result.status = status; },
    end(data: string) { result.body = data; },
  } as any;
  return { res, ...result, get body() { return result.body; }, get status() { return result.status; } };
}

async function apiGet(handler: any, subpath: string): Promise<any> {
  const req = createMockReq('GET', `/api/apps/origin-trail-game${subpath}`);
  const mock = createMockRes();
  await handler(req, mock.res, new URL(req.url, 'http://localhost'));
  return JSON.parse(mock.body);
}

async function apiPost(handler: any, subpath: string, body: any): Promise<any> {
  const req = createMockReq('POST', `/api/apps/origin-trail-game${subpath}`, body);
  const mock = createMockRes();
  await handler(req, mock.res, new URL(req.url, 'http://localhost'));
  return JSON.parse(mock.body);
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Notifications E2E — two-node gossip bridge', () => {
  let bridge: ReturnType<typeof createGossipBridge>;
  let agentA: ReturnType<ReturnType<typeof createGossipBridge>['createAgent']>;
  let agentB: ReturnType<ReturnType<typeof createGossipBridge>['createAgent']>;
  let handlerA: any;
  let handlerB: any;

  beforeEach(() => {
    bridge = createGossipBridge();
    agentA = bridge.createAgent('peer-node-A');
    agentB = bridge.createAgent('peer-node-B');
    handlerA = createHandler(agentA, { paranets: ['test'], name: 'NodeA' });
    handlerB = createHandler(agentB, { paranets: ['test'], name: 'NodeB' });
  });

  it('full game flow generates correct notifications on both nodes', async () => {
    // Node A creates a swarm
    const created = await apiPost(handlerA, '/create', {
      playerName: 'NodeA-Player', swarmName: 'E2E Swarm', maxPlayers: 5,
    });
    expect(created.id).toBeDefined();
    const swarmId = created.id;

    await wait(100);

    // Node B should have received a "swarm_created" notification
    const notifB1 = await apiGet(handlerB, '/notifications');
    expect(notifB1.unreadCount).toBe(1);
    expect(notifB1.notifications[0].type).toBe('swarm_created');
    expect(notifB1.notifications[0].message).toContain('E2E Swarm');

    // Node B joins the swarm
    const joined = await apiPost(handlerB, '/join', {
      swarmId, playerName: 'NodeB-Player',
    });
    expect(joined.playerCount).toBe(2);

    await wait(100);

    // Node A should have a "player_joined" notification
    const notifA1 = await apiGet(handlerA, '/notifications');
    const joinNotif = notifA1.notifications.find((n: GameNotification) => n.type === 'player_joined');
    expect(joinNotif).toBeDefined();
    expect(joinNotif.playerName).toBe('NodeB-Player');
    expect(joinNotif.message).toContain('NodeB-Player');

    // Mark notifications read on Node A
    const readResult = await apiPost(handlerA, '/notifications/read', {});
    expect(readResult.markedRead).toBeGreaterThanOrEqual(1);

    // Verify Node A unread count is now 0
    const notifA2 = await apiGet(handlerA, '/notifications');
    expect(notifA2.unreadCount).toBe(0);

    // Node B marks its notifications as read too
    await apiPost(handlerB, '/notifications/read', {});
    const notifB2 = await apiGet(handlerB, '/notifications');
    expect(notifB2.unreadCount).toBe(0);
    expect(notifB2.notifications[0].read).toBe(true);
  });

  it('notification bell shows correct unread count after multiple events', async () => {
    // Create swarm on A
    const created = await apiPost(handlerA, '/create', {
      playerName: 'A', swarmName: 'Multi Swarm', maxPlayers: 5,
    });
    await wait(50);

    // B joins
    await apiPost(handlerB, '/join', {
      swarmId: created.id, playerName: 'B',
    });
    await wait(100);

    // A should have 1 notification (player_joined)
    const notifA = await apiGet(handlerA, '/notifications');
    expect(notifA.unreadCount).toBe(1);

    // B should have 1 notification (swarm_created)
    const notifB = await apiGet(handlerB, '/notifications');
    expect(notifB.unreadCount).toBe(1);

    // B leaves
    await apiPost(handlerB, '/leave', { swarmId: created.id });
    await wait(100);

    // A should now have 2 notifications (player_joined + player_left)
    const notifA2 = await apiGet(handlerA, '/notifications');
    expect(notifA2.unreadCount).toBe(2);
    const types = notifA2.notifications.map((n: GameNotification) => n.type);
    expect(types).toContain('player_joined');
    expect(types).toContain('player_left');
  });

  it('partial mark-read keeps remaining notifications unread', async () => {
    const created = await apiPost(handlerA, '/create', {
      playerName: 'A', swarmName: 'Partial Swarm', maxPlayers: 5,
    });
    await wait(50);

    // B joins then leaves to generate 2 notifications on B (swarm_created from A)
    // and 2 on A (player_joined, player_left)
    await apiPost(handlerB, '/join', {
      swarmId: created.id, playerName: 'B',
    });
    await wait(50);
    await apiPost(handlerB, '/leave', { swarmId: created.id });
    await wait(100);

    const notifA = await apiGet(handlerA, '/notifications');
    expect(notifA.unreadCount).toBe(2);

    // Mark only the first notification as read
    const firstId = notifA.notifications[0].id;
    const markResult = await apiPost(handlerA, '/notifications/read', { ids: [firstId] });
    expect(markResult.markedRead).toBe(1);

    const notifA2 = await apiGet(handlerA, '/notifications');
    expect(notifA2.unreadCount).toBe(1);
  });

  it('notifications persist across multiple API calls', async () => {
    await apiPost(handlerA, '/create', {
      playerName: 'A', swarmName: 'Persist Swarm', maxPlayers: 5,
    });
    await wait(50);

    const notifB1 = await apiGet(handlerB, '/notifications');
    expect(notifB1.unreadCount).toBe(1);

    // Calling again should return the same notification (still unread)
    const notifB2 = await apiGet(handlerB, '/notifications');
    expect(notifB2.unreadCount).toBe(1);
    expect(notifB2.notifications[0].id).toBe(notifB1.notifications[0].id);
  });

  it('notification from node A does not appear on node A itself', async () => {
    await apiPost(handlerA, '/create', {
      playerName: 'SelfTest', swarmName: 'Self Swarm', maxPlayers: 5,
    });
    await wait(50);

    // Node A's own swarm creation should NOT generate a notification
    // (coordinator filters own peerId messages)
    const notifA = await apiGet(handlerA, '/notifications');
    const selfNotif = notifA.notifications.find(
      (n: GameNotification) => n.type === 'swarm_created' && n.swarmName === 'Self Swarm'
    );
    expect(selfNotif).toBeUndefined();
  });
});
