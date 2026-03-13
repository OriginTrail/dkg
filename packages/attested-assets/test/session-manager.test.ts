import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionManager, AKASessionEvent } from '../src/session-manager.js';
import { ReducerRegistry } from '../src/reducer.js';
import {
  signAKAPayload,
  computeInputSetHash,
  computeStateHash,
  computeTurnCommitment,
  computeMembershipRoot,
  computeConfigHash,
} from '../src/canonical.js';
import {
  encodeSessionConfig,
  encodeRoundAckPayload,
  encodeRoundFinalizedPayload,
  encodeRoundProposalPayload,
  encodeInputPayload,
} from '../src/proto/aka-events.js';
import { TypedEventBus, generateEd25519Keypair, type Ed25519Keypair } from '@origintrail-official/dkg-core';
import type {
  ReducerModule,
  QuorumPolicy,
  SessionMember,
  AKAEvent,
  RoundAckPayload,
  RoundProposalPayload,
} from '../src/types.js';

const mockGossip = {
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  publish: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  offMessage: vi.fn(),
  get subscribedTopics() { return []; },
};

function makeTestReducer(): ReducerModule {
  const genesisBytes = new Uint8Array([0, 0, 0, 0]);
  return {
    name: 'test-reducer',
    version: '1.0.0',
    hash: 'test-hash-123',
    reduce: (prev: Uint8Array, inputs: Uint8Array[]) => {
      const state = new Uint8Array(prev.length);
      state.set(prev);
      for (const input of inputs) {
        for (let i = 0; i < Math.min(input.length, state.length); i++) {
          state[i] = (state[i] + input[i]) % 256;
        }
      }
      return state;
    },
    genesisState: () => new Uint8Array(genesisBytes),
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let eventBus: TypedEventBus;
  let reducerRegistry: ReducerRegistry;
  let kp1: Ed25519Keypair;
  let kp2: Ed25519Keypair;

  let membership: SessionMember[];

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    kp1 = await generateEd25519Keypair();
    kp2 = await generateEd25519Keypair();
    membership = [
      { peerId: 'peer-1', pubKey: kp1.publicKey, displayName: 'Alice', role: 'creator' },
      { peerId: 'peer-2', pubKey: kp2.publicKey, displayName: 'Bob', role: 'member' },
    ];
    eventBus = new TypedEventBus();
    reducerRegistry = new ReducerRegistry();
    reducerRegistry.register(makeTestReducer());

    mockGossip.subscribe.mockClear();
    mockGossip.unsubscribe.mockClear();
    mockGossip.publish.mockClear();
    mockGossip.onMessage.mockClear();
    mockGossip.offMessage.mockClear();

    manager = new SessionManager(
      mockGossip as any,
      eventBus,
      reducerRegistry,
      {
        localPeerId: 'peer-1',
        secretKey: kp1.secretKey,
        network: 'test-net',
        proposerGraceMs: 500,
        acceptTimeoutMs: 5000,
      },
    );
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  const quorumPolicy: QuorumPolicy = { type: 'THRESHOLD', numerator: 2, denominator: 3, minSigners: 2 };
  const reducerConfig = { name: 'test-reducer', version: '1.0.0', hash: 'test-hash-123' };

  function acceptAllMembers(sessionId: string) {
    const session = manager.getSession(sessionId)!;
    for (const m of session.config.membership) {
      if (m.peerId !== session.config.createdBy) {
        session.acceptedMembers.add(m.peerId);
      }
    }
  }

  it('creates a session with correct config', async () => {
    const config = await manager.createSession(
      'paranet-1', 'test-app', membership, quorumPolicy, reducerConfig, 30000, null,
    );

    expect(config.sessionId).toHaveLength(64);
    expect(config.paranetId).toBe('paranet-1');
    expect(config.appId).toBe('test-app');
    expect(config.status).toBe('proposed');
    expect(config.membership).toHaveLength(2);
    expect(config.genesisStateHash).toBeTruthy();
    expect(config.configHash).toHaveLength(64);
  });

  it('emits SESSION_PROPOSED event on creation', async () => {
    const handler = vi.fn();
    eventBus.on(AKASessionEvent.SESSION_PROPOSED, handler);

    const config = await manager.createSession(
      'paranet-1', 'test-app', membership, quorumPolicy, reducerConfig, 30000, null,
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: config.sessionId }),
    );
  });

  it('publishes SessionProposed event via gossip', async () => {
    await manager.createSession(
      'paranet-1', 'test-app', membership, quorumPolicy, reducerConfig, 30000, null,
    );

    expect(mockGossip.publish).toHaveBeenCalled();
    const [topic] = mockGossip.publish.mock.calls[0];
    expect(topic).toContain('paranet-1');
    expect(topic).toContain('sessions');
  });

  it('subscribes to session gossip topic on creation', async () => {
    await manager.createSession(
      'paranet-1', 'test-app', membership, quorumPolicy, reducerConfig, 30000, null,
    );

    expect(mockGossip.subscribe).toHaveBeenCalled();
  });

  it('getSession retrieves a created session', async () => {
    const config = await manager.createSession(
      'paranet-1', 'test-app', membership, quorumPolicy, reducerConfig, 30000, null,
    );

    const session = manager.getSession(config.sessionId);
    expect(session).toBeDefined();
    expect(session!.config.sessionId).toBe(config.sessionId);
    expect(session!.latestStateHash).toBe(config.genesisStateHash);
    expect(session!.currentRound).toBe(0);
  });

  it('listSessions filters by paranetId', async () => {
    await manager.createSession('paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null);
    await manager.createSession('paranet-2', 'app', membership, quorumPolicy, reducerConfig, 30000, null);

    const list = manager.listSessions('paranet-1');
    expect(list).toHaveLength(1);
    expect(list[0].paranetId).toBe('paranet-1');
  });

  it('listSessions filters by status', async () => {
    await manager.createSession('paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null);

    expect(manager.listSessions(undefined, 'proposed')).toHaveLength(1);
    expect(manager.listSessions(undefined, 'active')).toHaveLength(0);
  });

  it('rejects session creation with unknown reducer', async () => {
    const badReducer = { name: 'unknown', version: '1.0.0', hash: 'xxx' };
    await expect(
      manager.createSession('p', 'a', membership, quorumPolicy, badReducer, 30000, null),
    ).rejects.toThrow('not found');
  });

  it('activateSession transitions status to active', async () => {
    const config = await manager.createSession(
      'paranet-1', 'test-app', membership, quorumPolicy, reducerConfig, 30000, null,
    );

    const handler = vi.fn();
    eventBus.on(AKASessionEvent.SESSION_ACTIVATED, handler);

    acceptAllMembers(config.sessionId);
    await manager.activateSession(config.sessionId);

    const session = manager.getSession(config.sessionId);
    expect(session!.config.status).toBe('active');
    expect(handler).toHaveBeenCalledWith({ sessionId: config.sessionId });
  });

  it('activateSession rejects when members have not accepted', async () => {
    const config = await manager.createSession(
      'paranet-1', 'test-app', membership, quorumPolicy, reducerConfig, 30000, null,
    );

    await expect(manager.activateSession(config.sessionId)).rejects.toThrow('members have not yet accepted');
  });

  it('activateSession rejects if not creator', async () => {
    const otherManager = new SessionManager(
      mockGossip as any,
      new TypedEventBus(),
      reducerRegistry,
      { localPeerId: 'peer-999', secretKey: kp2.secretKey, network: 'test' },
    );

    const config = await manager.createSession(
      'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
    );

    await expect(otherManager.activateSession(config.sessionId)).rejects.toThrow('not found');
    otherManager.destroy();
  });

  it('startRound publishes RoundStart and transitions to collecting_inputs', async () => {
    const config = await manager.createSession(
      'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
    );
    acceptAllMembers(config.sessionId);
    await manager.activateSession(config.sessionId);

    const session = manager.getSession(config.sessionId)!;
    // round 2: proposerIndex = 2 % 2 = 0 → membership[0] = peer-1
    session.currentRound = 2;

    const roundHandler = vi.fn();
    eventBus.on(AKASessionEvent.ROUND_STARTED, roundHandler);

    const publishCountBefore = mockGossip.publish.mock.calls.length;
    await manager.startRound(config.sessionId);

    expect(mockGossip.publish.mock.calls.length).toBeGreaterThan(publishCountBefore);
    expect(roundHandler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: config.sessionId, round: 2 }),
    );

    const roundState = session.roundStates.get(2);
    expect(roundState).toBeDefined();
    expect(roundState!.status).toBe('collecting_inputs');
  });

  it('startRound rejects if not the proposer', async () => {
    const config = await manager.createSession(
      'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
    );
    acceptAllMembers(config.sessionId);
    await manager.activateSession(config.sessionId);

    const session = manager.getSession(config.sessionId)!;
    // round 1: proposerIndex = 1 % 2 = 1 → membership[1] = peer-2 (not our localPeerId)
    session.currentRound = 1;

    await expect(manager.startRound(config.sessionId)).rejects.toThrow('not the proposer');
  });

  it('submitInput publishes InputSubmitted via gossip', async () => {
    const config = await manager.createSession(
      'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
    );
    acceptAllMembers(config.sessionId);
    await manager.activateSession(config.sessionId);

    const session = manager.getSession(config.sessionId)!;
    // round 2: proposerIndex = 2 % 2 = 0 → membership[0] = peer-1
    session.currentRound = 2;
    await manager.startRound(config.sessionId);

    const publishCountBefore = mockGossip.publish.mock.calls.length;
    await manager.submitInput(config.sessionId, new Uint8Array([1, 2, 3]));

    expect(mockGossip.publish.mock.calls.length).toBeGreaterThan(publishCountBefore);
  });

  it('submitInput rejects when round is not collecting inputs', async () => {
    const config = await manager.createSession(
      'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
    );
    acceptAllMembers(config.sessionId);
    await manager.activateSession(config.sessionId);

    await expect(
      manager.submitInput(config.sessionId, new Uint8Array([1])),
    ).rejects.toThrow('not collecting inputs');
  });

  it('destroy clears all sessions and timers', async () => {
    await manager.createSession('p', 'a', membership, quorumPolicy, reducerConfig, 30000, null);
    manager.destroy();

    expect(manager.listSessions()).toHaveLength(0);
  });

  it('genesisStateHash is computed from reducer genesis state', async () => {
    const reducer = makeTestReducer();
    const expectedGenesis = reducer.genesisState(membership);
    const expectedHash = computeStateHash(expectedGenesis);

    const config = await manager.createSession(
      'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
    );

    expect(config.genesisStateHash).toBe(expectedHash);
  });

  describe('handleIncomingEvent — SessionProposed validation', () => {
    function fakeProposalEvent(overrides: Partial<AKAEvent & { config: any }> = {}): AKAEvent {
      const config = overrides.config ?? {
        sessionId: 'fake-session-id-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde',
        paranetId: 'paranet-1',
        appId: 'test-app',
        createdBy: 'peer-1',
        membership,
        quorum: quorumPolicy,
        reducer: reducerConfig,
        roundTimeout: 30000,
        maxRounds: 0,
        genesisStateHash: 'abc',
        configHash: '',
        status: 'proposed' as const,
      };
      config.configHash = computeConfigHash(config);

      return {
        mode: 'AKA' as const,
        type: 'SessionProposed',
        sessionId: config.sessionId,
        round: 0,
        prevStateHash: '',
        signerPeerId: overrides.signerPeerId ?? 'peer-1',
        signature: new Uint8Array(64),
        timestamp: Date.now(),
        nonce: 'nonce-1',
        payload: encodeSessionConfig(config),
        ...overrides,
      };
    }

    it('rejects proposal with wrong configHash', async () => {
      const event = fakeProposalEvent();
      const config = {
        sessionId: event.sessionId,
        paranetId: 'paranet-1',
        appId: 'test-app',
        createdBy: 'peer-1',
        membership,
        quorum: quorumPolicy,
        reducer: reducerConfig,
        roundTimeout: 30000,
        maxRounds: 0,
        genesisStateHash: 'abc',
        configHash: 'wrong-hash-on-purpose',
        status: 'proposed' as const,
      };
      event.payload = encodeSessionConfig(config);

      const handler = vi.fn();
      const bus = new TypedEventBus();
      const mgr = new SessionManager(mockGossip as any, bus, reducerRegistry, {
        localPeerId: 'peer-1', secretKey: kp1.secretKey, network: 'test-net',
      });
      bus.on(AKASessionEvent.SESSION_PROPOSED, handler);

      await mgr.handleIncomingEvent(event, 'peer-1');
      expect(handler).not.toHaveBeenCalled();
      mgr.destroy();
    });

    it('rejects proposal where signer is not the creator', async () => {
      const event = fakeProposalEvent({ signerPeerId: 'peer-2' });

      const handler = vi.fn();
      const bus = new TypedEventBus();
      const mgr = new SessionManager(mockGossip as any, bus, reducerRegistry, {
        localPeerId: 'peer-1', secretKey: kp1.secretKey, network: 'test-net',
      });
      bus.on(AKASessionEvent.SESSION_PROPOSED, handler);

      await mgr.handleIncomingEvent(event, 'peer-2');
      expect(handler).not.toHaveBeenCalled();
      mgr.destroy();
    });

    it('rejects proposal where sessionId in event does not match config', async () => {
      const event = fakeProposalEvent();
      event.sessionId = 'mismatched-session-id-00000000000000000000000000000000000000000000000000000000000';

      const handler = vi.fn();
      const bus = new TypedEventBus();
      const mgr = new SessionManager(mockGossip as any, bus, reducerRegistry, {
        localPeerId: 'peer-1', secretKey: kp1.secretKey, network: 'test-net',
      });
      bus.on(AKASessionEvent.SESSION_PROPOSED, handler);

      await mgr.handleIncomingEvent(event, 'peer-1');
      expect(handler).not.toHaveBeenCalled();
      mgr.destroy();
    });

    it('rejects proposal where local peer is not a member', async () => {
      const event = fakeProposalEvent();

      const handler = vi.fn();
      const bus = new TypedEventBus();
      const mgr = new SessionManager(mockGossip as any, bus, reducerRegistry, {
        localPeerId: 'peer-999', secretKey: kp1.secretKey, network: 'test-net',
      });
      bus.on(AKASessionEvent.SESSION_PROPOSED, handler);

      await mgr.handleIncomingEvent(event, 'peer-1');
      expect(handler).not.toHaveBeenCalled();
      mgr.destroy();
    });
  });

  describe('startRound/submitInput — round mismatch validation', () => {
    it('startRound rejects when requestedRound does not match currentRound', async () => {
      const config = await manager.createSession(
        'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      acceptAllMembers(config.sessionId);
      await manager.activateSession(config.sessionId);

      const session = manager.getSession(config.sessionId)!;
      session.currentRound = 2;

      await expect(
        manager.startRound(config.sessionId, 5),
      ).rejects.toThrow('round mismatch: requested 5 but current round is 2');
    });

    it('startRound succeeds when requestedRound matches currentRound', async () => {
      const config = await manager.createSession(
        'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      acceptAllMembers(config.sessionId);
      await manager.activateSession(config.sessionId);

      const session = manager.getSession(config.sessionId)!;
      session.currentRound = 2;

      await expect(manager.startRound(config.sessionId, 2)).resolves.not.toThrow();
    });

    it('submitInput rejects when requestedRound does not match currentRound', async () => {
      const config = await manager.createSession(
        'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      acceptAllMembers(config.sessionId);
      await manager.activateSession(config.sessionId);

      const session = manager.getSession(config.sessionId)!;
      session.currentRound = 2;
      await manager.startRound(config.sessionId, 2);

      await expect(
        manager.submitInput(config.sessionId, new Uint8Array([1]), 7),
      ).rejects.toThrow('round mismatch: requested 7 but current round is 2');
    });

    it('submitInput succeeds when requestedRound matches currentRound', async () => {
      const config = await manager.createSession(
        'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      acceptAllMembers(config.sessionId);
      await manager.activateSession(config.sessionId);

      const session = manager.getSession(config.sessionId)!;
      session.currentRound = 2;
      await manager.startRound(config.sessionId, 2);

      await expect(
        manager.submitInput(config.sessionId, new Uint8Array([1, 2, 3]), 2),
      ).resolves.not.toThrow();
    });
  });

  describe('handleIncomingEvent — SessionActivated gate', () => {
    it('rejects SessionActivated when members have not accepted', async () => {
      const config = await manager.createSession(
        'paranet-1', 'test-app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      const sessionId = config.sessionId;
      const payload = new Uint8Array(0);
      const signature = await signAKAPayload(
        {
          domain: 'AKA-v1',
          network: 'test-net',
          paranetId: 'paranet-1',
          sessionId,
          round: 0,
          type: 'SessionActivated',
        },
        Array.from(payload),
        kp1.secretKey,
      );
      const event: AKAEvent = {
        mode: 'AKA',
        type: 'SessionActivated',
        sessionId,
        round: 0,
        prevStateHash: config.genesisStateHash,
        signerPeerId: 'peer-1',
        signature,
        timestamp: Date.now(),
        nonce: `peer-1-${sessionId.slice(0, 8)}-SessionActivated-0-${Date.now()}`,
        payload,
      };

      await manager.handleIncomingEvent(event, 'peer-1');

      const session = manager.getSession(sessionId)!;
      expect(session.config.status).toBe('proposed');
    });

    it('accepts SessionActivated when all members have accepted', async () => {
      const config = await manager.createSession(
        'paranet-1', 'test-app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      acceptAllMembers(config.sessionId);
      const sessionId = config.sessionId;
      const payload = new Uint8Array(0);
      const signature = await signAKAPayload(
        {
          domain: 'AKA-v1',
          network: 'test-net',
          paranetId: 'paranet-1',
          sessionId,
          round: 0,
          type: 'SessionActivated',
        },
        Array.from(payload),
        kp1.secretKey,
      );
      const event: AKAEvent = {
        mode: 'AKA',
        type: 'SessionActivated',
        sessionId,
        round: 0,
        prevStateHash: config.genesisStateHash,
        signerPeerId: 'peer-1',
        signature,
        timestamp: Date.now(),
        nonce: `peer-1-${sessionId.slice(0, 8)}-SessionActivated-0-${Date.now()}`,
        payload,
      };

      await manager.handleIncomingEvent(event, 'peer-1');

      const session = manager.getSession(sessionId)!;
      expect(session.config.status).toBe('active');
    });
  });

  describe('handleRoundAck — proposal field matching', () => {
    it('rejects RoundAck whose fields don\'t match the proposal', async () => {
      const config = await manager.createSession(
        'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      acceptAllMembers(config.sessionId);
      await manager.activateSession(config.sessionId);

      const session = manager.getSession(config.sessionId)!;
      session.currentRound = 2;
      manager.startRound(config.sessionId).catch(() => {});

      const roundState = session.roundStates.get(2)!;
      roundState.proposal = {
        round: 2,
        prevStateHash: session.latestStateHash,
        inputSetHash: 'correct-input-hash',
        nextStateHash: 'correct-next-hash',
        includedMembers: ['peer-1'],
        includedInputs: [new Uint8Array([1])],
      };
      roundState.status = 'awaiting_acks';

      const ackPayload: RoundAckPayload = {
        round: 2,
        prevStateHash: session.latestStateHash,
        inputSetHash: 'WRONG-input-hash',
        nextStateHash: 'correct-next-hash',
        turnCommitment: 'tc',
      };
      const payload = encodeRoundAckPayload(ackPayload);
      const signature = await signAKAPayload(
        {
          domain: 'AKA-v1',
          network: 'test-net',
          paranetId: 'paranet-1',
          sessionId: config.sessionId,
          round: 2,
          type: 'RoundAck',
        },
        Array.from(payload),
        kp2.secretKey,
      );
      const event: AKAEvent = {
        mode: 'AKA',
        type: 'RoundAck',
        sessionId: config.sessionId,
        round: 2,
        prevStateHash: session.latestStateHash,
        signerPeerId: 'peer-2',
        signature,
        timestamp: Date.now(),
        nonce: `peer-2-${config.sessionId.slice(0, 8)}-RoundAck-2-${Date.now()}`,
        payload,
      };

      await manager.handleIncomingEvent(event, 'peer-2');

      expect(roundState.acks.size).toBe(0);
    });
  });

  describe('handleRoundFinalized — duplicate signerPeerIds', () => {
    it('rejects RoundFinalized with duplicate signerPeerIds', async () => {
      const config = await manager.createSession(
        'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      acceptAllMembers(config.sessionId);
      await manager.activateSession(config.sessionId);

      const session = manager.getSession(config.sessionId)!;
      session.currentRound = 2;
      await manager.startRound(config.sessionId);
      const roundState = session.roundStates.get(2)!;
      roundState.proposal = {
        round: 2,
        prevStateHash: session.latestStateHash,
        inputSetHash: 'x',
        nextStateHash: 'x',
        includedMembers: ['peer-1'],
        includedInputs: [],
      };
      roundState.status = 'awaiting_acks';

      const finPayload = encodeRoundFinalizedPayload({
        round: 2,
        nextStateHash: 'x',
        signerPeerIds: ['peer-1', 'peer-1'],
        signatures: [new Uint8Array(64), new Uint8Array(64)],
      });
      const signature = await signAKAPayload(
        {
          domain: 'AKA-v1',
          network: 'test-net',
          paranetId: 'paranet-1',
          sessionId: config.sessionId,
          round: 2,
          type: 'RoundFinalized',
        },
        Array.from(finPayload),
        kp1.secretKey,
      );
      const event: AKAEvent = {
        mode: 'AKA',
        type: 'RoundFinalized',
        sessionId: config.sessionId,
        round: 2,
        prevStateHash: session.latestStateHash,
        signerPeerId: 'peer-1',
        signature,
        timestamp: Date.now(),
        nonce: `peer-1-${config.sessionId.slice(0, 8)}-RoundFinalized-2-${Date.now()}`,
        payload: finPayload,
      };

      await manager.handleIncomingEvent(event, 'peer-1');

      expect(session.latestFinalizedRound).toBe(0);
    });
  });

  describe('state bytes — reducer receives actual state, not hash', () => {
    it('latestStateBytes is set from genesis and is not hash text', async () => {
      const config = await manager.createSession(
        'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      const session = manager.getSession(config.sessionId)!;

      expect(session.latestStateBytes).toEqual(new Uint8Array([0, 0, 0, 0]));
      expect(session.latestStateBytes).not.toEqual(
        new TextEncoder().encode(session.latestStateHash),
      );
    });
  });

  describe('timeout — remote proposer timer', () => {
    it('after view change to remote proposer, a new timer fires on subsequent timeout', async () => {
      const config = await manager.createSession(
        'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      acceptAllMembers(config.sessionId);
      await manager.activateSession(config.sessionId);

      const session = manager.getSession(config.sessionId)!;
      session.currentRound = 2;
      await manager.startRound(config.sessionId);

      const roundState = session.roundStates.get(2)!;
      expect(roundState.status).toBe('collecting_inputs');

      vi.advanceTimersByTime(30000);
      expect(roundState.viewChangeCount).toBe(1);
      expect(roundState.proposerPeerId).toBe('peer-2');

      vi.advanceTimersByTime(30000);
      expect(roundState.viewChangeCount).toBe(2);
    });
  });

  describe('handleIncomingEvent — validator drops invalid events', () => {
    it('drops event with invalid signature before processing', async () => {
      const config = await manager.createSession(
        'paranet-1', 'app', membership, quorumPolicy, reducerConfig, 30000, null,
      );
      acceptAllMembers(config.sessionId);
      await manager.activateSession(config.sessionId);

      const session = manager.getSession(config.sessionId)!;

      // Craft a SessionAborted event with a garbage signature
      const event: AKAEvent = {
        mode: 'AKA',
        type: 'SessionAborted',
        sessionId: config.sessionId,
        round: 0,
        prevStateHash: session.latestStateHash,
        signerPeerId: 'peer-1',
        signature: new Uint8Array(64), // all zeros — invalid
        timestamp: Date.now(),
        nonce: `peer-1-test-abort-${Date.now()}`,
        payload: new TextEncoder().encode('forged abort'),
      };

      await manager.handleIncomingEvent(event, 'peer-1');

      // Session should still be active — the invalid event was dropped
      expect(session.config.status).toBe('active');
    });
  });

  describe('createSession — membership invariants', () => {
    it('rejects membership with duplicate peerId', async () => {
      const duplicateMembership: SessionMember[] = [
        { peerId: 'peer-1', pubKey: kp1.publicKey, displayName: 'Alice', role: 'creator' },
        { peerId: 'peer-1', pubKey: kp2.publicKey, displayName: 'Bob', role: 'member' },
      ];

      await expect(
        manager.createSession('paranet-1', 'app', duplicateMembership, quorumPolicy, reducerConfig, 30000, null),
      ).rejects.toThrow('duplicate peerId');
    });

    it('rejects membership without localPeerId', async () => {
      const noLocalMembership: SessionMember[] = [
        { peerId: 'peer-99', pubKey: kp1.publicKey, displayName: 'Alice', role: 'creator' },
        { peerId: 'peer-100', pubKey: kp2.publicKey, displayName: 'Bob', role: 'member' },
      ];

      await expect(
        manager.createSession('paranet-1', 'app', noLocalMembership, quorumPolicy, reducerConfig, 30000, null),
      ).rejects.toThrow('localPeerId must be included');
    });
  });
});
