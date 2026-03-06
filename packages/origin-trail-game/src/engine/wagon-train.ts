import { v4 as uuid } from 'uuid';
import { gameEngine } from './game-engine.js';
import type { GameState, ActionResult } from '../game/types.js';

export const MIN_PLAYERS = 3;

export function signatureThreshold(n: number): number {
  return Math.floor((2 / 3) * n);
}

export interface SwarmMember {
  playerId: string;
  displayName: string;
  joinedAt: number;
  isLeader: boolean;
}

export interface Vote {
  playerId: string;
  action: string;
  params?: Record<string, any>;
  timestamp: number;
}

export interface Swarm {
  id: string;
  name: string;
  leaderId: string;
  maxPlayers: number;
  players: SwarmMember[];
  status: 'recruiting' | 'traveling' | 'finished';
  gameState: GameState | null;
  currentTurn: number;
  votes: Vote[];
  turnDeadline: number | null;
  turnHistory: TurnResult[];
  createdAt: number;
}

export interface TurnResult {
  turn: number;
  votes: Vote[];
  winningAction: string;
  tieBreaker: 'majority' | 'leader';
  result: ActionResult;
  timestamp: number;
}

export interface SwarmLobby {
  openSwarms: Swarm[];
  mySwarms: Swarm[];
}

const swarms = new Map<string, Swarm>();

export function createSwarm(leaderId: string, leaderName: string, swarmName: string, maxPlayers: number = 8): Swarm {
  const existing = findPlayerSwarm(leaderId);
  if (existing && existing.status !== 'finished') throw new Error('You already have an active swarm. Leave it first.');

  const swarm: Swarm = {
    id: `swarm-${uuid().slice(0, 8)}`,
    name: swarmName,
    leaderId,
    maxPlayers: Math.min(Math.max(MIN_PLAYERS, maxPlayers), 8),
    players: [{ playerId: leaderId, displayName: leaderName, joinedAt: Date.now(), isLeader: true }],
    status: 'recruiting',
    gameState: null,
    currentTurn: 0,
    votes: [],
    turnDeadline: null,
    turnHistory: [],
    createdAt: Date.now(),
  };
  swarms.set(swarm.id, swarm);
  return swarm;
}

export function joinSwarm(swarmId: string, playerId: string, displayName: string): Swarm {
  const swarm = swarms.get(swarmId);
  if (!swarm) throw new Error('Swarm not found');
  if (swarm.status !== 'recruiting') throw new Error('Swarm is not accepting new members');
  if (swarm.players.length >= swarm.maxPlayers) throw new Error('Swarm is full');
  if (swarm.players.some(p => p.playerId === playerId)) throw new Error('You are already in this swarm');
  const existing = findPlayerSwarm(playerId);
  if (existing && existing.status !== 'finished' && existing.id !== swarmId) throw new Error('You are already in another swarm. Leave it first.');

  swarm.players.push({ playerId, displayName, joinedAt: Date.now(), isLeader: false });
  return swarm;
}

export function leaveSwarm(swarmId: string, playerId: string): Swarm | null {
  const swarm = swarms.get(swarmId);
  if (!swarm) throw new Error('Swarm not found');
  const playerIndex = swarm.players.findIndex(p => p.playerId === playerId);
  if (playerIndex === -1) throw new Error('You are not in this swarm');
  if (swarm.players[playerIndex].isLeader && swarm.status === 'recruiting') { swarms.delete(swarmId); return null; }
  if (swarm.status === 'traveling') throw new Error('Cannot leave swarm during expedition.');
  swarm.players.splice(playerIndex, 1);
  return swarm;
}

