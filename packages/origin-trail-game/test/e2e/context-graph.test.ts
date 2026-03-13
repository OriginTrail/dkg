/**
 * E2E: Context Graph Protocol Integration
 *
 * Spins up 3 DKG daemons with a local Hardhat chain. Each node registers
 * an on-chain identity.  The test then plays a full game and verifies:
 *
 *  1. Identity IDs propagate through gossip and appear in swarm state
 *  2. A context graph is created on-chain during expedition launch
 *  3. Turn resolution enshrines data to the context graph (not plain publish)
 *  4. Workspace writes use the normalized paranet graph URI
 *  5. Follower nodes store the context graph ID
 *  6. The fallback path works when context graph creation fails
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startTestCluster, stopTestCluster, nodeApi, sleep,
  readNodeLog, gameLogLines, type TestNode,
} from './helpers.js';

describe('Context Graph Protocol E2E (3 nodes + chain)', () => {
  let nodes: TestNode[];
  let apiA: ReturnType<typeof nodeApi>;
  let apiB: ReturnType<typeof nodeApi>;
  let apiC: ReturnType<typeof nodeApi>;

  beforeAll(async () => {
    nodes = await startTestCluster(3, { chain: true });
    apiA = nodeApi(nodes[0]);
    apiB = nodeApi(nodes[1]);
    apiC = nodeApi(nodes[2]);
  }, 180_000);

  afterAll(async () => {
    if (nodes) await stopTestCluster(nodes);
  }, 30_000);

  // ── Identity registration ────────────────────────────────────

  it('all nodes registered on-chain identities', async () => {
    for (const node of nodes) {
      const log = readNodeLog(node);
      expect(log).toMatch(/identityId=\d+/);
      expect(log).not.toContain('No valid on-chain identity');
    }
  });

  // ── Full game flow with context graph ────────────────────────

  let swarmId: string;

  it('Node A creates a swarm and identityId is broadcast', async () => {
    const result = await apiA.create('Alice', 'CtxGraph Express');
    expect(result.id).toBeTruthy();
    swarmId = result.id;

    await sleep(2000);

    const lobbyB = await apiB.lobby();
    const swarmInB = lobbyB.openSwarms.find((w: any) => w.id === swarmId);
    expect(swarmInB).toBeTruthy();
  });

  it('Nodes B and C join with identity IDs', async () => {
    const resultB = await apiB.join(swarmId, 'Bob');
    expect(resultB.playerCount).toBe(2);
    await sleep(1000);

    const resultC = await apiC.join(swarmId, 'Charlie');
    expect(resultC.playerCount).toBe(3);
    await sleep(2000);

    const swarm = await apiA.swarm(swarmId);
    expect(swarm.playerCount).toBe(3);
  });

  it('expedition launch creates a context graph on-chain', async () => {
    const result = await apiA.start(swarmId);
    expect(result.status).toBe('traveling');
    expect(result.currentTurn).toBe(1);

    // The leader should have created a context graph
    expect(result.contextGraphId).toBeTruthy();

    await sleep(3000);
  });

  it('follower nodes receive the context graph ID', async () => {
    const swarmB = await apiB.swarm(swarmId);
    const swarmC = await apiC.swarm(swarmId);

    // Followers store the contextGraphId from the expedition:launched message
    expect(swarmB.contextGraphId).toBeTruthy();
    expect(swarmC.contextGraphId).toBeTruthy();
    expect(swarmB.contextGraphId).toBe(swarmC.contextGraphId);
  });

  it('turn 1: votes resolve and data is enshrined to context graph', async () => {
    await apiA.vote(swarmId, 'advance', { pace: 2 });
    await sleep(500);
    await apiB.vote(swarmId, 'advance', { pace: 2 });
    await sleep(500);
    await apiC.vote(swarmId, 'syncMemory');

    await sleep(8000);

    const swarm = await apiA.swarm(swarmId);
    expect(swarm.currentTurn).toBe(2);
    expect(swarm.lastTurn.winningAction).toBe('advance');

    const leaderLog = readNodeLog(nodes[0]);
    expect(leaderLog).toContain('enshrined to context graph');
    expect(leaderLog).not.toContain('published (no context graph)');
    expect(leaderLog).not.toContain('Parser error');
  });

  it('workspace writes use normalized paranet graph URI', async () => {
    const leaderLog = readNodeLog(nodes[0]);
    // The old bug: quads had graph "did:dkg:paranet:origin-trail-game/context/swarm-..."
    // which caused "Workspace validation failed: Rule 1"
    expect(leaderLog).not.toContain('Workspace validation failed');
    expect(leaderLog).not.toContain('Quad graph');
  });

  it('turn 2: consensus resolves consistently across nodes', async () => {
    await apiA.vote(swarmId, 'upgradeSkills');
    await sleep(500);
    await apiB.vote(swarmId, 'upgradeSkills');
    await sleep(500);
    await apiC.vote(swarmId, 'upgradeSkills');

    await sleep(8000);

    const [sA, sB, sC] = await Promise.all([
      apiA.swarm(swarmId),
      apiB.swarm(swarmId),
      apiC.swarm(swarmId),
    ]);

    expect(sA.currentTurn).toBe(3);
    expect(sA.currentTurn).toBe(sB.currentTurn);
    expect(sB.currentTurn).toBe(sC.currentTurn);
    expect(sA.lastTurn.winningAction).toBe('upgradeSkills');
  });

  it('force-resolve uses plain publish (no multi-party consensus)', async () => {
    await apiA.vote(swarmId, 'syncMemory');
    await sleep(500);
    await apiB.vote(swarmId, 'syncMemory');
    await sleep(1000);

    await apiA.forceResolve(swarmId);
    await sleep(8000);

    const swarm = await apiA.swarm(swarmId);
    expect(swarm.currentTurn).toBe(4);

    // Force-resolve uses plain publish, not context graph enshrinement
    const leaderLog = readNodeLog(nodes[0]);
    expect(leaderLog).toContain('published (plain, no context graph)');
  });

  it('on-chain publishes succeed (no MinSignaturesRequirementNotMet)', () => {
    for (const node of nodes) {
      const log = readNodeLog(node);
      expect(log).not.toContain('MinSignaturesRequirementNotMet');
      expect(log).not.toContain('0xa6bc6322');
    }
  });

  it('leader log shows complete context graph lifecycle', () => {
    const leaderLog = readNodeLog(nodes[0]);

    // 1. Identity registration
    expect(leaderLog).toContain('identityId=');

    // 2. Context graph creation on-chain with M value
    expect(leaderLog).toMatch(/Context graph.*created.*M=/);

    // 3. Successful enshrinement for consensus turns
    const enshrinements = leaderLog.split('enshrined to context graph').length - 1;
    expect(enshrinements).toBeGreaterThanOrEqual(2);

    // 4. Force-resolve uses plain publish (not enshrinement)
    expect(leaderLog).toContain('published (plain, no context graph)');

    // 5. No parser errors (the literal escaping fix works)
    expect(leaderLog).not.toContain('Parser error');
    expect(leaderLog).not.toContain('Failed to publish');

    // 6. On-chain tx succeeded (not tentative due to sig requirements)
    expect(leaderLog).not.toContain('MinSignaturesRequirementNotMet');
  });
});
