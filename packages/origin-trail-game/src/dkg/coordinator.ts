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
import { gameEngine } from '../engine/game-engine.js';
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
  gossip: {
    subscribe(topic: string): void;
    publish(topic: string, data: Uint8Array): Promise<void>;
    onMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void): void;
    offMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void): void;
  };
  writeToWorkspace(paranetId: string, quads: any[]): Promise<{ workspaceOperationId: string }>;
  publish(paranetId: string | { paranetId: string; quads: any[] }, quads?: any[]): Promise<DKGPublishReturn | undefined>;
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
}

export interface Vote {
  peerId: string;
  action: string;
  params?: Record<string, any>;
  turn: number;
  timestamp: number;
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
  deaths: Array<{ name: string; cause: string }>;
  event?: { type: string; description: string };
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
}

export interface ResolvedTurn {
  turn: number;
  winningAction: string;
  resultMessage: string;
  approvers: string[];
  votes: Array<{ peerId: string; action: string }>;
  resolution: 'consensus' | 'leader-tiebreak' | 'force-resolved';
  deaths: Array<{ name: string; cause: string }>;
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
): Array<{ name: string; cause: string }> {
  if (!oldState) return [];
  return newState.party
    .filter((m, i) => !m.alive && oldState.party[i]?.alive)
    .map(m => {
      if (event?.affectedMember === m.name) {
        return { name: m.name, cause: event.description };
      }
      if (newState.trainingTokens <= 0) {
        return { name: m.name, cause: 'Ran out of training tokens — starvation' };
      }
      if (event) {
        return { name: m.name, cause: event.description };
      }
      const oldMember = oldState.party.find(p => p.name === m.name);
      if (oldMember && oldMember.health > 0 && m.health <= 0) {
        return { name: m.name, cause: 'Health depleted from sustained damage' };
      }
      return { name: m.name, cause: 'Succumbed to accumulated damage' };
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

  constructor(agent: DKGAgent, config: CoordinatorConfig, log?: (msg: string) => void) {
    this.agent = agent;
    this.paranetId = config.paranetId;
    this.topic = proto.appTopic(config.paranetId);
    this.log = log ?? (() => {});
    this.subscribe();
    this.scheduleGraphSync();
    this.scheduleTopologySnapshots();
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
        this.log(`Player profile for "${displayName}" already exists, skipping publish`);
        return;
      }
    } catch {
      // If query fails, try publishing anyway
    }
    const quads = rdf.playerProfileQuads(this.paranetId, this.myPeerId, displayName);
    try {
      await this.agent.publish(this.paranetId, quads);
      this.log(`Published player profile for "${displayName}" to game paranet`);
    } catch (err: any) {
      this.log(`Failed to publish player profile: ${err.message}`);
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
        { paranetId: this.paranetId },
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
      }],
      status: 'recruiting',
      gameState: null,
      currentTurn: 0,
      votes: [],
      turnDeadline: null,
      pendingProposal: null,
      turnHistory: [],
      createdAt: now,
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
    swarm.players.push({
      peerId: this.myPeerId,
      displayName: playerName,
      joinedAt: now,
      isLeader: false,
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

    swarm.gameState = newGameState;
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
    };

    const msg: proto.TurnProposalMsg = {
      app: proto.APP_ID,
      type: 'turn:proposal',
      swarmId: swarm.id,
      peerId: this.myPeerId,
      timestamp: Date.now(),
      turn: swarm.currentTurn,
      proposalHash: hash,
      winningAction,
      newStateJson,
      resultMessage: result.message,
      votes,
      resolution,
      deaths,
      event: turnEvent,
    };
    await this.broadcast(msg);
    this.log(`Turn ${swarm.currentTurn} proposal broadcast for ${swarm.id} (hash=${hash.slice(0, 8)})`);

    await this.checkProposalThreshold(swarm);
  }

  private async checkProposalThreshold(swarm: SwarmState): Promise<void> {
    const proposal = swarm.pendingProposal;
    if (!proposal) return;

    const threshold = signatureThreshold(swarm.players.length);
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
        const attestations: rdf.ConsensusAttestation[] = [...proposal.approvals].map(pid => ({
          peerId: pid,
          proposalHash: proposal.hash,
          approved: true,
          timestamp: proposal.approvalTimestamps.get(pid) ?? Date.now(),
        }));
        const turnQuads = [
          ...rdf.turnResolvedQuads(
            this.paranetId, swarm.id, proposal.turn,
            proposal.winningAction, proposal.newStateJson,
            [...proposal.approvals],
          ),
          ...rdf.consensusAttestationQuads(
            this.paranetId, swarm.id, proposal.turn, attestations, proposal.resolution, proposal.hash,
          ),
        ];
        const publishResult = await this.agent.publish(this.paranetId, turnQuads);
        this.log(`Turn ${proposal.turn} published to context graph for ${swarm.id}`);
        this.log(`Consensus attestations published for turn ${proposal.turn}`);

        const onChain = publishResult?.onChainResult;
        if (onChain?.txHash && publishResult?.ual) {
          try {
            await this.agent.writeToWorkspace(this.paranetId, rdf.turnProvenanceQuads(
              this.paranetId, swarm.id, proposal.turn,
              { txHash: onChain.txHash, blockNumber: onChain.blockNumber, ual: publishResult.ual },
            ));
            this.log(`Turn ${proposal.turn} provenance written: tx=${onChain.txHash}`);
          } catch (err: any) {
            this.log(`Failed to write provenance for turn ${proposal.turn}: ${err.message}`);
          }
        }
        await this.writeLineageFromSnapshot(opsSnapshot, publishResult);
      } catch (err: any) {
        this.log(`Failed to publish turn ${proposal.turn}: ${err.message}`);
        await this.writeFailedLineage(opsSnapshot).catch(() => {});
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

    try {
      const attestations: rdf.ConsensusAttestation[] = [{
        peerId: this.myPeerId,
        proposalHash: hash,
        approved: true,
        timestamp: Date.now(),
      }];
      const turnQuads = [
        ...rdf.turnResolvedQuads(
          this.paranetId, swarm.id, turnNumber,
          winningAction, newStateJson, [this.myPeerId],
        ),
        ...rdf.consensusAttestationQuads(
          this.paranetId, swarm.id, turnNumber, attestations, 'force-resolved', hash,
        ),
      ];
      const publishResult = await this.agent.publish(this.paranetId, turnQuads);
      this.log(`Force-resolve: turn ${turnNumber} published for ${swarm.id}`);
      this.log(`Force-resolve: attestation published for turn ${turnNumber}`);

      const onChain = publishResult?.onChainResult;
      if (onChain?.txHash && publishResult?.ual) {
        const provenance: rdf.ChainProvenance = {
          txHash: onChain.txHash,
          blockNumber: onChain.blockNumber,
          ual: publishResult.ual,
        };
        try {
          await this.agent.writeToWorkspace(this.paranetId, rdf.turnProvenanceQuads(
            this.paranetId, swarm.id, turnNumber,
            provenance,
          ));
          this.log(`Force-resolve: turn ${turnNumber} provenance written: tx=${onChain.txHash}`);
        } catch (err: any) {
          this.log(`Failed to write provenance for force-resolved turn ${turnNumber}: ${err.message}`);
        }
      }
      await this.writeLineageFromSnapshot(opsSnapshot, publishResult);
    } catch (err: any) {
      this.log(`Failed to publish force-resolved turn ${turnNumber}: ${err.message}`);
      await this.writeFailedLineage(opsSnapshot).catch(() => {});
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
      }],
      status: 'recruiting',
      gameState: null,
      currentTurn: 0,
      votes: [],
      turnDeadline: null,
      pendingProposal: null,
      turnHistory: [],
      createdAt: msg.timestamp,
    };
    this.swarms.set(msg.swarmId, swarm);
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
    });
    this.log(`Player ${msg.playerName} joined ${msg.swarmId}`);
  }

  private onRemotePlayerLeft(msg: proto.SwarmLeftMsg): void {
    const swarm = this.swarms.get(msg.swarmId);
    if (!swarm) return;
    if (msg.peerId === swarm.leaderPeerId && swarm.status === 'recruiting') {
      this.swarms.delete(msg.swarmId);
      this.workspaceOps.delete(msg.swarmId);
      return;
    }
    swarm.players = swarm.players.filter(p => p.peerId !== msg.peerId);
  }

  private async onRemoteExpeditionLaunched(msg: proto.ExpeditionLaunchedMsg): Promise<void> {
    const swarm = this.swarms.get(msg.swarmId);
    if (!swarm) return;
    if (msg.peerId !== swarm.leaderPeerId) return;
    if (swarm.status !== 'recruiting') return;
    swarm.gameState = JSON.parse(msg.gameStateJson);
    swarm.status = 'traveling';
    swarm.currentTurn = 1;
    swarm.votes = [];
    swarm.turnDeadline = Date.now() + 30_000;

    // Leader persists launch state via workspace write; followers receive it
    // through workspace gossip replication (Rule 4: don't write to leader-owned root).

    this.log(`Journey started for ${msg.swarmId} (remote)`);
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

    swarm.pendingProposal = {
      turn: msg.turn,
      hash: msg.proposalHash,
      winningAction: msg.winningAction,
      newStateJson: msg.newStateJson,
      resultMessage: msg.resultMessage,
      approvals: new Set([msg.peerId, this.myPeerId]),
      approvalTimestamps: new Map([[msg.peerId, Date.now()], [this.myPeerId, Date.now()]]),
      votes,
      resolution,
      deaths,
      event: msg.event,
    };

    const approveMsg: proto.TurnApproveMsg = {
      app: proto.APP_ID,
      type: 'turn:approve',
      swarmId: swarm.id,
      peerId: this.myPeerId,
      timestamp: Date.now(),
      turn: msg.turn,
      proposalHash: msg.proposalHash,
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
    this.log(`Approval from ${msg.peerId.slice(0, 8)} for turn ${msg.turn} (${swarm.pendingProposal.approvals.size}/${signatureThreshold(swarm.players.length)} needed)`);

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
