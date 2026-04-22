/**
 * E2E tests for features merged in the latest batch of PRs:
 *
 *  - Solo play (MIN_PLAYERS = 1)
 *  - Leave swarm (recruiting + traveling)
 *  - Notifications across real multi-node gossipsub
 *  - Leaderboard after a game finishes
 *  - Dead player cannot vote
 *  - Force-resolve fallback
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestCluster, stopTestCluster, nodeApi, sleep, type TestNode } from './helpers.js';

describe('New feature E2E tests (3 nodes)', () => {
  let nodes: TestNode[];
  let apiA: ReturnType<typeof nodeApi>;
  let apiB: ReturnType<typeof nodeApi>;
  let apiC: ReturnType<typeof nodeApi>;

  beforeAll(async () => {
    nodes = await startTestCluster(3);
    apiA = nodeApi(nodes[0]);
    apiB = nodeApi(nodes[1]);
    apiC = nodeApi(nodes[2]);
  }, 600_000);

  afterAll(async () => {
    if (nodes) await stopTestCluster(nodes);
  }, 30_000);

  // ─── Solo Play ────────────────────────────────────────────

  describe('solo play (MIN_PLAYERS = 1)', () => {
    let soloSwarmId: string;

    it('a single player can create and start a game', async () => {
      const created = await apiA.create('Solo Alice', 'Solo Trek', 1);
      expect(created.id).toBeTruthy();
      expect(created.status).toBe('recruiting');
      expect(created.playerCount).toBe(1);
      soloSwarmId = created.id;

      const started = await apiA.start(soloSwarmId);
      expect(started.status).toBe('traveling');
      expect(started.currentTurn).toBe(1);
      expect(started.gameState.status).toBe('active');
      expect(started.gameState.party.length).toBe(1);
    });

    it('solo player can vote and the turn resolves', async () => {
      await apiA.vote(soloSwarmId, 'advance', { pace: 2 });
      await sleep(4000);

      const swarm = await apiA.swarm(soloSwarmId);
      expect(swarm.currentTurn).toBe(2);
      expect(swarm.lastTurn.winningAction).toBe('advance');
    });

    it('solo player can force-resolve a turn', async () => {
      await apiA.vote(soloSwarmId, 'upgradeSkills');
      await sleep(1000);
      await apiA.forceResolve(soloSwarmId);
      await sleep(4000);

      const swarm = await apiA.swarm(soloSwarmId);
      expect(swarm.currentTurn).toBe(3);
    });
  });

  // ─── Leave Swarm ──────────────────────────────────────────

  describe('leave swarm', () => {
    it('a player can leave during recruiting phase', async () => {
      const created = await apiA.create('Leader', 'Leave Test', 3);
      const swarmId = created.id;
      await sleep(2000);

      await apiB.join(swarmId, 'Joiner');
      await sleep(1000);

      const result = await apiB.leave(swarmId);
      expect(result).toBeDefined();

      await sleep(1000);

      const swarm = await apiA.swarm(swarmId);
      expect(swarm.playerCount).toBe(1);
    });

    it('leader leaving during recruiting disbands the swarm', async () => {
      const created = await apiA.create('TempLeader', 'Disband Test');
      const swarmId = created.id;
      await sleep(1000);

      const result = await apiA.leave(swarmId);
      expect(result.disbanded).toBe(true);

      await sleep(1000);

      const swarm = await apiA.swarm(swarmId);
      expect(swarm?.error ?? swarm).toBeTruthy();
    });
  });

  // ─── Notifications (multi-node) ───────────────────────────

  describe('notifications across nodes', () => {
    it('swarm creation on node A generates notification on node B', async () => {
      const created = await apiA.create('Notifier', 'Notif Swarm');
      expect(created.id).toBeTruthy();

      await sleep(3000);

      const notifB = await apiB.notifications();
      const swarmNotif = notifB.notifications?.find(
        (n: any) => n.type === 'swarm_created' && n.swarmName === 'Notif Swarm'
      );
      expect(swarmNotif).toBeDefined();
      expect(notifB.unreadCount).toBeGreaterThanOrEqual(1);
    });

    it('joining a swarm generates a player_joined notification on the leader', async () => {
      const lobby = await apiA.lobby();
      const swarm = lobby.mySwarms?.find((s: any) => s.name === 'Notif Swarm');
      // A vacuous `if (!swarm) return;` would pass even if the previous test
      // silently dropped the swarm — that masks a real regression in the
      // create/lobby path. Assert the swarm exists; the test is meaningful
      // only with a live swarm to join.
      expect(
        swarm,
        'precondition: "Notif Swarm" created in prior test must be visible in apiA.lobby()',
      ).toBeTruthy();

      const beforeNotifs = await apiA.notifications();
      const beforeCount = beforeNotifs.unreadCount;

      await apiB.join(swarm.id, 'NotifJoiner');
      await sleep(2000);

      const afterNotifs = await apiA.notifications();
      const joinNotif = afterNotifs.notifications?.find(
        (n: any) => n.type === 'player_joined' && n.playerName === 'NotifJoiner'
      );
      expect(joinNotif).toBeDefined();
      expect(afterNotifs.unreadCount).toBeGreaterThan(beforeCount);
    });

    it('mark-read clears unread count', async () => {
      const before = await apiA.notifications();
      // Vacuous early return (`if (before.unreadCount === 0) return;`) would
      // pass the test without exercising mark-read at all, which hides the
      // regression where mark-read silently no-ops. Force a notification
      // first if the queue is empty.
      if (before.unreadCount === 0) {
        await apiC.create('MarkReadSetup', 'Mark Read Setup Swarm');
        await sleep(2000);
      }
      const withNotifs = await apiA.notifications();
      expect(
        withNotifs.unreadCount,
        'mark-read test requires at least one unread notification to be meaningful',
      ).toBeGreaterThan(0);

      await apiA.markNotificationsRead();
      const after = await apiA.notifications();
      expect(after.unreadCount).toBe(0);
    });

    it('partial mark-read only clears specified notifications', async () => {
      // Generate a new notification
      const created = await apiC.create('Partial', 'Partial Swarm');
      await sleep(2000);

      const notifs = await apiB.notifications();
      const unreadIds = notifs.notifications
        ?.filter((n: any) => !n.read)
        .map((n: any) => n.id);
      // A vacuous `if (!unreadIds || unreadIds.length < 2) return;` would
      // silently pass if gossip/notifications never delivered anything, which
      // would hide the very bug we're probing (partial-selective mark-read).
      // Assert the preconditions loudly.
      expect(unreadIds, 'notifications() must return at least one unread id').toBeDefined();
      expect(
        unreadIds!.length,
        'partial-mark-read test needs >=2 unread notifications; node B was expected to receive them via gossip',
      ).toBeGreaterThanOrEqual(2);

      await apiB.markNotificationsRead([unreadIds![0]]);
      const after = await apiB.notifications();
      expect(after.unreadCount).toBe(notifs.unreadCount - 1);
    });
  });

  // ─── Leaderboard ──────────────────────────────────────────

  describe('leaderboard', () => {
    it('leaderboard endpoint returns a valid response', async () => {
      const lb = await apiA.leaderboard();
      expect(lb).toBeDefined();
      expect(lb.entries).toBeDefined();
      expect(Array.isArray(lb.entries)).toBe(true);
    });
  });

  // ─── Multi-player Game: Dead Player + Full Flow ───────────

  describe('3-player game with full turn lifecycle', () => {
    let swarmId: string;

    it('create, join, and start a 3-player game', async () => {
      const created = await apiA.create('Hero', 'Full Test', 3);
      swarmId = created.id;
      await sleep(2000);

      await apiB.join(swarmId, 'Sidekick');
      await sleep(1000);
      await apiC.join(swarmId, 'Scout');
      await sleep(2000);

      const started = await apiA.start(swarmId);
      expect(started.status).toBe('traveling');
      expect(started.gameState.party.length).toBe(3);

      await sleep(2000);
    });

    it('consensus resolves the first turn across all nodes', async () => {
      await apiA.vote(swarmId, 'advance', { pace: 2 });
      await sleep(500);
      await apiB.vote(swarmId, 'advance', { pace: 2 });
      await sleep(500);
      await apiC.vote(swarmId, 'advance', { pace: 2 });

      await sleep(5000);

      const [sA, sB, sC] = await Promise.all([
        apiA.swarm(swarmId),
        apiB.swarm(swarmId),
        apiC.swarm(swarmId),
      ]);

      expect(sA.currentTurn).toBe(2);
      expect(sA.currentTurn).toBe(sB.currentTurn);
      expect(sB.currentTurn).toBe(sC.currentTurn);
      expect(sA.lastTurn.winningAction).toBe('advance');
    });

    it('state is consistent across all 3 nodes after turn 1', async () => {
      const [sA, sB, sC] = await Promise.all([
        apiA.swarm(swarmId),
        apiB.swarm(swarmId),
        apiC.swarm(swarmId),
      ]);

      expect(sA.gameState.epochs).toBe(sB.gameState.epochs);
      expect(sB.gameState.epochs).toBe(sC.gameState.epochs);
      expect(sA.gameState.trainingTokens).toBe(sB.gameState.trainingTokens);
    });

    it('game info endpoint returns correct metadata', async () => {
      const info = await apiA.info();
      expect(info.id).toBe('origin-trail-game');
      expect(info.minPlayers).toBe(1);
      expect(info.dkgEnabled).toBe(true);
      expect(info.peerId).toBeTruthy();
    });

    it('players endpoint returns registered players', async () => {
      const result = await apiA.players();
      expect(result.players).toBeDefined();
      expect(Array.isArray(result.players)).toBe(true);
    });

    it('locations endpoint returns available locations', async () => {
      const base = `http://127.0.0.1:${nodes[0].apiPort}`;
      const res = await fetch(`${base}/api/apps/origin-trail-game/locations`);
      const data = await res.json();
      expect(data.locations).toBeDefined();
      expect(Array.isArray(data.locations)).toBe(true);
      expect(data.locations.length).toBeGreaterThan(0);
    });
  });
});
