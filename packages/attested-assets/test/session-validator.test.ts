import { describe, it, expect, beforeEach } from 'vitest';
import { SessionValidator, detectEquivocation } from '../src/session-validator.js';
import { signAKAPayload } from '../src/canonical.js';
import { encodeRoundAckPayload } from '../src/proto/aka-events.js';
import { generateEd25519Keypair, type Ed25519Keypair } from '@origintrail-official/dkg-core';
import type { AKAEvent, SessionState, SessionConfig, RoundState, RoundAckPayload } from '../src/types.js';

let kp: Ed25519Keypair;
let kp2: Ed25519Keypair;
const encoder = new TextEncoder();

function makeSessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    sessionId: 'session-1',
    contextGraphId: 'paranet-1',
    appId: 'test-app',
    createdBy: 'peer-1',
    createdAt: '2026-01-01T00:00:00Z',
    membership: [
      { peerId: 'peer-1', pubKey: kp.publicKey, displayName: 'Alice', role: 'creator' },
      { peerId: 'peer-2', pubKey: kp2.publicKey, displayName: 'Bob', role: 'member' },
    ],
    membershipRoot: '0xroot',
    quorumPolicy: { type: 'THRESHOLD', numerator: 2, denominator: 3, minSigners: 2 },
    reducer: { name: 'test', version: '1.0.0', hash: '0xreducer' },
    genesisStateHash: '0xgenesis',
    roundTimeout: 30000,
    maxRounds: null,
    status: 'active',
    configHash: '0xconfig',
    ...overrides,
  };
}

function makeRoundState(round: number, overrides: Partial<RoundState> = {}): RoundState {
  return {
    round,
    status: 'collecting_inputs',
    proposerPeerId: 'peer-1',
    viewChangeCount: 0,
    inputs: new Map(),
    proposal: null,
    acks: new Map(),
    ackSignatures: new Map(),
    startTime: Date.now() - 1000,
    deadline: Date.now() + 29000,
    ...overrides,
  };
}

function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
  const roundStates = new Map<number, RoundState>();
  roundStates.set(1, makeRoundState(1));
  return {
    config: makeSessionConfig(),
    currentRound: 1,
    latestFinalizedRound: 0,
    latestStateHash: '0xgenesis',
    latestStateBytes: new Uint8Array([0, 0, 0, 0]),
    roundStates,
    equivocators: new Set(),
    inactiveMembers: new Map(),
    consecutiveSkips: 0,
    acceptedMembers: new Set(),
    ...overrides,
  };
}

async function makeSignedEvent(
  type: AKAEvent['type'],
  overrides: Partial<AKAEvent> = {},
  signerKey?: Ed25519Keypair,
): Promise<AKAEvent> {
  const payload = encoder.encode('test-payload');
  const key = signerKey ?? kp;
  const round = overrides.round ?? 1;
  const sig = await signAKAPayload(
    {
      domain: 'AKA-v1',
      network: 'test',
      contextGraphId: 'paranet-1',
      sessionId: 'session-1',
      round,
      type,
    },
    Array.from(payload),
    key.secretKey,
  );

  return {
    mode: 'AKA',
    type,
    sessionId: 'session-1',
    round,
    prevStateHash: '0xgenesis',
    signerPeerId: 'peer-1',
    signature: sig,
    timestamp: Date.now(),
    nonce: `nonce-${Date.now()}-${Math.random()}`,
    payload,
    ...overrides,
  };
}

