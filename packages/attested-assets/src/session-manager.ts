import type { GossipSubManager } from '@dkg/core';
import type { EventBus } from '@dkg/core';
import type {
  SessionConfig,
  SessionMember,
  SessionState,
  RoundState,
  AKAEvent,
  QuorumPolicy,
  ReducerConfig,
  RoundProposalPayload,
  RoundAckPayload,
  InputPayload,
  ReducerModule,
} from './types.js';
import {
  computeSessionId,
  computeConfigHash,
  computeMembershipRoot,
  computeInputSetHash,
  computeStateHash,
  computeTurnCommitment,
  signAKAPayload,
  type SigningContext,
} from './canonical.js';
import { ReducerRegistry } from './reducer.js';
import { SessionValidator, detectEquivocation } from './session-validator.js';
import { isQuorumMet, getActiveMemberCount } from './quorum.js';
import {
  AKAGossipHandler,
  paranetSessionsTopic,
  sessionTopic,
} from './gossip-handler.js';
import {
  encodeAKAEvent,
  encodeSessionConfig,
  encodeRoundStartPayload,
  encodeInputPayload,
  encodeRoundProposalPayload,
  encodeRoundAckPayload,
  encodeRoundFinalizedPayload,
  encodeSessionAcceptedPayload,
  decodeRoundProposalPayload,
  decodeInputPayload,
  decodeRoundStartPayload,
  decodeRoundAckPayload,
  decodeSessionConfig,
} from './proto/aka-events.js';

const DEFAULT_PROPOSER_GRACE_MS = 5_000;
const DEFAULT_ACCEPT_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_SKIPS = 3;
const INPUT_COLLECTION_RATIO = 0.8;

export const AKASessionEvent = {
  SESSION_PROPOSED: 'aka:session:proposed',
  SESSION_ACTIVATED: 'aka:session:activated',
  SESSION_FINALIZED: 'aka:session:finalized',
  SESSION_ABORTED: 'aka:session:aborted',
  ROUND_STARTED: 'aka:round:started',
  ROUND_FINALIZED: 'aka:round:finalized',
  ROUND_TIMEOUT: 'aka:round:timeout',
  INPUT_RECEIVED: 'aka:input:received',
  ACK_RECEIVED: 'aka:ack:received',
  EQUIVOCATION_DETECTED: 'aka:equivocation',
} as const;

export interface SessionManagerConfig {
  localPeerId: string;
  secretKey: Uint8Array;
  network: string;
  proposerGraceMs?: number;
  acceptTimeoutMs?: number;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private readonly config: Required<SessionManagerConfig>;
  private readonly reducerRegistry: ReducerRegistry;
  private readonly validator: SessionValidator;
  private readonly gossipHandler: AKAGossipHandler;
  private readonly eventBus: EventBus;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly incomingEventHandler: (event: AKAEvent, from: string) => void;

  constructor(
    gossip: GossipSubManager,
    eventBus: EventBus,
    reducerRegistry: ReducerRegistry,
    config: SessionManagerConfig,
  ) {
    this.gossipHandler = new AKAGossipHandler(gossip);
    this.eventBus = eventBus;
    this.reducerRegistry = reducerRegistry;
    this.validator = new SessionValidator();
    this.config = {
      proposerGraceMs: DEFAULT_PROPOSER_GRACE_MS,
      acceptTimeoutMs: DEFAULT_ACCEPT_TIMEOUT_MS,
      ...config,
    };
    this.incomingEventHandler = (event, from) => this.handleIncomingEvent(event, from);
  }

  subscribeParanet(paranetId: string): void {
    const topic = paranetSessionsTopic(paranetId);
    this.gossipHandler.subscribeParanet(paranetId);
    this.gossipHandler.onEvent(topic, this.incomingEventHandler);
  }

