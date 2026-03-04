import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionManager, AKASessionEvent } from '../src/session-manager.js';
import { ReducerRegistry } from '../src/reducer.js';
import { computeStateHash, computeConfigHash } from '../src/canonical.js';
import { encodeSessionConfig } from '../src/proto/aka-events.js';
import { TypedEventBus, generateEd25519Keypair, type Ed25519Keypair } from '@dkg/core';
import type { ReducerModule, QuorumPolicy, SessionMember, AKAEvent } from '../src/types.js';

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

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    kp1 = await generateEd25519Keypair();
    kp2 = await generateEd25519Keypair();
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

  const membership: SessionMember[] = [
    { peerId: 'peer-1', pubKey: kp1?.publicKey ?? new Uint8Array(32), displayName: 'Alice', role: 'creator' },
    { peerId: 'peer-2', pubKey: kp2?.publicKey ?? new Uint8Array(32), displayName: 'Bob', role: 'member' },
  ];

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
});
