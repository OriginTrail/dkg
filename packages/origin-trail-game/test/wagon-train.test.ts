import { describe, it, expect } from 'vitest';
import {
  createSwarm,
  joinSwarm,
  leaveSwarm,
  startExpedition,
  castVote,
  forceResolveTurn,
  getVoteStatus,
  formatSwarmState,
} from '../src/engine/wagon-train.js';

let testSeq = 0;
function uid(prefix = 'p') {
  return `${prefix}-wt-${++testSeq}-${Date.now()}`;
}

function setupTravelingSwarm() {
  const leader = uid('leader');
  const p2 = uid('p2');
  const p3 = uid('p3');
  const swarm = createSwarm(leader, 'Leader', `Swarm-${testSeq}`);
  joinSwarm(swarm.id, p2, 'Player2');
  joinSwarm(swarm.id, p3, 'Player3');
  startExpedition(swarm.id, leader);
  return { swarm, leader, p2, p3 };
}

describe('wagon-train: turn deadline', () => {
  it('sets turnDeadline to ~30s after expedition start', () => {
    const { swarm } = setupTravelingSwarm();
    expect(swarm.turnDeadline).not.toBeNull();
    const delta = swarm.turnDeadline! - Date.now();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(30_000);
  });

  it('getVoteStatus returns positive timeRemaining before deadline', () => {
    const { swarm } = setupTravelingSwarm();
    const vs = getVoteStatus(swarm.id);
    expect(vs.timeRemaining).toBeGreaterThan(0);
    expect(vs.timeRemaining).toBeLessThanOrEqual(30_000);
    expect(vs.allVoted).toBe(false);
  });

  it('leader can force-resolve before deadline even without all votes', () => {
    const { swarm, leader } = setupTravelingSwarm();
    castVote(swarm.id, leader, 'advance');
    const result = forceResolveTurn(swarm.id, leader);
    expect(result.currentTurn).toBe(2);
    expect(result.turnHistory.length).toBe(1);
  });

  it('non-leader cannot force-resolve before deadline', () => {
    const { swarm, p2 } = setupTravelingSwarm();
    castVote(swarm.id, p2, 'advance');
    expect(() => forceResolveTurn(swarm.id, p2)).toThrow('Only orchestrator can force resolve before deadline');
  });

  it('non-leader can force-resolve after deadline passes', () => {
    const { swarm, p2 } = setupTravelingSwarm();
    castVote(swarm.id, p2, 'advance');
    swarm.turnDeadline = Date.now() - 1;
    const result = forceResolveTurn(swarm.id, p2);
    expect(result.currentTurn).toBe(2);
  });

  it('force-resolve with no votes defaults to leader advance vote', () => {
    const { swarm, leader } = setupTravelingSwarm();
    const result = forceResolveTurn(swarm.id, leader);
    expect(result.turnHistory.length).toBe(1);
    expect(result.turnHistory[0].winningAction).toBe('advance');
  });

  it('resets deadline to ~30s after turn resolves', () => {
    const { swarm, leader, p2, p3 } = setupTravelingSwarm();
    castVote(swarm.id, leader, 'advance');
    castVote(swarm.id, p2, 'advance');
    castVote(swarm.id, p3, 'advance');
    if (swarm.status === 'traveling') {
      const delta = swarm.turnDeadline! - Date.now();
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThanOrEqual(30_000);
    }
  });
});

describe('wagon-train: formatSwarmState', () => {
  it('includes leaderId and leaderName', () => {
    const leader = uid('fmt-leader');
    const swarm = createSwarm(leader, 'LeaderName', `FmtTest-${testSeq}`);
    joinSwarm(swarm.id, uid('fmt-p2'), 'Player2');
    joinSwarm(swarm.id, uid('fmt-p3'), 'Player3');

    const state = formatSwarmState(swarm);
    expect(state.leaderId).toBe(leader);
    expect(state.leaderName).toBe('LeaderName');
  });

  it('players array includes isLeader flag', () => {
    const leader = uid('flag-leader');
    const p2 = uid('flag-p2');
    const swarm = createSwarm(leader, 'Boss', `FlagTest-${testSeq}`);
    joinSwarm(swarm.id, p2, 'Worker');
    joinSwarm(swarm.id, uid('flag-p3'), 'Worker2');

    const state = formatSwarmState(swarm);
    const leaderP = state.players.find(p => p.id === leader);
    const nonLeader = state.players.find(p => p.id === p2);
    expect(leaderP?.isLeader).toBe(true);
    expect(nonLeader?.isLeader).toBe(false);
  });

  it('voteStatus is null when not traveling', () => {
    const leader = uid('vs-leader');
    const swarm = createSwarm(leader, 'Leader', `VSTest-${testSeq}`);
    joinSwarm(swarm.id, uid('vs-p2'), 'P2');
    joinSwarm(swarm.id, uid('vs-p3'), 'P3');

    const state = formatSwarmState(swarm);
    expect(state.voteStatus).toBeNull();
    expect(state.status).toBe('recruiting');
  });

  it('voteStatus includes timeRemaining when traveling', () => {
    const leader = uid('vs2-leader');
    const swarm = createSwarm(leader, 'Leader', `VS2Test-${testSeq}`);
    joinSwarm(swarm.id, uid('vs2-p2'), 'P2');
    joinSwarm(swarm.id, uid('vs2-p3'), 'P3');
    startExpedition(swarm.id, leader);

    const state = formatSwarmState(swarm);
    expect(state.voteStatus).not.toBeNull();
    expect(state.voteStatus!.timeRemaining).toBeGreaterThan(0);
    expect(state.voteStatus!.allVoted).toBe(false);
  });
});

describe('wagon-train: leave during travel', () => {
  it('leaving a traveling swarm sets status to finished/lost', () => {
    const { swarm, p2 } = setupTravelingSwarm();
    const result = leaveSwarm(swarm.id, p2);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('finished');
    expect(result!.gameState?.status).toBe('lost');
  });

  it('leader leaving a recruiting swarm disbands it', () => {
    const leader = uid('disband-leader');
    const swarm = createSwarm(leader, 'Leader', `DisbandTest-${testSeq}`);
    joinSwarm(swarm.id, uid('disband-p2'), 'P2');
    joinSwarm(swarm.id, uid('disband-p3'), 'P3');
    const result = leaveSwarm(swarm.id, leader);
    expect(result).toBeNull();
  });
});

describe('wagon-train: multi-swarm participation', () => {
  it('allows the same leader to create multiple active swarms', () => {
    const leader = uid('multi-leader');
    const swarmA = createSwarm(leader, 'Leader', `MultiA-${testSeq}`);
    const swarmB = createSwarm(leader, 'Leader', `MultiB-${testSeq}`);
    expect(swarmA.id).not.toBe(swarmB.id);
    expect(swarmA.status).toBe('recruiting');
    expect(swarmB.status).toBe('recruiting');
  });

  it('allows a player to join multiple swarms', () => {
    const leaderA = uid('leader-a');
    const leaderB = uid('leader-b');
    const player = uid('multi-player');

    const swarmA = createSwarm(leaderA, 'LeaderA', `JoinA-${testSeq}`);
    const swarmB = createSwarm(leaderB, 'LeaderB', `JoinB-${testSeq}`);

    joinSwarm(swarmA.id, player, 'MultiPlayer');
    joinSwarm(swarmB.id, player, 'MultiPlayer');

    expect(swarmA.players.some((p) => p.playerId === player)).toBe(true);
    expect(swarmB.players.some((p) => p.playerId === player)).toBe(true);
  });
});
