/**
 * OriginTrail Game E2E Test: 3 Players on 3 Nodes
 *
 * Spins up 3 DKG daemon instances (1 relay + 2 edge), each with
 * the OriginTrail Game app loaded. Tests the full game flow:
 *
 * 1. Node A creates a swarm
 * 2. Nodes B and C join
 * 3. Node A starts the journey
 * 4. All 3 nodes vote, turn resolves with 2/3 consensus
 * 5. Game state is consistent across all nodes
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestCluster, stopTestCluster, nodeApi, sleep, readNodeLog, type TestNode } from './helpers.js';

describe('OriginTrail Game: 3 player game', () => {
  let nodes: TestNode[];
  let apiA: ReturnType<typeof nodeApi>;
  let apiB: ReturnType<typeof nodeApi>;
  let apiC: ReturnType<typeof nodeApi>;
  let swarmId: string;

  beforeAll(async () => {
    nodes = await startTestCluster(3);
    apiA = nodeApi(nodes[0]);
    apiB = nodeApi(nodes[1]);
    apiC = nodeApi(nodes[2]);
  }, 600_000);

  afterAll(async () => {
    if (nodes) await stopTestCluster(nodes);
  }, 30_000);

  it('all nodes have OriginTrail Game loaded', async () => {
    const [infoA, infoB, infoC] = await Promise.all([
      apiA.info(),
      apiB.info(),
      apiC.info(),
    ]);

    expect(infoA.id).toBe('origin-trail-game');
    expect(infoA.dkgEnabled).toBe(true);
    expect(infoA.peerId).toBeTruthy();

    expect(infoB.dkgEnabled).toBe(true);
    expect(infoC.dkgEnabled).toBe(true);

    expect(infoA.peerId).not.toBe(infoB.peerId);
    expect(infoB.peerId).not.toBe(infoC.peerId);
  });

  it('Node A creates a swarm', async () => {
    const result = await apiA.create('Alice', 'Pioneer Express');

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('Pioneer Express');
    expect(result.status).toBe('recruiting');
    expect(result.playerCount).toBe(1);
    expect(result.players[0].name).toBe('Alice');
    expect(result.players[0].isLeader).toBe(true);

    swarmId = result.id;
  });

  it('swarm appears on other nodes via gossipsub', async () => {
    await sleep(3000);

    const lobbyB = await apiB.lobby();
    const lobbyC = await apiC.lobby();

    expect(lobbyB.openSwarms.length).toBeGreaterThanOrEqual(1);
    const swarmInB = lobbyB.openSwarms.find((w: any) => w.id === swarmId);
    expect(swarmInB).toBeTruthy();
    expect(swarmInB.name).toBe('Pioneer Express');

    const swarmInC = lobbyC.openSwarms.find((w: any) => w.id === swarmId);
    expect(swarmInC).toBeTruthy();
  });

  it('Nodes B and C join the swarm', async () => {
    const resultB = await apiB.join(swarmId, 'Bob');
    expect(resultB.playerCount).toBe(2);

    await sleep(1000);

    const resultC = await apiC.join(swarmId, 'Charlie');
    expect(resultC.playerCount).toBe(3);

    await sleep(2000);

    const wagonA = await apiA.swarm(swarmId);
    expect(wagonA.playerCount).toBe(3);
    const names = wagonA.players.map((p: any) => p.name).sort();
    expect(names).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('Node A (GM) starts the journey', async () => {
    const result = await apiA.start(swarmId);

    expect(result.status).toBe('traveling');
    expect(result.currentTurn).toBe(1);
    expect(result.gameState).toBeTruthy();
    expect(result.gameState.status).toBe('active');
    expect(result.gameState.party.length).toBe(3);

    await sleep(2000);

    const wagonB = await apiB.swarm(swarmId);
    expect(wagonB.status).toBe('traveling');
    expect(wagonB.gameState.status).toBe('active');

    const wagonC = await apiC.swarm(swarmId);
    expect(wagonC.status).toBe('traveling');
  });

  it('all 3 nodes vote and turn resolves with 2/3 consensus', async () => {
    await apiA.vote(swarmId, 'advance', { pace: 2 });
    await sleep(500);
    await apiB.vote(swarmId, 'advance', { pace: 2 });
    await sleep(500);
    await apiC.vote(swarmId, 'syncMemory');

    await sleep(5000);

    const wagonA = await apiA.swarm(swarmId);
    expect(wagonA.currentTurn).toBe(2);
    expect(wagonA.lastTurn).toBeTruthy();
    expect(wagonA.lastTurn.winningAction).toBe('advance');
    expect(wagonA.lastTurn.approvers.length).toBeGreaterThanOrEqual(2);

    expect(wagonA.gameState.epochs).toBeGreaterThan(0);
  });

  it('game state is consistent across all 3 nodes', async () => {
    const [wA, wB, wC] = await Promise.all([
      apiA.swarm(swarmId),
      apiB.swarm(swarmId),
      apiC.swarm(swarmId),
    ]);

    expect(wA.currentTurn).toBe(wB.currentTurn);
    expect(wB.currentTurn).toBe(wC.currentTurn);

    expect(wA.gameState.epochs).toBe(wB.gameState.epochs);
    expect(wB.gameState.epochs).toBe(wC.gameState.epochs);

    expect(wA.gameState.trainingTokens).toBe(wB.gameState.trainingTokens);
    expect(wB.gameState.trainingTokens).toBe(wC.gameState.trainingTokens);
  });

  it('can play a second turn', async () => {
    await apiA.vote(swarmId, 'upgradeSkills');
    await sleep(500);
    await apiB.vote(swarmId, 'upgradeSkills');
    await sleep(500);
    await apiC.vote(swarmId, 'upgradeSkills');

    await sleep(5000);

    const wagonA = await apiA.swarm(swarmId);
    expect(wagonA.currentTurn).toBe(3);
    expect(wagonA.lastTurn.winningAction).toBe('upgradeSkills');
    expect(wagonA.lastTurn.approvers.length).toBeGreaterThanOrEqual(2);
  });

  it('GM can force-resolve a turn', async () => {
    await apiA.vote(swarmId, 'syncMemory');
    await sleep(500);
    await apiB.vote(swarmId, 'syncMemory');
    await sleep(1000);

    await apiA.forceResolve(swarmId);
    await sleep(5000);

    const wagonA = await apiA.swarm(swarmId);
    expect(wagonA.currentTurn).toBe(4);
    expect(wagonA.lastTurn.winningAction).toBe('syncMemory');
  });

  it('plays many turns total and logs contain no critical errors', async () => {
    // CI wall-clock budget: we must stay under 5 min total (see ci.yml).
    // 20 turns × (400 + 400 + 400 + 6000)ms = ~2m 24s for this test alone, which
    // when added to the ~60s cluster boot + ~65s of other tests in this file
    // pushes the shard past 4m 30s — right at the edge once GH runner overhead
    // (artifact download, node setup, vitest spin-up) is added. CI sets
    // CI_FAST_MODE=1 to cap this at 5 turns, which still exercises the full
    // consensus/sync/error-scan path (5 independent M-of-N turns, cross-node
    // agreement, and the full error-log scan). Local runs default to 20 turns
    // to keep the long-haul stability assertion.
    const TARGET_TURN = process.env.CI_FAST_MODE === '1' ? 5 : 20;
    const TURN_RESOLVE_MS = 6000;
    let lastTurn = (await apiA.swarm(swarmId)).currentTurn;

    while (lastTurn < TARGET_TURN) {
      await apiA.vote(swarmId, 'advance', { pace: 2 });
      await sleep(400);
      await apiB.vote(swarmId, 'advance', { pace: 2 });
      await sleep(400);
      await apiC.vote(swarmId, 'advance', { pace: 2 });
      await sleep(TURN_RESOLVE_MS);

      const wagon = await apiA.swarm(swarmId);
      lastTurn = wagon.currentTurn;
      expect(wagon.lastTurn).toBeTruthy();
      expect(wagon.lastTurn.approvers.length).toBeGreaterThanOrEqual(2);
    }

    expect(lastTurn).toBe(TARGET_TURN);

    const [wA, wB, wC] = await Promise.all([
      apiA.swarm(swarmId),
      apiB.swarm(swarmId),
      apiC.swarm(swarmId),
    ]);
    expect(wA.currentTurn).toBe(wB.currentTurn);
    expect(wB.currentTurn).toBe(wC.currentTurn);

    // Critical: no fatal errors in any node log (transient relay/sync WARNs are allowed)
    const errorPatterns = [
      /ELIFECYCLE\s+Command failed/i,
      /Uncaught\s+Exception/i,
      /Unhandled\s+Rejection/i,
      /FATAL/i,
      /ECONNREFUSED.*1920[0-9]/, // our e2e API ports
    ];

    const allowedInErrorLines = [
      'Gossip on-chain verification failed',
      'stored as tentative',
      '[ProtocolRouter] handler error', // stream timeout/close; recoverable
      'Sync page retry',
      'Workspace sync page retry',
    ];

    for (let i = 0; i < nodes.length; i++) {
      const log = readNodeLog(nodes[i]);
      for (const re of errorPatterns) {
        const match = log.match(re);
        expect(match, `Node ${i + 1} log should not contain ${re.source}`).toBeNull();
      }
      const errorLines = log.split('\n').filter(l => /\[ERROR\]|\[error\]/.test(l) && !/\[WARN\]/.test(l));
      const fatalErrors = errorLines.filter(l => !allowedInErrorLines.some(a => l.includes(a)));
      expect(fatalErrors, `Node ${i + 1} should have no fatal error lines`).toEqual([]);
    }
  }, 300_000);
});