  async createSession(
    paranetId: string,
    appId: string,
    membership: SessionMember[],
    quorumPolicy: QuorumPolicy,
    reducerConfig: ReducerConfig,
    roundTimeout: number,
    maxRounds: number | null,
  ): Promise<SessionConfig> {
    const reducer = this.reducerRegistry.resolve(reducerConfig);
    if (!reducer) {
      throw new Error(`reducer ${reducerConfig.name}@${reducerConfig.version} not found or hash mismatch`);
    }

    const createdAt = new Date().toISOString();
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = computeSessionId(paranetId, this.config.localPeerId, createdAt, nonce);
    const membershipRoot = computeMembershipRoot(membership);
    const genesisState = reducer.genesisState(membership);
    const genesisStateHash = computeStateHash(genesisState);

    const configWithoutHash: Omit<SessionConfig, 'configHash' | 'status'> = {
      sessionId,
      paranetId,
      appId,
      createdBy: this.config.localPeerId,
      createdAt,
      membership,
      membershipRoot,
      quorumPolicy,
      reducer: reducerConfig,
      genesisStateHash,
      roundTimeout,
      maxRounds,
    };

    const configHash = computeConfigHash(configWithoutHash);

    const sessionConfig: SessionConfig = {
      ...configWithoutHash,
      status: 'proposed',
      configHash,
    };

    const sessionState = this.initSessionState(sessionConfig, genesisState);
    this.sessions.set(sessionId, sessionState);

    this.gossipHandler.subscribeSession(paranetId, sessionId);
    this.gossipHandler.onEvent(sessionTopic(paranetId, sessionId), this.incomingEventHandler);

    const payload = encodeSessionConfig(sessionConfig);
    const event = await this.buildEvent('SessionProposed', sessionId, 0, genesisStateHash, payload);

    const topic = paranetSessionsTopic(paranetId);
    await this.gossipHandler.publishEvent(topic, event);

    this.eventBus.emit(AKASessionEvent.SESSION_PROPOSED, { sessionId, config: sessionConfig });

    this.setTimer(`accept-${sessionId}`, this.config.acceptTimeoutMs, () => {
      this.abortSession(sessionId, 'acceptance timeout');
    });

    return sessionConfig;
  }