export function startExpedition(swarmId: string, playerId: string): Swarm {
  const swarm = swarms.get(swarmId);
  if (!swarm) throw new Error('Swarm not found');
  if (swarm.leaderId !== playerId) throw new Error('Only the orchestrator can launch the expedition');
  if (swarm.status !== 'recruiting') throw new Error('Expedition already launched');
  if (swarm.players.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} agents to start`);

  const partyNames = swarm.players.map(p => p.displayName);
  swarm.gameState = gameEngine.createGame(partyNames, swarm.leaderId);
  swarm.status = 'traveling';
  swarm.currentTurn = 1;
  swarm.votes = [];
  swarm.turnDeadline = Date.now() + 120_000;
  return swarm;
}

export function castVote(swarmId: string, playerId: string, action: string, params?: Record<string, any>): Swarm {
  const swarm = swarms.get(swarmId);
  if (!swarm) throw new Error('Swarm not found');
  if (swarm.status !== 'traveling') throw new Error('Swarm is not on expedition');
  if (!swarm.players.some(p => p.playerId === playerId)) throw new Error('You are not in this swarm');
  swarm.votes = swarm.votes.filter(v => v.playerId !== playerId);
  swarm.votes.push({ playerId, action, params, timestamp: Date.now() });

  if (swarm.votes.length === swarm.players.length) resolveTurn(swarm);
  return swarm;
}

export function forceResolveTurn(swarmId: string, playerId?: string): Swarm {
  const swarm = swarms.get(swarmId);
  if (!swarm) throw new Error('Swarm not found');
  if (swarm.status !== 'traveling') throw new Error('Swarm is not on expedition');
  if (playerId && playerId !== swarm.leaderId) {
    if (swarm.turnDeadline && Date.now() < swarm.turnDeadline) throw new Error('Only orchestrator can force resolve before deadline');
  }
  if (swarm.votes.length === 0) {
    swarm.votes = [{ playerId: swarm.leaderId, action: 'advance', params: {}, timestamp: Date.now() }];
  }
  resolveTurn(swarm);
  return swarm;
}

function resolveTurn(swarm: Swarm): void {
  if (!swarm.gameState) return;

  const voteCounts = new Map<string, { count: number; votes: Vote[] }>();
  for (const vote of swarm.votes) {
    const entry = voteCounts.get(vote.action) || { count: 0, votes: [] };
    entry.count++;
    entry.votes.push(vote);
    voteCounts.set(vote.action, entry);
  }

  let winningAction = 'syncMemory';
  let maxVotes = 0;
  let isTie = false;
  const tiedActions: string[] = [];

  for (const [action, data] of voteCounts) {
    if (data.count > maxVotes) {
      maxVotes = data.count;
      winningAction = action;
      isTie = false;
      tiedActions.length = 0;
      tiedActions.push(action);
    } else if (data.count === maxVotes) {
      isTie = true;
      tiedActions.push(action);
    }
  }

  let tieBreaker: 'majority' | 'leader' = 'majority';
  if (isTie && tiedActions.length > 1) {
    const leaderVote = swarm.votes.find(v => v.playerId === swarm.leaderId);
    if (leaderVote && tiedActions.includes(leaderVote.action)) {
      winningAction = leaderVote.action;
      tieBreaker = 'leader';
    } else {
      winningAction = tiedActions.sort()[0];
    }
  }

  let params: Record<string, any> = {};
  const winningVotes = voteCounts.get(winningAction)?.votes || [];
  const leaderWinningVote = winningVotes.find(v => v.playerId === swarm.leaderId);
  if (leaderWinningVote?.params) params = leaderWinningVote.params;
  else if (winningVotes[0]?.params) params = winningVotes[0].params;

  const result = gameEngine.executeAction(swarm.gameState, { type: winningAction as any, params });
  if (result.success) swarm.gameState = result.newState;

  swarm.turnHistory.push({
    turn: swarm.currentTurn,
    votes: [...swarm.votes],
    winningAction,
    tieBreaker,
    result,
    timestamp: Date.now(),
  });

  if (swarm.gameState.status !== 'active') {
    swarm.status = 'finished';
  } else {
    swarm.currentTurn++;
    swarm.votes = [];
    swarm.turnDeadline = Date.now() + 120_000;
  }
}

export function getLobby(playerId: string): SwarmLobby {
  const openSwarms: Swarm[] = [];
  const mySwarms: Swarm[] = [];
  for (const swarm of swarms.values()) {
    if (swarm.players.some(p => p.playerId === playerId)) mySwarms.push(swarm);
    else if (swarm.status === 'recruiting' && swarm.players.length < swarm.maxPlayers) openSwarms.push(swarm);
  }
  openSwarms.sort((a, b) => b.createdAt - a.createdAt);
  mySwarms.sort((a, b) => b.createdAt - a.createdAt);
  return { openSwarms, mySwarms };
}

export function getSwarm(swarmId: string): Swarm | null {
  return swarms.get(swarmId) || null;
}

export function findPlayerSwarm(playerId: string): Swarm | null {
  for (const swarm of swarms.values()) {
    if (swarm.players.some(p => p.playerId === playerId)) return swarm;
  }
  return null;
}

export function getVoteStatus(swarmId: string, requesterId?: string) {
  const swarm = swarms.get(swarmId);
  if (!swarm) throw new Error('Swarm not found');
  const allVoted = swarm.votes.length === swarm.players.length;
  const votes = swarm.players.map(p => {
    const vote = swarm.votes.find(v => v.playerId === p.playerId);
    const canSee = allVoted || (requesterId === p.playerId);
    return { player: p.displayName, action: canSee ? (vote?.action || null) : null, hasVoted: !!vote };
  });
  return { votes, timeRemaining: swarm.turnDeadline ? Math.max(0, swarm.turnDeadline - Date.now()) : 0, allVoted };
}

export function formatSwarmState(swarm: Swarm, requesterId?: string) {
  return {
    id: swarm.id,
    name: swarm.name,
    leaderId: swarm.leaderId,
    leaderName: swarm.players.find(p => p.isLeader)?.displayName,
    maxPlayers: swarm.maxPlayers,
    playerCount: swarm.players.length,
    minPlayers: MIN_PLAYERS,
    signatureThreshold: signatureThreshold(swarm.players.length),
    players: swarm.players.map(p => ({ id: p.playerId, name: p.displayName, isLeader: p.isLeader })),
    status: swarm.status,
    currentTurn: swarm.currentTurn,
    gameState: swarm.gameState,
    voteStatus: swarm.status === 'traveling' ? getVoteStatus(swarm.id, requesterId) : null,
    lastTurn: swarm.turnHistory[swarm.turnHistory.length - 1] || null,
  };
}