describe('SessionValidator', () => {
  let validator: SessionValidator;

  beforeEach(async () => {
    kp = await generateEd25519Keypair();
    kp2 = await generateEd25519Keypair();
    validator = new SessionValidator();
  });

  it('accepts a valid InputSubmitted event', async () => {
    const session = makeSessionState();
    const event = await makeSignedEvent('InputSubmitted');
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(true);
  });

  it('rejects wrong mode', async () => {
    const session = makeSessionState();
    const event = await makeSignedEvent('InputSubmitted', { mode: 'WRONG' as 'AKA' });
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('invalid mode');
  });

  it('rejects non-member signer', async () => {
    const session = makeSessionState();
    const event = await makeSignedEvent('InputSubmitted', { signerPeerId: 'peer-unknown' });
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a session member');
  });

  it('rejects when session is not active', async () => {
    const session = makeSessionState();
    session.config.status = 'proposed';
    const event = await makeSignedEvent('InputSubmitted');
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not active');
  });

  it('allows SessionAccepted even when status is proposed', async () => {
    const session = makeSessionState();
    session.config.status = 'proposed';
    const event = await makeSignedEvent('SessionAccepted');
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(true);
  });

  it('rejects state linkage mismatch for round events', async () => {
    const session = makeSessionState();
    const event = await makeSignedEvent('InputSubmitted', { prevStateHash: '0xwrong' });
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('state linkage mismatch');
  });

  it('rejects duplicate event tuple', async () => {
    const session = makeSessionState();
    const event = await makeSignedEvent('InputSubmitted');
    await validator.validate(event, session, 'test');

    const duplicate = await makeSignedEvent('InputSubmitted', { nonce: 'different-nonce' });
    const result = await validator.validate(duplicate, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('duplicate event tuple');
  });

  it('rejects duplicate nonce', async () => {
    const session = makeSessionState();
    const event1 = await makeSignedEvent('InputSubmitted', { nonce: 'same-nonce' });
    await validator.validate(event1, session, 'test');

    const event2 = await makeSignedEvent('RoundAck', { nonce: 'same-nonce' });
    const result = await validator.validate(event2, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('duplicate nonce');
  });

  it('rejects event from equivocator', async () => {
    const session = makeSessionState();
    session.equivocators.add('peer-1');
    const event = await makeSignedEvent('InputSubmitted');
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('equivocator');
  });

  it('rejects RoundProposal from non-proposer', async () => {
    const session = makeSessionState();
    session.roundStates.get(1)!.proposerPeerId = 'peer-2';
    const event = await makeSignedEvent('RoundProposal');
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not the proposer');
  });

  it('accepts RoundProposal from correct proposer', async () => {
    const session = makeSessionState();
    const event = await makeSignedEvent('RoundProposal');
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(true);
  });

  it('rejects invalid signature', async () => {
    const session = makeSessionState();
    const event = await makeSignedEvent('InputSubmitted', {
      signature: new Uint8Array(64),
    });
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('invalid Ed25519 signature');
  });

  it('rejects missing required fields', async () => {
    const session = makeSessionState();
    const event = await makeSignedEvent('InputSubmitted', { nonce: '' });
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('missing required fields');
  });

  it('rejects event outside timing window', async () => {
    const session = makeSessionState();
    const roundState = session.roundStates.get(1)!;
    roundState.startTime = Date.now() - 120_000;

    const event = await makeSignedEvent('InputSubmitted');
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('timestamp');
  });

  it('reset clears tracked state for a session', async () => {
    const session = makeSessionState();
    const event = await makeSignedEvent('InputSubmitted');
    await validator.validate(event, session, 'test');

    validator.reset('session-1');

    const retry = await makeSignedEvent('InputSubmitted', { nonce: event.nonce });
    const result = await validator.validate(retry, session, 'test');
    expect(result.valid).toBe(true);
  });

  it('SessionAborted passes validation while session is proposed', async () => {
    const session = makeSessionState();
    session.config.status = 'proposed';
    const event = await makeSignedEvent('SessionAborted');
    const result = await validator.validate(event, session, 'test');
    expect(result.valid).toBe(true);
  });

  it('Conflicting RoundAcks from same signer are not both blocked by replay', async () => {
    const session = makeSessionState();
    const payload1: RoundAckPayload = {
      round: 1,
      prevStateHash: '0xgenesis',
      inputSetHash: '0xi',
      nextStateHash: '0xA',
      turnCommitment: '0xc',
    };
    const payload2: RoundAckPayload = {
      round: 1,
      prevStateHash: '0xgenesis',
      inputSetHash: '0xi',
      nextStateHash: '0xB',
      turnCommitment: '0xc',
    };
    const encoded1 = encodeRoundAckPayload(payload1);
    const encoded2 = encodeRoundAckPayload(payload2);
    const sig1 = await signAKAPayload(
      {
        domain: 'AKA-v1',
        network: 'test',
        contextGraphId: 'paranet-1',
        sessionId: 'session-1',
        round: 1,
        type: 'RoundAck',
      },
      Array.from(encoded1),
      kp.secretKey,
    );
    const sig2 = await signAKAPayload(
      {
        domain: 'AKA-v1',
        network: 'test',
        contextGraphId: 'paranet-1',
        sessionId: 'session-1',
        round: 1,
        type: 'RoundAck',
      },
      Array.from(encoded2),
      kp.secretKey,
    );
    const event1: AKAEvent = {
      mode: 'AKA',
      type: 'RoundAck',
      sessionId: 'session-1',
      round: 1,
      prevStateHash: '0xgenesis',
      signerPeerId: 'peer-1',
      signature: sig1,
      timestamp: Date.now(),
      nonce: 'round-ack-nonce-1',
      payload: encoded1,
    };
    const event2: AKAEvent = {
      mode: 'AKA',
      type: 'RoundAck',
      sessionId: 'session-1',
      round: 1,
      prevStateHash: '0xgenesis',
      signerPeerId: 'peer-1',
      signature: sig2,
      timestamp: Date.now(),
      nonce: 'round-ack-nonce-2',
      payload: encoded2,
    };
    const result1 = await validator.validate(event1, session, 'test');
    expect(result1.valid).toBe(true);
    const result2 = await validator.validate(event2, session, 'test');
    expect(result2.valid).toBe(true);
  });

  describe('authority checks — proposer and creator events', () => {
    it('rejects RoundStart from non-proposer', async () => {
      const session = makeSessionState({
        config: makeSessionConfig({ status: 'active' }),
      });
      const roundState = makeRoundState(1, { proposerPeerId: 'peer-2' });
      session.roundStates.set(1, roundState);

      const event = await makeSignedEvent('RoundStart', {
        round: 1,
        signerPeerId: 'peer-1',
        prevStateHash: session.latestStateHash,
      });

      const result = await validator.validate(event, session, 'test');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not the proposer');
    });

    it('rejects RoundFinalized from non-proposer', async () => {
      const session = makeSessionState({
        config: makeSessionConfig({ status: 'active' }),
      });
      const roundState = makeRoundState(1, { proposerPeerId: 'peer-2' });
      session.roundStates.set(1, roundState);

      const event = await makeSignedEvent('RoundFinalized', {
        round: 1,
        signerPeerId: 'peer-1',
        prevStateHash: session.latestStateHash,
      });

      const result = await validator.validate(event, session, 'test');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not the proposer');
    });

    it('rejects SessionActivated from non-creator', async () => {
      const session = makeSessionState({
        config: makeSessionConfig({ status: 'proposed' }),
      });

      const event = await makeSignedEvent(
        'SessionActivated',
        {
          round: 0,
          signerPeerId: 'peer-2',
          prevStateHash: session.latestStateHash,
        },
        kp2,
      );

      const result = await validator.validate(event, session, 'test');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not the session creator');
    });

    it('accepts RoundStart from correct proposer', async () => {
      const session = makeSessionState({
        config: makeSessionConfig({ status: 'active' }),
      });
      const roundState = makeRoundState(1, { proposerPeerId: 'peer-1' });
      session.roundStates.set(1, roundState);

      const event = await makeSignedEvent('RoundStart', {
        round: 1,
        signerPeerId: 'peer-1',
        prevStateHash: session.latestStateHash,
      });

      const result = await validator.validate(event, session, 'test');
      expect(result.valid).toBe(true);
    });
  });
});

describe('detectEquivocation', () => {
  it('detects conflicting nextStateHash', () => {
    const a: RoundAckPayload = { round: 1, prevStateHash: '0x1', inputSetHash: '0xi', nextStateHash: '0xA', turnCommitment: '0xc' };
    const b: RoundAckPayload = { round: 1, prevStateHash: '0x1', inputSetHash: '0xi', nextStateHash: '0xB', turnCommitment: '0xc' };
    expect(detectEquivocation(a, b)).toBe(true);
  });

  it('returns false for matching nextStateHash', () => {
    const a: RoundAckPayload = { round: 1, prevStateHash: '0x1', inputSetHash: '0xi', nextStateHash: '0xA', turnCommitment: '0xc' };
    const b: RoundAckPayload = { round: 1, prevStateHash: '0x1', inputSetHash: '0xi', nextStateHash: '0xA', turnCommitment: '0xc' };
    expect(detectEquivocation(a, b)).toBe(false);
  });
});