  async acceptSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);

    const payload = encodeSessionAcceptedPayload({
      sessionId,
      configHash: session.config.configHash,
    });
    const event = await this.buildEvent(
      'SessionAccepted',
      sessionId,
      0,
      session.config.genesisStateHash,
      payload,
    );

    const topic = sessionTopic(session.config.paranetId, sessionId);
    await this.gossipHandler.publishEvent(topic, event);
  }

  async activateSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    if (session.config.createdBy !== this.config.localPeerId) {
      throw new Error('only the creator can activate a session');
    }

    session.config.status = 'active';
    this.clearTimer(`accept-${sessionId}`);

    const event = await this.buildEvent(
      'SessionActivated',
      sessionId,
      0,
      session.config.genesisStateHash,
      new Uint8Array(0),
    );

    const topic = sessionTopic(session.config.paranetId, sessionId);
    await this.gossipHandler.publishEvent(topic, event);

    this.eventBus.emit(AKASessionEvent.SESSION_ACTIVATED, { sessionId });
  }

  async startRound(sessionId: string, requestedRound?: number): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    if (session.config.status !== 'active') throw new Error('session not active');

    const round = session.currentRound;
    if (requestedRound !== undefined && requestedRound !== round) {
      throw new Error(`round mismatch: requested ${requestedRound} but current round is ${round}`);
    }
    const roundState = this.getOrCreateRoundState(session, round);

    if (roundState.proposerPeerId !== this.config.localPeerId) {
      throw new Error(`not the proposer for round ${round}`);
    }

    const deadline = Date.now() + session.config.roundTimeout;
    roundState.status = 'collecting_inputs';
    roundState.startTime = Date.now();
    roundState.deadline = deadline;

    const payload = encodeRoundStartPayload({
      round,
      prevStateHash: session.latestStateHash,
      deadline,
    });

    const event = await this.buildEvent(
      'RoundStart',
      sessionId,
      round,
      session.latestStateHash,
      payload,
    );

    const topic = sessionTopic(session.config.paranetId, sessionId);
    await this.gossipHandler.publishEvent(topic, event);

    this.eventBus.emit(AKASessionEvent.ROUND_STARTED, { sessionId, round });

    const inputWindow = Math.floor(session.config.roundTimeout * INPUT_COLLECTION_RATIO);
    this.setTimer(`input-${sessionId}-${round}`, inputWindow, () => {
      this.proposeRound(sessionId, round).catch(() => {});
    });

    this.setTimer(`timeout-${sessionId}-${round}`, session.config.roundTimeout, () => {
      this.handleRoundTimeout(sessionId, round);
    });
  }

  async submitInput(sessionId: string, data: Uint8Array, requestedRound?: number): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);

    const round = session.currentRound;
    if (requestedRound !== undefined && requestedRound !== round) {
      throw new Error(`round mismatch: requested ${requestedRound} but current round is ${round}`);
    }
    const roundState = session.roundStates.get(round);
    if (!roundState || roundState.status !== 'collecting_inputs') {
      throw new Error(`round ${round} is not collecting inputs`);
    }

    const payload = encodeInputPayload({ round, data });
    const event = await this.buildEvent(
      'InputSubmitted',
      sessionId,
      round,
      session.latestStateHash,
      payload,
    );

    const topic = sessionTopic(session.config.paranetId, sessionId);
    await this.gossipHandler.publishEvent(topic, event);
  }

  async handleIncomingEvent(event: AKAEvent, from: string): Promise<void> {
    const session = this.sessions.get(event.sessionId);

    if (event.type === 'SessionProposed' && !session) {
      this.handleSessionProposed(event);
      return;
    }

    if (!session) return;

    const validation = await this.validator.validate(event, session, this.config.network);
    if (!validation.valid) {
      return;
    }

    switch (event.type) {
      case 'SessionAccepted':
        this.handleSessionAccepted(event, session);
        break;
      case 'SessionActivated':
        this.handleSessionActivated(event, session);
        break;
      case 'RoundStart':
        this.handleRoundStart(event, session);
        break;
      case 'InputSubmitted':
        this.handleInputSubmitted(event, session);
        break;
      case 'RoundProposal':
        this.handleRoundProposal(event, session);
        break;
      case 'RoundAck':
        this.handleRoundAck(event, session);
        break;
      case 'RoundFinalized':
        this.handleRoundFinalized(event, session);
        break;
      case 'SessionFinalized':
        this.handleSessionFinalized(event, session);
        break;
      case 'SessionAborted':
        session.config.status = 'aborted';
        this.eventBus.emit(AKASessionEvent.SESSION_ABORTED, { sessionId: event.sessionId });
        break;
    }
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(paranetId?: string, status?: string): SessionConfig[] {
    const results: SessionConfig[] = [];
    for (const session of this.sessions.values()) {
      if (paranetId && session.config.paranetId !== paranetId) continue;
      if (status && session.config.status !== status) continue;
      results.push(session.config);
    }
    return results;
  }

  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.sessions.clear();
  }

  private handleSessionProposed(event: AKAEvent): void {
    try {
      const config = decodeSessionConfig(event.payload);

      const expectedHash = computeConfigHash(config);
      if (expectedHash !== config.configHash) return;

      if (config.sessionId !== event.sessionId) return;

      const signerIsMember = config.membership.some(m => m.peerId === event.signerPeerId);
      if (!signerIsMember) return;
      if (event.signerPeerId !== config.createdBy) return;

      const isMember = config.membership.some((m) => m.peerId === this.config.localPeerId);
      if (!isMember) return;

      if (!this.reducerRegistry.matches(config.reducer)) return;

      const reducer = this.reducerRegistry.resolve(config.reducer)!;
      const genesisState = reducer.genesisState(config.membership);
      const sessionState = this.initSessionState(config, genesisState);
      this.sessions.set(config.sessionId, sessionState);

      this.gossipHandler.subscribeSession(config.paranetId, config.sessionId);
      this.gossipHandler.onEvent(sessionTopic(config.paranetId, config.sessionId), this.incomingEventHandler);

      this.eventBus.emit(AKASessionEvent.SESSION_PROPOSED, {
        sessionId: config.sessionId,
        config,
      });
    } catch {
      // malformed proposal
    }
  }

  private handleSessionAccepted(event: AKAEvent, session: SessionState): void {
    // Track accepted members. If all accepted and we're creator, we can activate.
    // For now, just emit event.
    this.eventBus.emit('aka:session:member_accepted', {
      sessionId: event.sessionId,
      peerId: event.signerPeerId,
    });
  }

  private handleSessionActivated(event: AKAEvent, session: SessionState): void {
    session.config.status = 'active';
    this.clearTimer(`accept-${event.sessionId}`);
    this.eventBus.emit(AKASessionEvent.SESSION_ACTIVATED, { sessionId: event.sessionId });

    const roundState = this.getOrCreateRoundState(session, 1);
    session.currentRound = 1;

    if (roundState.proposerPeerId === this.config.localPeerId) {
      this.setTimer(`proposer-grace-${event.sessionId}-1`, this.config.proposerGraceMs, () => {
        this.startRound(event.sessionId).catch(() => {});
      });
    }
  }

  private handleRoundStart(event: AKAEvent, session: SessionState): void {
    const roundState = this.getOrCreateRoundState(session, event.round);
    roundState.status = 'collecting_inputs';
    roundState.startTime = event.timestamp;

    const payload = decodeRoundStartPayload(event.payload);
    roundState.deadline = payload.deadline || (event.timestamp + session.config.roundTimeout);

    this.eventBus.emit(AKASessionEvent.ROUND_STARTED, {
      sessionId: event.sessionId,
      round: event.round,
    });
  }

  private handleInputSubmitted(event: AKAEvent, session: SessionState): void {
    const roundState = session.roundStates.get(event.round);
    if (!roundState) return;
    if (roundState.status !== 'collecting_inputs') return;

    if (roundState.inputs.has(event.signerPeerId)) return;

    const inputPayload = decodeInputPayload(event.payload);
    roundState.inputs.set(event.signerPeerId, inputPayload);

    this.eventBus.emit(AKASessionEvent.INPUT_RECEIVED, {
      sessionId: event.sessionId,
      round: event.round,
      from: event.signerPeerId,
    });
  }

  private handleRoundProposal(event: AKAEvent, session: SessionState): void {
    const roundState = session.roundStates.get(event.round);
    if (!roundState) return;

    if (event.signerPeerId !== roundState.proposerPeerId) return;

    const proposal = decodeRoundProposalPayload(event.payload);
    roundState.proposal = proposal;
    roundState.status = 'awaiting_acks';

    this.validateAndAck(session, event.round, proposal).catch(() => {});
  }

  private handleRoundAck(event: AKAEvent, session: SessionState): void {
    const roundState = session.roundStates.get(event.round);
    if (!roundState) return;

    const ackPayload = decodeRoundAckPayload(event.payload);
    const existing = roundState.acks.get(event.signerPeerId);

    if (existing && detectEquivocation(existing, ackPayload)) {
      session.equivocators.add(event.signerPeerId);
      roundState.acks.delete(event.signerPeerId);
      this.eventBus.emit(AKASessionEvent.EQUIVOCATION_DETECTED, {
        sessionId: event.sessionId,
        round: event.round,
        peerId: event.signerPeerId,
      });
      return;
    }

    roundState.acks.set(event.signerPeerId, ackPayload);

    this.eventBus.emit(AKASessionEvent.ACK_RECEIVED, {
      sessionId: event.sessionId,
      round: event.round,
      from: event.signerPeerId,
      ackCount: roundState.acks.size,
    });

    this.checkQuorumAndFinalize(session, event.round).catch(() => {});
  }

  private handleRoundFinalized(event: AKAEvent, session: SessionState): void {
    const roundState = session.roundStates.get(event.round);
    if (!roundState?.proposal) return;

    roundState.status = 'finalized';
    session.latestFinalizedRound = event.round;
    session.latestStateHash = roundState.proposal.nextStateHash;
    session.consecutiveSkips = 0;

    this.clearTimer(`timeout-${event.sessionId}-${event.round}`);
    this.clearTimer(`input-${event.sessionId}-${event.round}`);

    this.eventBus.emit(AKASessionEvent.ROUND_FINALIZED, {
      sessionId: event.sessionId,
      round: event.round,
      stateHash: roundState.proposal.nextStateHash,
    });

    if (session.config.maxRounds && event.round >= session.config.maxRounds) {
      return;
    }

    const nextRound = event.round + 1;
    session.currentRound = nextRound;
    const nextRoundState = this.getOrCreateRoundState(session, nextRound);

    if (nextRoundState.proposerPeerId === this.config.localPeerId) {
      setTimeout(() => {
        this.startRound(event.sessionId).catch(() => {});
      }, 100);
    }
  }

  private handleSessionFinalized(event: AKAEvent, session: SessionState): void {
    session.config.status = 'finalized';
    this.gossipHandler.unsubscribeSession(session.config.paranetId, event.sessionId);
    this.eventBus.emit(AKASessionEvent.SESSION_FINALIZED, { sessionId: event.sessionId });
  }

  private async proposeRound(sessionId: string, round: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const roundState = session.roundStates.get(round);
    if (!roundState || roundState.proposerPeerId !== this.config.localPeerId) return;
    if (roundState.proposal) return;

    const reducer = this.reducerRegistry.resolve(session.config.reducer);
    if (!reducer) return;

    const sortedMembers = [...roundState.inputs.keys()].sort();
    const sortedInputs = sortedMembers.map((m) => roundState.inputs.get(m)!.data);

    const inputSetHash = computeInputSetHash(sortedInputs);
    const prevStateBytes = this.getStateBytes(session);
    const nextStateBytes = reducer.reduce(prevStateBytes, sortedInputs);
    const nextStateHash = computeStateHash(nextStateBytes);

    const proposal: RoundProposalPayload = {
      round,
      prevStateHash: session.latestStateHash,
      inputSetHash,
      nextStateHash,
      includedMembers: sortedMembers,
      includedInputs: sortedInputs,
    };

    roundState.proposal = proposal;
    roundState.status = 'awaiting_acks';

    const payload = encodeRoundProposalPayload(proposal);
    const event = await this.buildEvent(
      'RoundProposal',
      sessionId,
      round,
      session.latestStateHash,
      payload,
    );

    const topic = sessionTopic(session.config.paranetId, sessionId);
    await this.gossipHandler.publishEvent(topic, event);

    await this.validateAndAck(session, round, proposal);
  }

  private async validateAndAck(
    session: SessionState,
    round: number,
    proposal: RoundProposalPayload,
  ): Promise<void> {
    const reducer = this.reducerRegistry.resolve(session.config.reducer);
    if (!reducer) return;

    const prevStateBytes = this.getStateBytes(session);
    const localNextState = reducer.reduce(prevStateBytes, proposal.includedInputs);
    const localNextHash = computeStateHash(localNextState);

    if (localNextHash !== proposal.nextStateHash) {
      return;
    }

    const turnCommitment = computeTurnCommitment(
      session.config.sessionId,
      round,
      proposal.prevStateHash,
      proposal.inputSetHash,
      proposal.nextStateHash,
      session.config.reducer.version,
      session.config.membershipRoot,
    );

    const ackPayload: RoundAckPayload = {
      round,
      prevStateHash: proposal.prevStateHash,
      inputSetHash: proposal.inputSetHash,
      nextStateHash: proposal.nextStateHash,
      turnCommitment,
    };

    const payload = encodeRoundAckPayload(ackPayload);
    const event = await this.buildEvent(
      'RoundAck',
      session.config.sessionId,
      round,
      proposal.prevStateHash,
      payload,
    );

    const topic = sessionTopic(session.config.paranetId, session.config.sessionId);
    await this.gossipHandler.publishEvent(topic, event);
  }

  private async checkQuorumAndFinalize(session: SessionState, round: number): Promise<void> {
    const roundState = session.roundStates.get(round);
    if (!roundState?.proposal) return;
    if (roundState.status === 'finalized') return;

    const activeMemberCount = getActiveMemberCount(
      session.config.membership.length,
      session.equivocators.size,
      session.inactiveMembers.size,
    );

    if (!isQuorumMet(session.config.quorumPolicy, activeMemberCount, roundState.acks.size)) {
      return;
    }

    roundState.status = 'finalized';
    session.latestFinalizedRound = round;
    session.latestStateHash = roundState.proposal.nextStateHash;
    session.consecutiveSkips = 0;

    const signerPeerIds = [...roundState.acks.keys()];
    const signatures: Uint8Array[] = [];

    const payload = encodeRoundFinalizedPayload({
      round,
      nextStateHash: roundState.proposal.nextStateHash,
      signerPeerIds,
      signatures,
    });

    const event = await this.buildEvent(
      'RoundFinalized',
      session.config.sessionId,
      round,
      roundState.proposal.prevStateHash,
      payload,
    );

    const topic = sessionTopic(session.config.paranetId, session.config.sessionId);
    await this.gossipHandler.publishEvent(topic, event);

    this.clearTimer(`timeout-${session.config.sessionId}-${round}`);
    this.clearTimer(`input-${session.config.sessionId}-${round}`);

    this.eventBus.emit(AKASessionEvent.ROUND_FINALIZED, {
      sessionId: session.config.sessionId,
      round,
      stateHash: roundState.proposal.nextStateHash,
    });

    if (session.config.maxRounds && round >= session.config.maxRounds) {
      return;
    }

    const nextRound = round + 1;
    session.currentRound = nextRound;
    const nextRoundState = this.getOrCreateRoundState(session, nextRound);

    if (nextRoundState.proposerPeerId === this.config.localPeerId) {
      setTimeout(() => {
        this.startRound(session.config.sessionId).catch(() => {});
      }, 100);
    }
  }

  private handleRoundTimeout(sessionId: string, round: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const roundState = session.roundStates.get(round);
    if (!roundState || roundState.status === 'finalized') return;

    roundState.status = 'timed_out';
    roundState.viewChangeCount++;

    const N = session.config.membership.length;
    const newProposerIndex = (round % N + roundState.viewChangeCount) % N;
    roundState.proposerPeerId = session.config.membership[newProposerIndex].peerId;

    if (roundState.viewChangeCount >= N) {
      session.consecutiveSkips++;
      if (session.consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        this.abortSession(sessionId, 'too many consecutive skips');
        return;
      }

      session.currentRound = round + 1;
      this.getOrCreateRoundState(session, round + 1);
      return;
    }

    roundState.status = 'awaiting_start';

    if (roundState.proposerPeerId === this.config.localPeerId) {
      this.startRound(sessionId).catch(() => {});
    }

    this.eventBus.emit(AKASessionEvent.ROUND_TIMEOUT, {
      sessionId,
      round,
      viewChangeCount: roundState.viewChangeCount,
      newProposer: roundState.proposerPeerId,
    });
  }

  private async abortSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.config.status = 'aborted';

    const event = await this.buildEvent(
      'SessionAborted',
      sessionId,
      session.currentRound,
      session.latestStateHash,
      new TextEncoder().encode(reason),
    );

    const topic = sessionTopic(session.config.paranetId, sessionId);
    await this.gossipHandler.publishEvent(topic, event);

    this.gossipHandler.unsubscribeSession(session.config.paranetId, sessionId);
    this.eventBus.emit(AKASessionEvent.SESSION_ABORTED, { sessionId, reason });
  }

  private initSessionState(config: SessionConfig, genesisState: Uint8Array): SessionState {
    return {
      config,
      currentRound: 0,
      latestFinalizedRound: 0,
      latestStateHash: config.genesisStateHash,
      roundStates: new Map(),
      equivocators: new Set(),
      inactiveMembers: new Map(),
      consecutiveSkips: 0,
    };
  }

  private getOrCreateRoundState(session: SessionState, round: number): RoundState {
    let roundState = session.roundStates.get(round);
    if (!roundState) {
      const N = session.config.membership.length;
      const proposerIndex = round % N;

      roundState = {
        round,
        status: 'awaiting_start',
        proposerPeerId: session.config.membership[proposerIndex].peerId,
        viewChangeCount: 0,
        inputs: new Map(),
        proposal: null,
        acks: new Map(),
        startTime: null,
        deadline: null,
      };
      session.roundStates.set(round, roundState);
    }
    return roundState;
  }

  private async buildEvent(
    type: AKAEvent['type'],
    sessionId: string,
    round: number,
    prevStateHash: string,
    payload: Uint8Array,
  ): Promise<AKAEvent> {
    const session = this.sessions.get(sessionId)!;
    const nonce = `${this.config.localPeerId}-${sessionId.slice(0, 8)}-${type}-${round}-${Date.now()}`;

    const context: SigningContext = {
      domain: 'AKA-v1',
      network: this.config.network,
      paranetId: session.config.paranetId,
      sessionId,
      round,
      type,
    };

    const signature = await signAKAPayload(context, Array.from(payload), this.config.secretKey);

    return {
      mode: 'AKA',
      type,
      sessionId,
      round,
      prevStateHash,
      signerPeerId: this.config.localPeerId,
      signature,
      timestamp: Date.now(),
      nonce,
      payload,
    };
  }

  private getStateBytes(session: SessionState): Uint8Array {
    // In a full implementation, this would retrieve the actual state bytes
    // from a state store. For now, the reducer maintains state externally.
    // The session only tracks the hash.
    return new TextEncoder().encode(session.latestStateHash);
  }

  private setTimer(key: string, ms: number, fn: () => void): void {
    this.clearTimer(key);
    this.timers.set(key, setTimeout(fn, ms));
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}
