/**
 * OriginTrail Game DKG Coordinator
 *
 * Bridges the game engine with the DKG network:
 * - Workspace for ephemeral state (votes, lobby)
 * - GossipSub for real-time coordination between nodes
 * - Publish for permanent game state (turn results → context graph)
 *
 * All gossipsub messages flow through the paranet's app topic
 * (dkg/paranet/{paranetId}/app) so every node subscribed to the
 * paranet — including relays — relays game coordination messages.
 */

import { createHash } from 'node:crypto';
import { MerkleTree, hashTriple } from '@dkg/core';
import { ethers } from 'ethers';
import { gameEngine, GameEngine } from '../engine/game-engine.js';
import type { GameState, ActionResult } from '../game/types.js';
import { signatureThreshold, MIN_PLAYERS, MAX_PLAYERS } from '../engine/wagon-train.js';
import * as proto from './protocol.js';
import * as rdf from './rdf.js';

/** Subset of PublishResult from @dkg/publisher — keep aligned with the canonical type. */
interface DKGPublishReturn {
  ual?: string;
  onChainResult?: { txHash?: string; blockNumber?: number };
}

interface DKGAgent {
  peerId: string;
  identityId: bigint;
  gossip: {
    subscribe(topic: string): void;
    publish(topic: string, data: Uint8Array): Promise<void>;
    onMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void): void;
    offMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void): void;
  };
  writeToWorkspace(paranetId: string, quads: any[]): Promise<{ workspaceOperationId: string }>;
  publish(paranetId: string | { paranetId: string; quads: any[] }, quads?: any[]): Promise<DKGPublishReturn | undefined>;
  enshrineFromWorkspace(
    paranetId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: {
      clearWorkspaceAfter?: boolean;
      contextGraphId?: string | bigint;
      contextGraphSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
    },
  ): Promise<DKGPublishReturn | undefined>;
  createContextGraph(params: {
    participantIdentityIds: bigint[];
    requiredSignatures: number;
  }): Promise<{ contextGraphId: bigint; success: boolean }>;
  signContextGraphDigest(
    contextGraphId: bigint,
    merkleRoot: Uint8Array,
  ): Promise<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
  query(sparql: string, options?: any): Promise<any>;
}

export interface CoordinatorConfig {
  paranetId: string;
}

export interface SwarmMember {
  peerId: string;
  displayName: string;
  joinedAt: number;
  isLeader: boolean;
  identityId?: string;
}

export interface Vote {
  peerId: string;
  action: string;
  params?: Record<string, any>;
  turn: number;
  timestamp: number;
}

export interface ParticipantSignature {
  identityId: bigint;
  r: Uint8Array;
  vs: Uint8Array;
}

export interface TurnProposal {
  turn: number;
  hash: string;
  winningAction: string;
  newStateJson: string;
  resultMessage: string;
  approvals: Set<string>;
  approvalTimestamps: Map<string, number>;
  votes: Array<{ peerId: string; action: string }>;
  resolution: 'consensus' | 'leader-tiebreak' | 'force-resolved';
  deaths: Array<{ name: string; cause: string; partyIndex?: number }>;
  event?: { type: string; description: string };
  actionSuccess?: boolean;
  turnQuads?: Array<{ subject: string; predicate: string; object: string; graph: string }>;
  merkleRoot?: Uint8Array;
  proposalTimestamp: number;
  participantSignatures: Map<string, ParticipantSignature>;
}

export interface SwarmState {
  id: string;
  name: string;
  leaderPeerId: string;
  maxPlayers: number;
  players: SwarmMember[];
  status: 'recruiting' | 'traveling' | 'finished';
  gameState: GameState | null;
  currentTurn: number;
  votes: Vote[];
  turnDeadline: number | null;
  pendingProposal: TurnProposal | null;
  turnHistory: ResolvedTurn[];
  createdAt: number;
  playerIndexMap: Map<string, number>;
  contextGraphId?: string;
  requiredSignatures?: number;
}

export interface ResolvedTurn {
  turn: number;
  winningAction: string;
  resultMessage: string;
  approvers: string[];
  votes: Array<{ peerId: string; action: string }>;
  resolution: 'consensus' | 'leader-tiebreak' | 'force-resolved';
  deaths: Array<{ name: string; cause: string; partyIndex?: number }>;
  event?: { type: string; description: string };
  timestamp: number;
}

function hashProposal(swarmId: string, turn: number, stateJson: string): string {
  return createHash('sha256').update(`${swarmId}:${turn}:${stateJson}`).digest('hex');
}

function detectDeaths(
  oldState: GameState | null,
  newState: GameState,
  event?: { type: string; description: string; affectedMember?: string },
): Array<{ name: string; cause: string; partyIndex: number }> {
  if (!oldState) return [];
  return newState.party
    .map((m, i) => ({ m, i }))
    .filter(({ m, i }) => !m.alive && oldState.party[i]?.alive)
    .map(({ m, i }) => {
      if (event?.affectedMember === m.name) {
        return { name: m.name, cause: event.description, partyIndex: i };
      }
      if (newState.trainingTokens <= 0) {
        return { name: m.name, cause: 'Ran out of training tokens — starvation', partyIndex: i };
      }
      if (event) {
        return { name: m.name, cause: event.description, partyIndex: i };
      }
      const oldMember = oldState.party.find(p => p.name === m.name);
      if (oldMember && oldMember.health > 0 && m.health <= 0) {
        return { name: m.name, cause: 'Health depleted from sustained damage', partyIndex: i };
      }
      return { name: m.name, cause: 'Succumbed to accumulated damage', partyIndex: i };
    });
}

function stripQuotes(s: string): string {
  if (s.startsWith('"')) {
    const dtIdx = s.indexOf('"^^');
    if (dtIdx > 0) return s.slice(1, dtIdx);
    return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
  }
  return s;
}

export type NotificationType =
  | 'swarm_created'
  | 'player_joined'
  | 'player_left'
  | 'expedition_launched'
  | 'vote_cast'
  | 'turn_resolved';

export interface GameNotification {
  id: string;
  type: NotificationType;
  swarmId: string;
  swarmName?: string;
  playerName?: string;
  peerId: string;
  message: string;
  turn?: number;
  action?: string;
  timestamp: number;
  read: boolean;
}

let notifSeq = 0;
function nextNotifId(): string {
  return `notif-${Date.now()}-${++notifSeq}`;
}

export class OriginTrailGameCoordinator {
  readonly agent: DKGAgent;
  readonly paranetId: string;
  private readonly topic: string;
  private swarms = new Map<string, SwarmState>();
  private subscribed = false;
  private log: (msg: string) => void;
  private voteHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private topologyTimer: ReturnType<typeof setInterval> | null = null;
  private workspaceOps = new Map<string, Array<{ workspaceOperationId: string; rootEntities: string[] }>>();
  private notifications: GameNotification[] = [];
  private static readonly MAX_NOTIFICATIONS = 200;

  constructor(agent: DKGAgent, config: CoordinatorConfig, log?: (msg: string) => void) {
    this.agent = agent;
    this.paranetId = config.paranetId;
    this.topic = proto.appTopic(config.paranetId);
    this.log = log ?? (() => {});
    this.subscribe();
    this.scheduleGraphSync();
    this.scheduleTopologySnapshots();
  }

  private pushNotification(n: Omit<GameNotification, 'id' | 'read' | 'timestamp'> & { timestamp?: number }): void {
    const notification: GameNotification = { ...n, timestamp: n.timestamp ?? Date.now(), id: nextNotifId(), read: false };
    this.notifications.push(notification);
    if (this.notifications.length > OriginTrailGameCoordinator.MAX_NOTIFICATIONS) {
      this.notifications = this.notifications.slice(-OriginTrailGameCoordinator.MAX_NOTIFICATIONS);
    }
  }

  getNotifications(): { notifications: GameNotification[]; unreadCount: number } {
    const sorted = [...this.notifications].sort((a, b) => b.timestamp - a.timestamp);
    return {
      notifications: sorted,
      unreadCount: this.notifications.filter(n => !n.read).length,
    };
  }

  markNotificationsRead(ids?: string[]): number {
    let count = 0;
    for (const n of this.notifications) {
      if (n.read) continue;
      if (!ids || ids.includes(n.id)) { n.read = true; count++; }
    }
    return count;
  }

  get myPeerId(): string {
    return this.agent.peerId;
  }

  private subscribe(): void {
    if (this.subscribed) return;
    this.agent.gossip.subscribe(this.topic);
    this.agent.gossip.onMessage(this.topic, this.handleMessage);
    this.subscribed = true;
  }

  // ── Player profile registration ──────────────────────────────────

  async publishPlayerProfile(displayName: string): Promise<void> {
    const entity = `did:dkg:game:player:${this.myPeerId}`;
    try {
      const result = await this.agent.query(
        `SELECT (1 AS ?exists) WHERE { <${entity}> a <${rdf.OT}Player> } LIMIT 1`,
        { paranetId: this.paranetId, includeWorkspace: true },
      );
      const bindings = result?.result?.bindings ?? result?.bindings ?? [];
      if (bindings.length > 0) {
        this.log(`Player profile for "${displayName}" already exists, skipping`);
        return;
      }
    } catch {
      // If query fails, try writing anyway
    }
    const quads = rdf.playerProfileQuads(this.paranetId, this.myPeerId, displayName);
    try {
      await this.agent.writeToWorkspace(this.paranetId, quads);
      this.log(`Player profile for "${displayName}" written to workspace`);
    } catch (err: any) {
      this.log(`Failed to write player profile: ${err.message}`);
    }
  }

  // ── Graph-based lobby sync ────────────────────────────────────────

  private scheduleGraphSync(): void {
    setTimeout(() => this.loadLobbyFromGraph().catch(() => {}), 5_000);
  }

  async loadLobbyFromGraph(): Promise<void> {
    try {
      const playersResult = await this.agent.query(
        `SELECT ?player ?name ?peerId ?registeredAt WHERE {
          ?player a <${rdf.SPARQL_PREFIXES.OT}Player> ;
                  <${rdf.SPARQL_PREFIXES.SCHEMA}name> ?name ;
                  <${rdf.SPARQL_PREFIXES.DKG}peerId> ?peerId .
          OPTIONAL { ?player <${rdf.SPARQL_PREFIXES.PROV}atTime> ?registeredAt }
        }`,
        { paranetId: this.paranetId },
      );

      const playerCount = playersResult.bindings?.length ?? 0;
      this.log(`Graph sync: found ${playerCount} registered players`);

      const swarmsResult = await this.agent.query(
        `SELECT ?swarm ?name ?status ?orchestrator ?createdAt ?maxPlayers WHERE {
          ?swarm a <${rdf.SPARQL_PREFIXES.OT}AgentSwarm> ;
                 <${rdf.SPARQL_PREFIXES.OT}name> ?name ;
                 <${rdf.SPARQL_PREFIXES.OT}status> ?status .
          OPTIONAL { ?swarm <${rdf.SPARQL_PREFIXES.OT}orchestrator> ?orchestrator }
          OPTIONAL { ?swarm <${rdf.SPARQL_PREFIXES.OT}createdAt> ?createdAt }
          OPTIONAL { ?swarm <${rdf.SPARQL_PREFIXES.OT}maxPlayers> ?maxPlayers }
        }`,
        { paranetId: this.paranetId, includeWorkspace: true },
      );

      const newSwarms = swarmsResult.bindings?.length ?? 0;
      this.log(`Graph sync: found ${newSwarms} swarms in graph`);

      for (const row of swarmsResult.bindings ?? []) {
        const swarmUri = row['swarm'] ?? '';
        const swarmIdMatch = swarmUri.match(/swarm\/(swarm-.+)$/);
        if (!swarmIdMatch) continue;
        const swarmId = swarmIdMatch[1];

        if (this.swarms.has(swarmId)) continue;

        const statusRaw = stripQuotes(row['status'] ?? '');
        if (statusRaw !== 'recruiting') continue;

        const orchestratorUri = row['orchestrator'] ?? '';
        const orchestratorId = orchestratorUri.replace(/.*player\//, '');
        const swarmName = stripQuotes(row['name'] ?? '');
        const createdAt = Number(stripQuotes(row['createdAt'] ?? '0'));
        const graphMaxPlayers = Number(stripQuotes(row['maxPlayers'] ?? '0'));
        const restoredMaxPlayers = graphMaxPlayers >= MIN_PLAYERS && graphMaxPlayers <= MAX_PLAYERS
          ? graphMaxPlayers
          : MAX_PLAYERS;

        const membersResult = await this.agent.query(
          `SELECT ?agent ?displayName WHERE {
            ?membership a <${rdf.SPARQL_PREFIXES.OT}SwarmMembership> ;
                        <${rdf.SPARQL_PREFIXES.OT}agent> ?agent ;
                        <${rdf.SPARQL_PREFIXES.OT}displayName> ?displayName ;
                        <${rdf.SPARQL_PREFIXES.OT}swarm> <${swarmUri}> .
          }`,
          { paranetId: this.paranetId, includeWorkspace: true },
        );

        const players: SwarmMember[] = (membersResult.bindings ?? []).map((m: any) => {
          const pUri = m['agent'] ?? '';
          const pid = pUri.replace(/.*player\//, '');
          return {
            peerId: pid,
            displayName: stripQuotes(m['displayName'] ?? ''),
            joinedAt: createdAt,
            isLeader: pid === orchestratorId,
          };
        });

        const swarm: SwarmState = {
          id: swarmId,
          name: swarmName,
          leaderPeerId: orchestratorId,
          maxPlayers: restoredMaxPlayers,
          players,
          status: 'recruiting',
          gameState: null,
          currentTurn: 0,
          votes: [],
          turnDeadline: null,
          pendingProposal: null,
          turnHistory: [],
          createdAt,
          playerIndexMap: new Map(),
        };
        this.swarms.set(swarmId, swarm);
        this.log(`Graph sync: restored swarm "${swarmName}" (${swarmId}) with ${players.length} players`);
      }
    } catch (err: any) {
      this.log(`Graph sync failed: ${err.message}`);
    }
  }

  async getRegisteredPlayers(): Promise<Array<{ name: string; peerId: string; registeredAt: string }>> {
    try {
      const result = await this.agent.query(
        `SELECT ?name ?peerId ?registeredAt WHERE {
          ?player a <${rdf.SPARQL_PREFIXES.OT}Player> ;
                  <${rdf.SPARQL_PREFIXES.SCHEMA}name> ?name ;
                  <${rdf.SPARQL_PREFIXES.DKG}peerId> ?peerId .
          OPTIONAL { ?player <${rdf.SPARQL_PREFIXES.PROV}atTime> ?registeredAt }
        }`,
        { paranetId: this.paranetId, includeWorkspace: true },
      );

      return (result.bindings ?? []).map((row: any) => ({
        name: stripQuotes(row['name'] ?? ''),
        peerId: stripQuotes(row['peerId'] ?? ''),
        registeredAt: stripQuotes(row['registeredAt'] ?? ''),
      }));
    } catch {
      return [];
    }
  }

  // ── Lobby operations ──────────────────────────────────────────────

  async createSwarm(playerName: string, swarmName: string, maxPlayers = 3): Promise<SwarmState> {
    const existing = this.findMySwarm();
    if (existing && existing.status !== 'finished') {
      throw new Error('You already have an active swarm. Leave it first.');
    }

    const swarmId = `swarm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();

    const myIdentityId = this.agent.identityId > 0n ? String(this.agent.identityId) : undefined;

    const swarm: SwarmState = {
      id: swarmId,
      name: swarmName,
      leaderPeerId: this.myPeerId,
      maxPlayers: Math.min(Math.max(MIN_PLAYERS, maxPlayers), MAX_PLAYERS),
      players: [{
        peerId: this.myPeerId,
        displayName: playerName,
        joinedAt: now,
        isLeader: true,
        identityId: myIdentityId,
      }],
      status: 'recruiting',
      gameState: null,
      currentTurn: 0,
      votes: [],
      turnDeadline: null,
      pendingProposal: null,
      turnHistory: [],
      createdAt: now,
      playerIndexMap: new Map(),
    };

    this.swarms.set(swarmId, swarm);

    const quads = [
      ...rdf.swarmCreatedQuads(this.paranetId, swarmId, swarmName, this.myPeerId, now, swarm.maxPlayers),
      ...rdf.playerJoinedQuads(this.paranetId, swarmId, this.myPeerId, playerName),
    ];
    const wsResult = await this.agent.writeToWorkspace(this.paranetId, quads);
    this.trackWorkspaceOp(swarmId, wsResult.workspaceOperationId, quads);

    const msg: proto.SwarmCreatedMsg = {
      app: proto.APP_ID,
      type: 'swarm:created',
      swarmId,
      peerId: this.myPeerId,
      timestamp: now,
      swarmName,
      playerName,
      maxPlayers: swarm.maxPlayers,
      identityId: myIdentityId,
    };
    await this.broadcast(msg);
    this.log(`Swarm created: ${swarmName} (${swarmId})`);
    return swarm;
  }

  async joinSwarm(swarmId: string, playerName: string): Promise<SwarmState> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error('Swarm not found');
    if (swarm.status !== 'recruiting') throw new Error('Swarm is not accepting new players');
    if (swarm.players.length >= swarm.maxPlayers) throw new Error('Swarm is full');
    if (swarm.players.some(p => p.peerId === this.myPeerId)) throw new Error('You are already in this swarm');

    const now = Date.now();
    const myIdentityId = this.agent.identityId > 0n ? String(this.agent.identityId) : undefined;
    swarm.players.push({
      peerId: this.myPeerId,
      displayName: playerName,
      joinedAt: now,
      isLeader: false,
      identityId: myIdentityId,
    });

    const joinQuads = rdf.playerJoinedQuads(this.paranetId, swarmId, this.myPeerId, playerName);
    const wsResult = await this.agent.writeToWorkspace(this.paranetId, joinQuads);
    this.trackWorkspaceOp(swarmId, wsResult.workspaceOperationId, joinQuads);

    const msg: proto.SwarmJoinedMsg = {
      app: proto.APP_ID,
      type: 'swarm:joined',
      swarmId,
      peerId: this.myPeerId,
      timestamp: now,
      playerName,
      identityId: myIdentityId,
    };
    await this.broadcast(msg);
    this.log(`Joined swarm ${swarmId} as ${playerName}`);
    return swarm;
  }

  async leaveSwarm(swarmId: string): Promise<SwarmState | null> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error('Swarm not found');
    if (!swarm.players.some(p => p.peerId === this.myPeerId)) throw new Error('You are not in this swarm');

    if (swarm.leaderPeerId === this.myPeerId && swarm.status === 'recruiting') {
      this.swarms.delete(swarmId);
      this.workspaceOps.delete(swarmId);
      const msg: proto.SwarmLeftMsg = { app: proto.APP_ID, type: 'swarm:left', swarmId, peerId: this.myPeerId, timestamp: Date.now() };
      await this.broadcast(msg);
      return null;
    }

    if (swarm.status === 'traveling') {
      swarm.status = 'finished';
      if (swarm.gameState) swarm.gameState.status = 'lost';
      this.workspaceOps.delete(swarmId);
      this.log(`Player left during journey — swarm ${swarmId} ended`);
    }

    swarm.players = swarm.players.filter(p => p.peerId !== this.myPeerId);
    const msg: proto.SwarmLeftMsg = { app: proto.APP_ID, type: 'swarm:left', swarmId, peerId: this.myPeerId, timestamp: Date.now() };
    await this.broadcast(msg);
    return swarm;
  }

  // ── Journey operations ────────────────────────────────────────────

  async launchExpedition(swarmId: string): Promise<SwarmState> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error('Swarm not found');
    if (swarm.leaderPeerId !== this.myPeerId) throw new Error('Only the leader can start the journey');
    if (swarm.status !== 'recruiting') throw new Error('Journey already started');
    if (swarm.players.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players to start`);

    const partyNames = swarm.players.map(p => p.displayName);
    const newGameState = gameEngine.createGame(partyNames, this.myPeerId);
    const gameStateJson = JSON.stringify(newGameState);
    const now = Date.now();

    try {
      await this.agent.writeToWorkspace(
        this.paranetId,
        rdf.expeditionLaunchedQuads(this.paranetId, swarmId, gameStateJson, now),
      );
    } catch (err) {
      this.log(`Failed to persist expedition state: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Create on-chain context graph with all participant identity IDs.
    // M = ceil(2N/3): matches the gossip consensus threshold so the
    // contract enforces the same quorum that the game protocol requires.
    // All active players must have an identityId; otherwise skip context-graph
    // mode to prevent silently lowering quorum.
    try {
      const allIds = swarm.players.map(p => p.identityId);
      const missing = allIds.filter(id => id == null || id === '0');
      if (missing.length > 0) {
        this.log(`Skipping context graph: ${missing.length}/${swarm.players.length} players lack an identityId`);
      } else {
        const participantIdentityIds = allIds.map(id => BigInt(id!))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const M = signatureThreshold(participantIdentityIds.length);
        const result = await this.agent.createContextGraph({
          participantIdentityIds,
          requiredSignatures: M,
        });
        if (result.success) {
          swarm.contextGraphId = String(result.contextGraphId);
          swarm.requiredSignatures = M;
          this.log(`Context graph ${swarm.contextGraphId} created for swarm ${swarmId} (M=${M}, ${participantIdentityIds.length} participants)`);
        }
      }
    } catch (err) {
      this.log(`Context graph creation failed (game proceeds without on-chain anchoring): ${err instanceof Error ? err.message : String(err)}`);
    }

    swarm.gameState = newGameState;
    swarm.playerIndexMap = new Map(swarm.players.map((p, i) => [p.peerId, i]));
    swarm.status = 'traveling';
    swarm.currentTurn = 1;
    swarm.votes = [];
    swarm.turnDeadline = Date.now() + 30_000;

    const msg: proto.ExpeditionLaunchedMsg = {
      app: proto.APP_ID,
      type: 'expedition:launched',
      swarmId,
      peerId: this.myPeerId,
      timestamp: now,
      gameStateJson,
      partyOrder: swarm.players.map(p => p.peerId),
      contextGraphId: swarm.contextGraphId,
      requiredSignatures: swarm.requiredSignatures,
    };
    await this.broadcast(msg);
    this.log(`Expedition launched for ${swarmId}`);
    return swarm;
  }

  // ── Voting ────────────────────────────────────────────────────────

  async castVote(swarmId: string, action: string, params?: Record<string, any>): Promise<SwarmState> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error('Swarm not found');
    if (swarm.status !== 'traveling') throw new Error('Swarm is not traveling');
    const playerIdx = swarm.players.findIndex(p => p.peerId === this.myPeerId);
    if (playerIdx === -1) throw new Error('You are not in this swarm');
    if (swarm.gameState?.party[playerIdx] && !swarm.gameState.party[playerIdx].alive) {
      throw new Error('Your agent has been eliminated and cannot vote');
    }

    swarm.votes = swarm.votes.filter(v => v.peerId !== this.myPeerId);
    const vote: Vote = {
      peerId: this.myPeerId,
      action,
      params,
      turn: swarm.currentTurn,
      timestamp: Date.now(),
    };
    swarm.votes.push(vote);

    const voteQuads = rdf.voteCastQuads(this.paranetId, swarmId, swarm.currentTurn, this.myPeerId, action, params);
    const wsResult = await this.agent.writeToWorkspace(this.paranetId, voteQuads);
    this.trackWorkspaceOp(swarmId, wsResult.workspaceOperationId, voteQuads);

    const msg: proto.VoteCastMsg = {
      app: proto.APP_ID,
      type: 'vote:cast',
      swarmId,
      peerId: this.myPeerId,
      timestamp: vote.timestamp,
      turn: swarm.currentTurn,
      action,
      params,
    };
    await this.broadcast(msg);
    this.log(`Vote cast: ${action} for turn ${swarm.currentTurn} on ${swarmId}`);

    this.startVoteHeartbeat(swarmId);

    if (this.allAliveVoted(swarm) && swarm.leaderPeerId === this.myPeerId) {
      await this.proposeTurnResolution(swarm);
    }

    return swarm;
  }

  private alivePlayerCount(swarm: SwarmState): number {
    if (!swarm.gameState) return swarm.players.length;
    return swarm.gameState.party.filter((m, i) => m.alive && i < swarm.players.length).length;
  }

  private isPeerAlive(swarm: SwarmState, peerId: string): boolean {
    if (!swarm.gameState) return true;
    const idx = swarm.players.findIndex(p => p.peerId === peerId);
    if (idx === -1 || idx >= swarm.gameState.party.length) return false;
    return swarm.gameState.party[idx].alive;
  }

  private allAliveVoted(swarm: SwarmState): boolean {
    const aliveVotes = swarm.votes.filter(v => this.isPeerAlive(swarm, v.peerId)).length;
    return aliveVotes >= this.alivePlayerCount(swarm);
  }

  private startVoteHeartbeat(swarmId: string): void {
    this.stopVoteHeartbeat(swarmId);
    const turn = this.swarms.get(swarmId)?.currentTurn;

    const timer = setInterval(async () => {
      const swarm = this.swarms.get(swarmId);
      if (!swarm || swarm.currentTurn !== turn || this.allAliveVoted(swarm)) {
        this.stopVoteHeartbeat(swarmId);
        return;
      }

      const myVote = swarm.votes.find(v => v.peerId === this.myPeerId && v.turn === turn);
      if (!myVote) { this.stopVoteHeartbeat(swarmId); return; }

      const msg: proto.VoteCastMsg = {
        app: proto.APP_ID,
        type: 'vote:cast',
        swarmId,
        peerId: this.myPeerId,
        timestamp: myVote.timestamp,
        turn,
        action: myVote.action,
        params: myVote.params,
      };
      await this.broadcast(msg);
      this.log(`Vote heartbeat: re-broadcast ${myVote.action} for turn ${turn}`);
    }, 5_000);

    this.voteHeartbeatTimers.set(swarmId, timer);
  }

  private stopVoteHeartbeat(swarmId: string): void {
    const timer = this.voteHeartbeatTimers.get(swarmId);
    if (timer) {
      clearInterval(timer);
      this.voteHeartbeatTimers.delete(swarmId);
    }
  }

  // ── Turn resolution (GM only) ────────────────────────────────────

  private async proposeTurnResolution(swarm: SwarmState): Promise<void> {
    if (!swarm.gameState) return;
    if (swarm.leaderPeerId !== this.myPeerId) return;

    const { winningAction, params, tieBreaker } = this.tallyVotes(swarm);
    const result = gameEngine.executeAction(swarm.gameState, { type: winningAction as any, params });

    const newStateJson = JSON.stringify(result.newState);
    const hash = hashProposal(swarm.id, swarm.currentTurn, newStateJson);
    const votes = swarm.votes.map(v => ({ peerId: v.peerId, action: v.action }));
    const resolution = tieBreaker === 'leader' ? 'leader-tiebreak' as const : 'consensus' as const;
    const event = result.event ? { type: result.event.type, description: result.event.description, affectedMember: result.event.affectedMember } : undefined;
    const deaths = detectDeaths(swarm.gameState, result.newState, event);
    const turnEvent = event ? { type: event.type, description: event.description } : undefined;

    const proposalTimestamp = Date.now();
    const voteAttestors = votes.map(v => ({ peerId: v.peerId, timestamp: proposalTimestamp }));
    const turnQuads = this.computeTurnQuads(
      swarm.id, swarm.currentTurn, winningAction, newStateJson,
      votes.map(v => v.peerId), voteAttestors, resolution, hash,
    );
    const tripleHashes = turnQuads.map(q => hashTriple(q.subject, q.predicate, q.object));
    const merkleRoot = new MerkleTree(tripleHashes).root;

    // Always provide merkleRootHex so peers can produce signatures,
    // even if leader self-signing fails (best-effort).
    const leaderSigs = new Map<string, ParticipantSignature>();
    const merkleRootHex = swarm.contextGraphId ? ethers.hexlify(merkleRoot) : undefined;
    if (swarm.contextGraphId && this.agent.identityId > 0n) {
      try {
        const sig = await this.agent.signContextGraphDigest(
          BigInt(swarm.contextGraphId), merkleRoot,
        );
        leaderSigs.set(this.myPeerId, sig);
      } catch { /* chain adapter may not support signing */ }
    }

    swarm.pendingProposal = {
      turn: swarm.currentTurn,
      hash,
      winningAction,
      newStateJson,
      resultMessage: result.message,
      approvals: new Set([this.myPeerId]),
      approvalTimestamps: new Map([[this.myPeerId, Date.now()]]),
      votes,
      resolution,
      deaths,
      event: turnEvent,
      actionSuccess: result.success,
      turnQuads,
      merkleRoot,
      proposalTimestamp,
      participantSignatures: leaderSigs,
    };

    const msg: proto.TurnProposalMsg = {
      app: proto.APP_ID,
      type: 'turn:proposal',
      swarmId: swarm.id,
      peerId: this.myPeerId,
      timestamp: proposalTimestamp,
      turn: swarm.currentTurn,
      proposalHash: hash,
      winningAction,
      newStateJson,
      resultMessage: result.message,
      votes,
      resolution,
      deaths,
      event: turnEvent,
      merkleRoot: merkleRootHex,
      contextGraphId: swarm.contextGraphId,
    };
    await this.broadcast(msg);
    this.log(`Turn ${swarm.currentTurn} proposal broadcast for ${swarm.id} (hash=${hash.slice(0, 8)})`);

    await this.checkProposalThreshold(swarm);
  }

  /**
   * Write quads to workspace and enshrine them to the swarm's context graph.
   * Falls back to plain publish if no context graph is configured.
   *
   * Quads are normalized to the workspace graph before staging because
   * the workspace validator enforces graph URI === paranet workspace graph.
   * The on-chain context graph linkage is handled by the contextGraphId
   * parameter passed to enshrineFromWorkspace, not the quad's graph URI.
   */
  private async enshrineToContextGraph(
    swarm: SwarmState,
    quads: Array<{ subject: string; predicate: string; object: string; graph: string }>,
    label: string,
    contextGraphSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>,
  ): Promise<DKGPublishReturn | undefined> {
    const wsGraph = rdf.workspaceGraph(this.paranetId);
    const normalized = quads.map(q => ({ ...q, graph: wsGraph }));

    await this.agent.writeToWorkspace(this.paranetId, normalized);
    const rootEntities = [...new Set(normalized.map(q => q.subject))];

    if (swarm.contextGraphId) {
      const result = await this.agent.enshrineFromWorkspace(
        this.paranetId,
        { rootEntities },
        { contextGraphId: swarm.contextGraphId, contextGraphSignatures },
      );
      this.log(`${label} enshrined to context graph ${swarm.contextGraphId}`);
      return result;
    }

    const result = await this.agent.publish(this.paranetId, normalized);
    this.log(`${label} published (no context graph)`);
    return result;
  }

  private async checkProposalThreshold(swarm: SwarmState): Promise<void> {
    const proposal = swarm.pendingProposal;
    if (!proposal) return;

    // Turn progression is always gated by gossip approval count.
    // Signature collection for context-graph enshrinement is best-effort
    // at publish time — a signing failure must not deadlock the game.
    const threshold = swarm.requiredSignatures ?? signatureThreshold(swarm.players.length);
    if (proposal.approvals.size < threshold) return;

    const isLeader = swarm.leaderPeerId === this.myPeerId;
    const opsSnapshot = isLeader ? [...(this.workspaceOps.get(swarm.id) ?? [])] : [];
    if (isLeader) this.workspaceOps.delete(swarm.id);

    swarm.pendingProposal = null;
    this.stopVoteHeartbeat(swarm.id);

    const newState: GameState = JSON.parse(proposal.newStateJson);
    if (proposal.winningAction) swarm.gameState = newState;

    swarm.turnHistory.push({
      turn: proposal.turn,
      winningAction: proposal.winningAction,
      resultMessage: proposal.resultMessage,
      approvers: [...proposal.approvals],
      votes: proposal.votes,
      resolution: proposal.resolution,
      deaths: proposal.deaths,
      event: proposal.event,
      timestamp: Date.now(),
    });

    if (newState.status !== 'active') {
      swarm.status = 'finished';
    } else {
      swarm.currentTurn++;
      swarm.votes = [];
      swarm.turnDeadline = Date.now() + 30_000;
    }

    if (isLeader) {
      try {
        const collectedSigs = [...proposal.participantSignatures.values()];
        let turnQuads = proposal.turnQuads ?? [];

        if (turnQuads.length === 0) {
          const voteAttestors = proposal.votes.map(v => ({
            peerId: v.peerId,
            timestamp: proposal.proposalTimestamp,
          }));
          turnQuads = this.computeTurnQuads(
            swarm.id, proposal.turn, proposal.winningAction,
            proposal.newStateJson, proposal.votes.map(v => v.peerId),
            voteAttestors, proposal.resolution, proposal.hash,
          );
          if (turnQuads.length > 0) {
            this.log(`Turn ${proposal.turn}: recomputed ${turnQuads.length} turn quads from proposal data`);
          }
        }

        if (turnQuads.length === 0) {
          this.log(`Turn ${proposal.turn}: no quads to publish after recomputation, skipping enshrinement`);
        } else {
          const reqSigs = swarm.requiredSignatures ?? 0;
          let useContextGraph = !!swarm.contextGraphId;
          if (useContextGraph && collectedSigs.length < reqSigs) {
            this.log(`Turn ${proposal.turn}: only ${collectedSigs.length}/${reqSigs} signatures, falling back to plain publish`);
            useContextGraph = false;
          }

          const effectiveSwarm = useContextGraph ? swarm : { ...swarm, contextGraphId: undefined };
          let publishResult: DKGPublishReturn | undefined;
          try {
            publishResult = await this.enshrineToContextGraph(
              effectiveSwarm, turnQuads, `Turn ${proposal.turn}`,
              useContextGraph ? collectedSigs : undefined,
            );
          } catch (ctxErr: any) {
            if (useContextGraph) {
              this.log(`Context-graph enshrinement failed for turn ${proposal.turn}: ${ctxErr.message}. Falling back to plain publish.`);
              publishResult = await this.enshrineToContextGraph(
                { ...swarm, contextGraphId: undefined }, turnQuads,
                `Turn ${proposal.turn} (fallback)`,
              );
            } else {
              throw ctxErr;
            }
          }

          if (publishResult) {
            const turnEntity = rdf.turnUri(swarm.id, proposal.turn);
            await this.publishProvenanceChain(turnEntity, publishResult);
          }
        }
      } catch (err: any) {
        this.log(`Failed to publish turn ${proposal.turn}: ${err.message}`);
        await this.writeFailedLineage(opsSnapshot).catch(() => {});
      }

      if (swarm.status === 'finished') {
        await this.publishStrategyPatterns(swarm);
      }

      if (proposal.winningAction === 'syncMemory' && proposal.actionSuccess !== false) {
        this.publishSyncMemoryDkg(swarm, proposal.turn, GameEngine.SYNC_MEMORY_TRAC_COST).catch(() => {});
      }

      if (swarm.status === 'finished') {
        this.publishLeaderboardEntries(swarm).catch(() => {});
      }

      const resolvedMsg: proto.TurnResolvedMsg = {
        app: proto.APP_ID,
        type: 'turn:resolved',
        swarmId: swarm.id,
        peerId: this.myPeerId,
        timestamp: Date.now(),
        turn: proposal.turn,
        proposalHash: proposal.hash,
      };
      await this.broadcast(resolvedMsg);
    }
  }

  async forceResolveTurn(swarmId: string): Promise<SwarmState> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error('Swarm not found');
    if (swarm.status !== 'traveling') throw new Error('Swarm is not traveling');

    const isLeader = swarm.leaderPeerId === this.myPeerId;
    if (!isLeader) {
      if (!swarm.turnDeadline || Date.now() < swarm.turnDeadline) {
        throw new Error('Only leader can force resolve before deadline');
      }
    }

    if (swarm.votes.length === 0) {
      swarm.votes = [{ peerId: this.myPeerId, action: 'syncMemory', turn: swarm.currentTurn, timestamp: Date.now() }];
    }

    if (!swarm.gameState) throw new Error('No active game state');
    const { winningAction, params } = this.tallyVotes(swarm);
    const result = gameEngine.executeAction(swarm.gameState, { type: winningAction as any, params });

    const newStateJson = JSON.stringify(result.newState);
    const hash = hashProposal(swarm.id, swarm.currentTurn, newStateJson);
    const votes = swarm.votes.map(v => ({ peerId: v.peerId, action: v.action }));
    const event = result.event ? { type: result.event.type, description: result.event.description, affectedMember: result.event.affectedMember } : undefined;
    const deaths = detectDeaths(swarm.gameState, result.newState, event);
    const turnEvent = event ? { type: event.type, description: event.description } : undefined;

    const turnNumber = swarm.currentTurn;
    const opsSnapshot = [...(this.workspaceOps.get(swarm.id) ?? [])];
    this.workspaceOps.delete(swarm.id);

    swarm.pendingProposal = null;
    this.stopVoteHeartbeat(swarm.id);

    swarm.gameState = result.newState;

    swarm.turnHistory.push({
      turn: turnNumber,
      winningAction,
      resultMessage: result.message,
      approvers: [this.myPeerId],
      votes,
      resolution: 'force-resolved',
      deaths,
      event: turnEvent,
      timestamp: Date.now(),
    });

    if (result.newState.status !== 'active') {
      swarm.status = 'finished';
    } else {
      swarm.currentTurn++;
      swarm.votes = [];
      swarm.turnDeadline = Date.now() + 30_000;
    }

    const msg: proto.TurnProposalMsg = {
      app: proto.APP_ID,
      type: 'turn:proposal',
      swarmId: swarm.id,
      peerId: this.myPeerId,
      timestamp: Date.now(),
      turn: turnNumber,
      proposalHash: hash,
      winningAction,
      newStateJson,
      resultMessage: result.message,
      votes,
      resolution: 'force-resolved',
      deaths,
      event: turnEvent,
    };
    await this.broadcast(msg);

    // Force-resolve uses plain publish (not context graph enshrinement) because
    // multi-party consensus was not achieved — only the leader signed.
    try {
      const attestations: rdf.ConsensusAttestation[] = [{
        peerId: this.myPeerId,
        proposalHash: hash,
        approved: true,
        timestamp: Date.now(),
      }];
      const baseGraph = rdf.workspaceGraph(this.paranetId);
      const turnQuads = [
        ...rdf.turnResolvedQuads(
          this.paranetId, swarm.id, turnNumber,
          winningAction, newStateJson, [this.myPeerId],
        ),
        ...rdf.consensusAttestationQuads(
          this.paranetId, swarm.id, turnNumber, attestations, 'force-resolved', hash,
        ),
      ].map(q => ({ ...q, graph: baseGraph }));
      const publishResult = await this.agent.publish(this.paranetId, turnQuads);
      this.log(`Force-resolve turn ${turnNumber} published (plain, no context graph)`);

      const turnEntity = rdf.turnUri(swarm.id, turnNumber);
      await this.publishProvenanceChain(turnEntity, publishResult);
    } catch (err: any) {
      this.log(`Failed to publish force-resolved turn ${turnNumber}: ${err.message}`);
      await this.writeFailedLineage(opsSnapshot).catch(() => {});
    }

    if (swarm.status === 'finished') {
      await this.publishStrategyPatterns(swarm);
    }

    if (winningAction === 'syncMemory' && result.success) {
      this.publishSyncMemoryDkg(swarm, turnNumber, GameEngine.SYNC_MEMORY_TRAC_COST).catch(() => {});
    }

    if (swarm.status === 'finished') {
      this.publishLeaderboardEntries(swarm).catch(() => {});
    }

    const resolvedMsg: proto.TurnResolvedMsg = {
      app: proto.APP_ID,
      type: 'turn:resolved',
      swarmId: swarm.id,
      peerId: this.myPeerId,
      timestamp: Date.now(),
      turn: turnNumber,
      proposalHash: hash,
    };
    await this.broadcast(resolvedMsg);

    this.log(`Force-resolve: turn ${turnNumber} resolved immediately for ${swarm.id}`);
    return swarm;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private computeTurnQuads(
    swarmId: string, turn: number, winningAction: string,
    newStateJson: string, voters: string[],
    attestors: Array<{ peerId: string; timestamp: number }>,
    resolution: string, proposalHash: string,
  ): Array<{ subject: string; predicate: string; object: string; graph: string }> {
    const attestations: rdf.ConsensusAttestation[] = attestors.map(a => ({
      peerId: a.peerId,
      proposalHash,
      approved: true,
      timestamp: a.timestamp,
    }));
    return [
      ...rdf.turnResolvedQuads(
        this.paranetId, swarmId, turn,
        winningAction, newStateJson, voters,
      ),
      ...rdf.consensusAttestationQuads(
        this.paranetId, swarmId, turn, attestations, resolution, proposalHash,
      ),
    ];
  }

  // ── Vote tallying ─────────────────────────────────────────────────

  private tallyVotes(swarm: SwarmState): { winningAction: string; params?: Record<string, any>; tieBreaker: 'majority' | 'leader' } {
    const counts = new Map<string, { count: number; votes: Vote[] }>();
    for (const vote of swarm.votes) {
      const entry = counts.get(vote.action) || { count: 0, votes: [] };
      entry.count++;
      entry.votes.push(vote);
      counts.set(vote.action, entry);
    }

    let winningAction = 'syncMemory';
    let maxVotes = 0;
    const tiedActions: string[] = [];

    for (const [action, data] of counts) {
      if (data.count > maxVotes) {
        maxVotes = data.count;
        winningAction = action;
        tiedActions.length = 0;
        tiedActions.push(action);
      } else if (data.count === maxVotes) {
        tiedActions.push(action);
      }
    }

    let tieBreaker: 'majority' | 'leader' = 'majority';
    if (tiedActions.length > 1) {
      const leaderVote = swarm.votes.find(v => v.peerId === swarm.leaderPeerId);
      if (leaderVote && tiedActions.includes(leaderVote.action)) {
        winningAction = leaderVote.action;
        tieBreaker = 'leader';
      } else {
        winningAction = tiedActions.sort()[0];
      }
    }

    const winningVotes = counts.get(winningAction)?.votes || [];
    const leaderWin = winningVotes.find(v => v.peerId === swarm.leaderPeerId);
    const params = leaderWin?.params ?? winningVotes[0]?.params;

    return { winningAction, params, tieBreaker };
  }

  // ── GossipSub message handler ──────────────────────────────────────

  private msgQueue = Promise.resolve();

  private handleMessage = (_topic: string, data: Uint8Array, from: string): void => {
    if (from === this.myPeerId) return;
    const msg = proto.decode(data);
    if (!msg) return;

    // Reject messages where payload peerId doesn't match actual sender
    if (msg.peerId !== from) {
      this.log(`Rejected spoofed message: payload peerId=${msg.peerId} but from=${from}`);
      return;
    }

    this.msgQueue = this.msgQueue.then(async () => {
      try {
        switch (msg.type) {
          case 'swarm:created': this.onRemoteSwarmCreated(msg as proto.SwarmCreatedMsg); break;
          case 'swarm:joined': this.onRemotePlayerJoined(msg as proto.SwarmJoinedMsg); break;
          case 'swarm:left': this.onRemotePlayerLeft(msg as proto.SwarmLeftMsg); break;
          case 'expedition:launched': await this.onRemoteExpeditionLaunched(msg as proto.ExpeditionLaunchedMsg); break;
          case 'vote:cast': this.onRemoteVoteCast(msg as proto.VoteCastMsg); break;
          case 'turn:proposal': await this.onRemoteTurnProposal(msg as proto.TurnProposalMsg); break;
          case 'turn:approve': await this.onRemoteTurnApproval(msg as proto.TurnApproveMsg); break;
          case 'turn:resolved': this.onRemoteTurnResolved(msg as proto.TurnResolvedMsg); break;
        }
      } catch { /* ignore malformed */ }
    });
  };

  private onRemoteSwarmCreated(msg: proto.SwarmCreatedMsg): void {
    if (this.swarms.has(msg.swarmId)) return;
    const swarm: SwarmState = {
      id: msg.swarmId,
      name: msg.swarmName,
      leaderPeerId: msg.peerId,
      maxPlayers: msg.maxPlayers,
      players: [{
        peerId: msg.peerId,
        displayName: msg.playerName,
        joinedAt: msg.timestamp,
        isLeader: true,
        identityId: msg.identityId,
      }],
      status: 'recruiting',
      gameState: null,
      currentTurn: 0,
      votes: [],
      turnDeadline: null,
      pendingProposal: null,
      turnHistory: [],
      createdAt: msg.timestamp,
      playerIndexMap: new Map(),
    };
    this.swarms.set(msg.swarmId, swarm);
    this.pushNotification({
      type: 'swarm_created', swarmId: msg.swarmId, swarmName: msg.swarmName,
      playerName: msg.playerName, peerId: msg.peerId, timestamp: msg.timestamp,
      message: `${msg.playerName} created swarm "${msg.swarmName}"`,
    });
    this.log(`Remote swarm discovered: ${msg.swarmName} (${msg.swarmId})`);
  }

  private onRemotePlayerJoined(msg: proto.SwarmJoinedMsg): void {
    const swarm = this.swarms.get(msg.swarmId);
    if (!swarm) return;
    if (swarm.players.some(p => p.peerId === msg.peerId)) return;
    swarm.players.push({
      peerId: msg.peerId,
      displayName: msg.playerName,
      joinedAt: msg.timestamp,
      isLeader: false,
      identityId: msg.identityId,
    });
    this.pushNotification({
      type: 'player_joined', swarmId: msg.swarmId, swarmName: swarm.name,
      playerName: msg.playerName, peerId: msg.peerId, timestamp: msg.timestamp,
      message: `${msg.playerName} joined "${swarm.name}"`,
    });
    this.log(`Player ${msg.playerName} joined ${msg.swarmId}`);
  }

  private onRemotePlayerLeft(msg: proto.SwarmLeftMsg): void {
    const swarm = this.swarms.get(msg.swarmId);
    if (!swarm) return;
    const player = swarm.players.find(p => p.peerId === msg.peerId);
    const playerName = player?.displayName ?? msg.peerId.slice(0, 8);
    if (msg.peerId === swarm.leaderPeerId && swarm.status === 'recruiting') {
      this.pushNotification({
        type: 'player_left', swarmId: msg.swarmId, swarmName: swarm.name,
        playerName, peerId: msg.peerId, timestamp: msg.timestamp,
        message: `"${swarm.name}" was disbanded by ${playerName}`,
      });
      this.swarms.delete(msg.swarmId);
      this.workspaceOps.delete(msg.swarmId);
      return;
    }
    swarm.players = swarm.players.filter(p => p.peerId !== msg.peerId);
    this.pushNotification({
      type: 'player_left', swarmId: msg.swarmId, swarmName: swarm.name,
      playerName, peerId: msg.peerId, timestamp: msg.timestamp,
      message: `${playerName} left "${swarm.name}"`,
    });
  }

  private async onRemoteExpeditionLaunched(msg: proto.ExpeditionLaunchedMsg): Promise<void> {
    const swarm = this.swarms.get(msg.swarmId);
    if (!swarm) return;
    if (msg.peerId !== swarm.leaderPeerId) return;
    if (swarm.status !== 'recruiting') return;
    swarm.gameState = JSON.parse(msg.gameStateJson);
    if (msg.partyOrder && this.isValidPartyOrder(msg.partyOrder, swarm)) {
      swarm.playerIndexMap = new Map(msg.partyOrder.map((pid: string, i: number) => [pid, i]));
    } else {
      if (msg.partyOrder) this.log(`Invalid partyOrder for ${msg.swarmId}, falling back to local order`);
      swarm.playerIndexMap = new Map(swarm.players.map((p, i) => [p.peerId, i]));
    }
    swarm.status = 'traveling';
    swarm.currentTurn = 1;
    swarm.votes = [];
    swarm.turnDeadline = Date.now() + 30_000;
    if (msg.contextGraphId) swarm.contextGraphId = msg.contextGraphId;
    if (msg.requiredSignatures != null) swarm.requiredSignatures = msg.requiredSignatures;

    this.pushNotification({
      type: 'expedition_launched', swarmId: msg.swarmId, swarmName: swarm.name,
      peerId: msg.peerId, timestamp: msg.timestamp,
      message: `Expedition launched for "${swarm.name}"!`,
    });
    this.log(`Journey started for ${msg.swarmId} (remote)${swarm.contextGraphId ? ` [contextGraph=${swarm.contextGraphId}, M=${swarm.requiredSignatures}]` : ''}`);
  }

  private isValidPartyOrder(partyOrder: string[], swarm: SwarmState): boolean {
    const currentPeerIds = new Set(swarm.players.map(p => p.peerId));
    if (partyOrder.length !== currentPeerIds.size) return false;
    if (new Set(partyOrder).size !== partyOrder.length) return false;
    return partyOrder.every(pid => currentPeerIds.has(pid));
  }

  private onRemoteVoteCast(msg: proto.VoteCastMsg): void {
    const swarm = this.swarms.get(msg.swarmId);
    if (!swarm || swarm.currentTurn !== msg.turn) return;
    if (!swarm.players.some(p => p.peerId === msg.peerId)) return;
    if (!this.isPeerAlive(swarm, msg.peerId)) {
      this.log(`Rejected vote from dead peer ${msg.peerId.slice(0, 8)} on ${msg.swarmId}`);
      return;
    }
    swarm.votes = swarm.votes.filter(v => v.peerId !== msg.peerId);
    swarm.votes.push({
      peerId: msg.peerId,
      action: msg.action,
      params: msg.params,
      turn: msg.turn,
      timestamp: msg.timestamp,
    });
    const voterName = swarm.players.find(p => p.peerId === msg.peerId)?.displayName ?? msg.peerId.slice(0, 8);
    this.pushNotification({
      type: 'vote_cast', swarmId: msg.swarmId, swarmName: swarm.name,
      playerName: voterName, peerId: msg.peerId, timestamp: msg.timestamp,
      turn: msg.turn, action: msg.action,
      message: `${voterName} voted on turn ${msg.turn}`,
    });
    this.log(`Remote vote: ${msg.action} from ${msg.peerId.slice(0, 8)} on turn ${msg.turn}`);

    if (this.allAliveVoted(swarm) && swarm.leaderPeerId === this.myPeerId) {
      this.proposeTurnResolution(swarm).catch(err => this.log(`Propose error: ${err.message}`));
    }
  }

  private async onRemoteTurnProposal(msg: proto.TurnProposalMsg): Promise<void> {
    const swarm = this.swarms.get(msg.swarmId);
    if (!swarm || swarm.currentTurn !== msg.turn) return;

    // Only the leader may propose before the deadline; any member may propose after
    const pastDeadline = swarm.turnDeadline != null && Date.now() >= swarm.turnDeadline;
    if (msg.peerId !== swarm.leaderPeerId && !pastDeadline) {
      this.log(`Rejected proposal from non-leader ${msg.peerId.slice(0, 8)} for ${msg.swarmId} (deadline not passed)`);
      return;
    }
    if (!swarm.players.some(p => p.peerId === msg.peerId)) {
      this.log(`Rejected proposal from non-member ${msg.peerId.slice(0, 8)} for ${msg.swarmId}`);
      return;
    }

    const expectedHash = hashProposal(swarm.id, msg.turn, msg.newStateJson);
    if (expectedHash !== msg.proposalHash) {
      this.log(`Proposal hash mismatch for ${msg.swarmId} turn ${msg.turn} — rejecting`);
      return;
    }

    const resolution = msg.resolution ?? 'consensus';
    const votes = msg.votes ?? swarm.votes.map(v => ({ peerId: v.peerId, action: v.action }));
    const deaths = msg.deaths ?? [];

    // Leader force-resolved proposals bypass both tally validation and quorum.
    // Followers may have partial/lagging vote state, so comparing the local
    // tally against the leader's winning action would cause false rejections
    // and state divergence. Only the leader may use this fast path.
    if (resolution === 'force-resolved' && msg.peerId === swarm.leaderPeerId) {
      const newState: GameState = JSON.parse(msg.newStateJson);
      if (!newState.sessionId) {
        this.log(`Invalid game state in force-resolved proposal for ${msg.swarmId} turn ${msg.turn} — rejecting`);
        return;
      }
      swarm.pendingProposal = null;
      this.stopVoteHeartbeat(swarm.id);
      this.workspaceOps.delete(msg.swarmId);
      swarm.gameState = newState;

      swarm.turnHistory.push({
        turn: msg.turn,
        winningAction: msg.winningAction,
        resultMessage: msg.resultMessage,
        approvers: [msg.peerId],
        votes,
        resolution,
        deaths,
        event: msg.event,
        timestamp: Date.now(),
      });

      if (newState.status !== 'active') {
        swarm.status = 'finished';
      } else {
        swarm.currentTurn++;
        swarm.votes = [];
        swarm.turnDeadline = Date.now() + 30_000;
      }
      this.log(`Applied force-resolved turn ${msg.turn} for ${msg.swarmId}`);
      return;
    }

    // Verify the winning action matches our local vote tally.
    // We do NOT replay through the game engine because it contains
    // non-deterministic elements (Math.random for events, loot, etc.)
    // that would produce different state on each node.
    if (swarm.gameState && swarm.votes.length > 0) {
      const { winningAction } = this.tallyVotes(swarm);
      if (winningAction !== msg.winningAction) {
        this.log(`Proposal winning action mismatch: local=${winningAction} proposed=${msg.winningAction} — rejecting`);
        return;
      }
    }

    const newState: GameState = JSON.parse(msg.newStateJson);
    if (!newState.sessionId) {
      this.log(`Invalid game state in proposal for ${msg.swarmId} turn ${msg.turn} — rejecting`);
      return;
    }

    const receivedAt = Date.now();
    const peerSigs = new Map<string, ParticipantSignature>();

    // Recompute turn quads and merkle root locally to verify the
    // proposal's claimed root before signing. Must use the same inputs
    // as the leader (votes + proposal timestamp) for determinism.
    const voteAttestors = votes.map(v => ({ peerId: v.peerId, timestamp: msg.timestamp }));
    const localTurnQuads = this.computeTurnQuads(
      swarm.id, msg.turn, msg.winningAction, msg.newStateJson,
      votes.map(v => v.peerId), voteAttestors, resolution, msg.proposalHash,
    );
    let localMerkleRootHex: string | undefined;
    if (localTurnQuads.length > 0) {
      const hashes = localTurnQuads.map(q => hashTriple(q.subject, q.predicate, q.object));
      const localRoot = new MerkleTree(hashes).root;
      localMerkleRootHex = ethers.hexlify(localRoot);
    }

    let myIdentityIdStr: string | undefined;
    let mySignatureR: string | undefined;
    let mySignatureVS: string | undefined;
    const contextGraphIdValid = msg.contextGraphId && swarm.contextGraphId
      && String(msg.contextGraphId) === String(swarm.contextGraphId);
    const merkleRootVerified = msg.merkleRoot && localMerkleRootHex
      && msg.merkleRoot === localMerkleRootHex;
    if (merkleRootVerified && contextGraphIdValid && this.agent.identityId > 0n) {
      try {
        const merkleRootBytes = ethers.getBytes(msg.merkleRoot!);
        const sig = await this.agent.signContextGraphDigest(
          BigInt(msg.contextGraphId!), merkleRootBytes,
        );
        peerSigs.set(this.myPeerId, sig);
        myIdentityIdStr = String(sig.identityId);
        mySignatureR = ethers.hexlify(sig.r);
        mySignatureVS = ethers.hexlify(sig.vs);
      } catch { /* chain adapter may not support signing */ }
    } else if (msg.merkleRoot && !merkleRootVerified) {
      this.log(`Merkle root mismatch for proposal on turn ${msg.turn} — refusing to sign`);
    }

    swarm.pendingProposal = {
      turn: msg.turn,
      hash: msg.proposalHash,
      winningAction: msg.winningAction,
      newStateJson: msg.newStateJson,
      resultMessage: msg.resultMessage,
      approvals: new Set([msg.peerId, this.myPeerId]),
      approvalTimestamps: new Map([[msg.peerId, receivedAt], [this.myPeerId, receivedAt]]),
      votes,
      resolution,
      deaths,
      event: msg.event,
      turnQuads: localTurnQuads.length > 0 ? localTurnQuads : undefined,
      proposalTimestamp: msg.timestamp,
      participantSignatures: peerSigs,
    };

    const approveMsg: proto.TurnApproveMsg = {
      app: proto.APP_ID,
      type: 'turn:approve',
      swarmId: swarm.id,
      peerId: this.myPeerId,
      timestamp: Date.now(),
      turn: msg.turn,
      proposalHash: msg.proposalHash,
      identityId: myIdentityIdStr,
      signatureR: mySignatureR,
      signatureVS: mySignatureVS,
    };
    await this.broadcast(approveMsg);
    this.log(`Approved proposal for ${msg.swarmId} turn ${msg.turn}`);

    await this.checkProposalThreshold(swarm);
  }

  private async onRemoteTurnApproval(msg: proto.TurnApproveMsg): Promise<void> {
    const swarm = this.swarms.get(msg.swarmId);
    if (!swarm?.pendingProposal) return;
    if (swarm.pendingProposal.hash !== msg.proposalHash) return;
    if (!swarm.players.some(p => p.peerId === msg.peerId)) return;

    swarm.pendingProposal.approvals.add(msg.peerId);
    swarm.pendingProposal.approvalTimestamps.set(msg.peerId, Date.now());

    if (msg.identityId && msg.signatureR && msg.signatureVS) {
      const senderPlayer = swarm.players.find(p => p.peerId === msg.peerId);
      const expectedId = senderPlayer?.identityId;
      if (expectedId && String(msg.identityId) === String(expectedId)) {
        try {
          const rBytes = ethers.getBytes(msg.signatureR);
          const vsBytes = ethers.getBytes(msg.signatureVS);
          if (rBytes.length !== 32 || vsBytes.length !== 32) {
            this.log(`Rejected signature from ${msg.peerId.slice(0, 8)}: r(${rBytes.length}) or vs(${vsBytes.length}) not 32 bytes`);
          } else {
            swarm.pendingProposal.participantSignatures.set(msg.peerId, {
              identityId: BigInt(msg.identityId),
              r: rBytes,
              vs: vsBytes,
            });
          }
        } catch {
          this.log(`Malformed signature from ${msg.peerId.slice(0, 8)}, ignoring signature data`);
        }
      } else {
        this.log(`Rejected signature from ${msg.peerId.slice(0, 8)}: claimed identityId=${msg.identityId} does not match registered ${expectedId ?? 'none'}`);
      }
    }

    const threshold = swarm.requiredSignatures ?? signatureThreshold(swarm.players.length);
    this.log(`Approval from ${msg.peerId.slice(0, 8)} for turn ${msg.turn} (sigs=${swarm.pendingProposal.participantSignatures.size}/${threshold} needed)`);

    await this.checkProposalThreshold(swarm);
  }

  private onRemoteTurnResolved(msg: proto.TurnResolvedMsg): void {
    const swarm = this.swarms.get(msg.swarmId);
    if (!swarm) return;

    // If we have a matching pending proposal but haven't resolved yet, apply it
    if (swarm.pendingProposal && swarm.pendingProposal.hash === msg.proposalHash) {
      const proposal = swarm.pendingProposal;
      swarm.pendingProposal = null;
      this.stopVoteHeartbeat(swarm.id);
      this.workspaceOps.delete(msg.swarmId);

      const newState: GameState = JSON.parse(proposal.newStateJson);
      swarm.gameState = newState;
      swarm.turnHistory.push({
        turn: proposal.turn,
        winningAction: proposal.winningAction,
        resultMessage: proposal.resultMessage,
        approvers: [...proposal.approvals],
        votes: proposal.votes,
        resolution: proposal.resolution,
        deaths: proposal.deaths,
        event: proposal.event,
        timestamp: Date.now(),
      });

      if (newState.status !== 'active') {
        swarm.status = 'finished';
      } else {
        swarm.currentTurn++;
        swarm.votes = [];
        swarm.turnDeadline = Date.now() + 30_000;
      }
      this.pushNotification({
        type: 'turn_resolved', swarmId: swarm.id, swarmName: swarm.name,
        peerId: msg.peerId, timestamp: msg.timestamp, turn: proposal.turn,
        action: proposal.winningAction,
        message: `Turn ${proposal.turn} resolved — ${proposal.winningAction}`,
      });
      this.log(`Applied resolved turn ${proposal.turn} for ${swarm.id} (via turn:resolved)`);
    }
  }

  // ── Query helpers ─────────────────────────────────────────────────

  getLobby(): { openSwarms: SwarmState[]; mySwarms: SwarmState[] } {
    const openSwarms: SwarmState[] = [];
    const mySwarms: SwarmState[] = [];
    for (const swarm of this.swarms.values()) {
      if (swarm.players.some(p => p.peerId === this.myPeerId)) {
        mySwarms.push(swarm);
      } else if (swarm.status === 'recruiting' && swarm.players.length < swarm.maxPlayers) {
        openSwarms.push(swarm);
      }
    }
    openSwarms.sort((a, b) => b.createdAt - a.createdAt);
    mySwarms.sort((a, b) => b.createdAt - a.createdAt);
    return { openSwarms, mySwarms };
  }

  getSwarm(swarmId: string): SwarmState | null {
    return this.swarms.get(swarmId) ?? null;
  }

  findMySwarm(): SwarmState | null {
    for (const swarm of this.swarms.values()) {
      if (swarm.players.some(p => p.peerId === this.myPeerId) && swarm.status !== 'finished') return swarm;
    }
    return null;
  }

  formatSwarmState(swarm: SwarmState) {
    const allVoted = this.allAliveVoted(swarm);
    const voteStatus = swarm.status === 'traveling' ? {
      votes: swarm.players.map((p, i) => {
        const vote = swarm.votes.find(v => v.peerId === p.peerId);
        const isAlive = !swarm.gameState?.party[i] || swarm.gameState.party[i].alive;
        const canSee = allVoted || p.peerId === this.myPeerId;
        return { player: p.displayName, peerId: p.peerId, action: canSee ? (vote?.action ?? null) : null, hasVoted: !!vote, isAlive };
      }),
      timeRemaining: swarm.turnDeadline ? Math.max(0, swarm.turnDeadline - Date.now()) : 0,
      allVoted,
    } : null;

    return {
      id: swarm.id,
      name: swarm.name,
      leaderId: swarm.leaderPeerId,
      leaderName: swarm.players.find(p => p.isLeader)?.displayName,
      maxPlayers: swarm.maxPlayers,
      playerCount: swarm.players.length,
      minPlayers: MIN_PLAYERS,
      signatureThreshold: signatureThreshold(swarm.players.length),
      contextGraphId: swarm.contextGraphId ?? null,
      players: swarm.players.map(p => ({ id: p.peerId, name: p.displayName, isLeader: p.isLeader })),
      status: swarm.status,
      currentTurn: swarm.currentTurn,
      gameState: swarm.gameState,
      voteStatus,
      pendingProposal: swarm.pendingProposal ? {
        turn: swarm.pendingProposal.turn,
        hash: swarm.pendingProposal.hash.slice(0, 12),
        approvals: swarm.pendingProposal.approvals.size,
        threshold: signatureThreshold(swarm.players.length),
      } : null,
      score: swarm.gameState ? gameEngine.calculateScore(swarm.gameState) : 0,
      lastTurn: swarm.turnHistory[swarm.turnHistory.length - 1] ?? null,
      turnHistory: swarm.turnHistory.map(t => ({
        ...t,
        votes: (t.votes ?? []).map(v => {
          const player = swarm.players.find(p => p.peerId === v.peerId);
          return { ...v, displayName: player?.displayName ?? v.peerId.slice(-8) };
        }),
      })),
    };
  }

  // ── Workspace lineage ────────────────────────────────────────────

  private trackWorkspaceOp(swarmId: string, opId: string, quads: Array<{ subject: string }>): void {
    if (!this.workspaceOps.has(swarmId)) this.workspaceOps.set(swarmId, []);
    const rootEntities = [...new Set(quads.map(q => q.subject))];
    this.workspaceOps.get(swarmId)!.push({ workspaceOperationId: opId, rootEntities });
  }

  async recordWorkspaceLineage(paranetId: string, entries: Array<{ workspaceOperationId: string; rootEntity: string; status?: string; publishedUal?: string; publishedTxHash?: string; publishedAt?: number; confirmed?: boolean }>): Promise<void> {
    const quads = rdf.workspaceLineageQuads(paranetId, entries);
    if (quads.length > 0) {
      await this.agent.writeToWorkspace(paranetId, quads);
      this.log(`Recorded workspace lineage for ${entries.length} operation(s)`);
    }
  }

  async publishProvenanceChain(rootEntity: string, publishResult: any): Promise<void> {
    const ual = publishResult?.ual ?? (publishResult?.kcId != null ? String(publishResult.kcId) : '');
    const txHash = publishResult?.onChainResult?.txHash ?? '';
    if (!ual && !txHash) return;
    const provenance: rdf.PublishProvenance = {
      rootEntity,
      ual,
      txHash,
      blockNumber: publishResult?.onChainResult?.blockNumber || undefined,
      publisherPeerId: this.myPeerId,
      publishedAt: Date.now(),
    };
    try {
      await this.agent.writeToWorkspace(this.paranetId, rdf.publishProvenanceChainQuads(this.paranetId, provenance));
      this.log(`Provenance chain written to workspace for ${rootEntity}: tx=${provenance.txHash}`);
    } catch (err: any) {
      this.log(`Failed to publish provenance chain for ${rootEntity}: ${err.message}`);
    }
  }

  private async writeLineageFromSnapshot(snapshot: Array<{ workspaceOperationId: string; rootEntities: string[] }>, publishResult: any): Promise<void> {
    if (snapshot.length === 0) return;
    const now = Date.now();
    const entries = snapshot.flatMap(op => op.rootEntities.map(rootEntity => ({
      workspaceOperationId: op.workspaceOperationId,
      rootEntity,
      status: publishResult?.ual ? 'published' as const : 'workspace' as const,
      publishedUal: publishResult?.ual as string | undefined,
      publishedTxHash: publishResult?.onChainResult?.txHash as string | undefined,
      publishedAt: publishResult?.ual ? now : undefined,
      confirmed: !!publishResult?.onChainResult?.txHash,
    })));
    try {
      await this.recordWorkspaceLineage(this.paranetId, entries);
    } catch (err: any) {
      this.log(`Lineage write failed (dropped ${snapshot.length} ops): ${err.message}`);
    }
  }

  private async writeFailedLineage(snapshot: Array<{ workspaceOperationId: string; rootEntities: string[] }>): Promise<void> {
    if (snapshot.length === 0) return;
    const entries = snapshot.flatMap(op => op.rootEntities.map(rootEntity => ({
      workspaceOperationId: op.workspaceOperationId,
      rootEntity,
      status: 'failed' as const,
    })));
    await this.recordWorkspaceLineage(this.paranetId, entries);
    this.log(`Recorded ${entries.length} failed lineage entries`);
  }

  // ── Strategy pattern analysis ────────────────────────────────────

  computePlayerStrategies(swarm: SwarmState): Array<{ peerId: string; stats: { totalVotes: number; actionCounts: Record<string, number>; favoriteAction: string; turnsSurvived: number } }> {
    const playerStats = new Map<string, { totalVotes: number; actionCounts: Record<string, number> }>();

    for (const turn of swarm.turnHistory) {
      for (const vote of turn.votes) {
        let entry = playerStats.get(vote.peerId);
        if (!entry) {
          entry = { totalVotes: 0, actionCounts: {} };
          playerStats.set(vote.peerId, entry);
        }
        entry.totalVotes++;
        entry.actionCounts[vote.action] = (entry.actionCounts[vote.action] ?? 0) + 1;
      }
    }

    const allPeerIds = swarm.playerIndexMap.size > 0
      ? [...swarm.playerIndexMap.keys()]
      : [...new Set(swarm.turnHistory.flatMap(t => t.votes.map(v => v.peerId)))];

    const results: Array<{ peerId: string; stats: { totalVotes: number; actionCounts: Record<string, number>; favoriteAction: string; turnsSurvived: number } }> = [];
    for (const peerId of allPeerIds) {
      const entry = playerStats.get(peerId) ?? { totalVotes: 0, actionCounts: {} };
      const favoriteAction = Object.entries(entry.actionCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'none';
      const partyIndex = swarm.playerIndexMap.get(peerId);
      const partyMember = partyIndex != null ? swarm.gameState?.party[partyIndex] : undefined;
      const turnsSurvived = partyMember && !partyMember.alive
        ? this.findDeathTurn(swarm, partyIndex!, partyMember.name)
        : swarm.turnHistory.length;
      results.push({
        peerId,
        stats: { totalVotes: entry.totalVotes, actionCounts: entry.actionCounts, favoriteAction, turnsSurvived },
      });
    }
    return results;
  }

  private findDeathTurn(swarm: SwarmState, partyIndex: number, name?: string): number {
    for (const turn of swarm.turnHistory) {
      if (turn.deaths.some(d => d.partyIndex != null ? d.partyIndex === partyIndex : d.name === name)) return turn.turn;
    }
    return swarm.turnHistory.length;
  }

  getPlayerStrategies(swarmId: string): Array<{ peerId: string; stats: { totalVotes: number; actionCounts: Record<string, number>; favoriteAction: string; turnsSurvived: number } }> | null {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) return null;
    return this.computePlayerStrategies(swarm);
  }

  private async publishStrategyPatterns(swarm: SwarmState): Promise<void> {
    const strategies = this.computePlayerStrategies(swarm);
    const allQuads = strategies.flatMap(s =>
      rdf.strategyPatternQuads(this.paranetId, swarm.id, s.peerId, s.stats),
    );
    if (allQuads.length === 0) return;
    try {
      await this.agent.publish(this.paranetId, allQuads);
      this.log(`Published ${strategies.length} strategy patterns for ${swarm.id}`);
    } catch (err: any) {
      this.log(`Failed to publish strategy patterns for ${swarm.id}: ${err.message}`);
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────

  private async broadcast(msg: proto.OTMessage): Promise<void> {
    try {
      const publishPromise = this.agent.gossip.publish(this.topic, proto.encode(msg));
      const timeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('publish timeout')), 5_000),
      );
      await Promise.race([publishPromise, timeout]);
    } catch (err: any) {
      this.log(`Broadcast failed: ${err.message ?? 'no peers'}`);
    }
  }

  // ── Network topology snapshots ──────────────────────────────────

  private scheduleTopologySnapshots(): void {
    this.topologyTimer = setInterval(() => {
      this.publishNetworkTopology().catch(err =>
        this.log(`Topology snapshot failed: ${err.message}`),
      );
    }, 5 * 60_000);
    this.topologyTimer.unref?.();
  }

  async publishNetworkTopology(): Promise<void> {
    const now = Date.now();
    const peerMap = new Map<string, rdf.TopologyPeer>();

    for (const swarm of this.swarms.values()) {
      for (const member of swarm.players) {
        if (member.peerId === this.myPeerId) continue;

        const lastVote = swarm.votes
          .filter(v => v.peerId === member.peerId)
          .sort((a, b) => b.timestamp - a.timestamp)[0];

        const lastSeen = lastVote?.timestamp ?? member.joinedAt;
        const existing = peerMap.get(member.peerId);
        if (existing && existing.lastSeen >= lastSeen) continue;

        peerMap.set(member.peerId, {
          peerId: member.peerId,
          connectionType: 'relay',
          messageAgeMs: lastVote ? Math.max(0, now - lastVote.timestamp) : 0,
          lastSeen,
        });
      }
    }

    const peers = [...peerMap.values()];
    const quads = rdf.networkTopologyQuads(this.paranetId, this.myPeerId, peers);
    await this.agent.writeToWorkspace(this.paranetId, quads);
    this.log(`Topology snapshot written: ${peers.length} peers`);
  }

  // ── Leaderboard ───────────────────────────────────────────────────

  private async publishLeaderboardEntries(swarm: SwarmState): Promise<void> {
    if (!swarm.gameState || swarm.leaderPeerId !== this.myPeerId) return;
    const gs = swarm.gameState;
    const outcome = gs.status === 'won' ? 'won' as const : 'lost' as const;
    const score = gameEngine.calculateScore(gs);
    const survivors = gs.party.filter(m => m.alive).length;
    const now = Date.now();

    const allQuads: any[] = [];
    for (const player of swarm.players) {
      allQuads.push(...rdf.leaderboardEntryQuads(
        this.paranetId, swarm.id, player.peerId, player.displayName,
        score, outcome, gs.epochs, survivors, gs.party.length, now,
      ));
    }

    try {
      await this.agent.publish(this.paranetId, allQuads);
      this.log(`Leaderboard entries published for swarm ${swarm.id} (${outcome}, score=${score})`);
    } catch (err: any) {
      this.log(`Failed to publish leaderboard: ${err.message}`);
    }
  }

  async getLeaderboard(): Promise<Array<{
    player: string;
    displayName: string;
    score: number;
    outcome: string;
    epochs: number;
    survivors: number;
    partySize: number;
    swarmId: string;
    finishedAt: number;
  }>> {
    try {
      const result = await this.agent.query(
        `SELECT ?player ?displayName ?score ?outcome ?epochs ?survivors ?partySize ?swarmId ?finishedAt WHERE {
          ?entry a <${rdf.OT}LeaderboardEntry> .
          ?entry <${rdf.OT}player> ?player .
          ?entry <${rdf.OT}displayName> ?displayName .
          ?entry <${rdf.OT}score> ?score .
          ?entry <${rdf.OT}outcome> ?outcome .
          ?entry <${rdf.OT}epochs> ?epochs .
          ?entry <${rdf.OT}survivors> ?survivors .
          ?entry <${rdf.OT}partySize> ?partySize .
          ?entry <${rdf.OT}swarm> ?swarm .
          ?entry <${rdf.OT}finishedAt> ?finishedAt .
          BIND(REPLACE(STR(?swarm), "^.*/swarm/", "") AS ?swarmId)
        } ORDER BY DESC(?score) LIMIT 50`,
        { paranetId: this.paranetId, includeWorkspace: false },
      );
      const bindings = result?.result?.bindings ?? result?.bindings ?? [];
      return bindings.map((b: any) => ({
        player: stripQuotes(String(b.player ?? '')),
        displayName: stripQuotes(String(b.displayName ?? '')),
        score: Number(stripQuotes(String(b.score ?? '0'))),
        outcome: stripQuotes(String(b.outcome ?? '')),
        epochs: Number(stripQuotes(String(b.epochs ?? '0'))),
        survivors: Number(stripQuotes(String(b.survivors ?? '0'))),
        partySize: Number(stripQuotes(String(b.partySize ?? '0'))),
        swarmId: stripQuotes(String(b.swarmId ?? '')),
        finishedAt: Number(stripQuotes(String(b.finishedAt ?? '0'))),
      }));
    } catch (err: any) {
      this.log(`Leaderboard query failed: ${err.message}`);
      return [];
    }
  }

  // ── Sync Memory via DKG (on-chain publish) ──────────────────────

  async publishSyncMemoryDkg(swarm: SwarmState, turn: number, tracSpent: number): Promise<void> {
    if (swarm.leaderPeerId !== this.myPeerId) return;
    const quads = rdf.syncMemoryDkgQuads(this.paranetId, swarm.id, turn, this.myPeerId, tracSpent);
    try {
      await this.agent.publish(this.paranetId, quads);
      this.log(`Sync Memory via DKG published for swarm ${swarm.id}, turn ${turn} (${tracSpent} TRAC spent)`);
    } catch (err: any) {
      this.log(`Failed to publish sync memory DKG: ${err.message}`);
    }
  }

  destroy(): void {
    if (this.topologyTimer) {
      clearInterval(this.topologyTimer);
      this.topologyTimer = null;
    }
    for (const swarmId of this.voteHeartbeatTimers.keys()) {
      this.stopVoteHeartbeat(swarmId);
    }
    this.workspaceOps.clear();
    this.agent.gossip.offMessage(this.topic, this.handleMessage);
  }
}
