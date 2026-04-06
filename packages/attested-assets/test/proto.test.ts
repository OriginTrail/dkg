import { describe, it, expect } from 'vitest';
import {
  encodeAKAEvent,
  decodeAKAEvent,
  encodeSessionConfig,
  decodeSessionConfig,
  encodeRoundStartPayload,
  decodeRoundStartPayload,
  encodeInputPayload,
  decodeInputPayload,
  encodeRoundProposalPayload,
  decodeRoundProposalPayload,
  encodeRoundAckPayload,
  decodeRoundAckPayload,
  encodeRoundFinalizedPayload,
  decodeRoundFinalizedPayload,
  encodeSessionAcceptedPayload,
  decodeSessionAcceptedPayload,
  encodeSessionFinalizedPayload,
  decodeSessionFinalizedPayload,
} from '../src/proto/aka-events.js';
import type {
  AKAEvent,
  SessionConfig,
  RoundStartPayload,
  InputPayload,
  RoundProposalPayload,
  RoundAckPayload,
  RoundFinalizedPayload,
  SessionAcceptedPayload,
  SessionFinalizedPayload,
} from '../src/types.js';

describe('AKAEvent encode/decode', () => {
  it('roundtrips an AKAEvent', () => {
    const event: AKAEvent = {
      mode: 'AKA',
      type: 'InputSubmitted',
      sessionId: 'session-abc',
      round: 5,
      prevStateHash: '0xdeadbeef',
      signerPeerId: 'peer-123',
      signature: new Uint8Array([1, 2, 3, 4]),
      timestamp: 1709500000000,
      nonce: 'nonce-xyz',
      payload: new Uint8Array([10, 20, 30]),
    };

    const encoded = encodeAKAEvent(event);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeAKAEvent(encoded);
    expect(decoded.mode).toBe('AKA');
    expect(decoded.type).toBe('InputSubmitted');
    expect(decoded.sessionId).toBe('session-abc');
    expect(decoded.round).toBe(5);
    expect(decoded.prevStateHash).toBe('0xdeadbeef');
    expect(decoded.signerPeerId).toBe('peer-123');
    expect(decoded.nonce).toBe('nonce-xyz');
    expect(decoded.timestamp).toBe(1709500000000);
  });

  it('handles empty payload', () => {
    const event: AKAEvent = {
      mode: 'AKA',
      type: 'SessionActivated',
      sessionId: 's1',
      round: 0,
      prevStateHash: '',
      signerPeerId: 'p1',
      signature: new Uint8Array(0),
      timestamp: 0,
      nonce: 'n1',
      payload: new Uint8Array(0),
    };

    const decoded = decodeAKAEvent(encodeAKAEvent(event));
    expect(decoded.type).toBe('SessionActivated');
    expect(decoded.round).toBe(0);
  });
});

describe('SessionConfig encode/decode', () => {
  it('roundtrips a SessionConfig', () => {
    const config: SessionConfig = {
      sessionId: 'session-1',
      contextGraphId: 'paranet-1',
      appId: 'test-app',
      createdBy: 'peer-1',
      createdAt: '2026-01-01T00:00:00Z',
      membership: [
        { peerId: 'peer-1', pubKey: new Uint8Array([1, 2, 3]), displayName: 'Alice', role: 'creator' },
        { peerId: 'peer-2', pubKey: new Uint8Array([4, 5, 6]), displayName: 'Bob', role: 'member' },
      ],
      membershipRoot: '0xmroot',
      quorumPolicy: { type: 'THRESHOLD', numerator: 2, denominator: 3, minSigners: 2 },
      reducer: { name: 'test-reducer', version: '1.0.0', hash: '0xrhash' },
      genesisStateHash: '0xgenesis',
      roundTimeout: 30000,
      maxRounds: 100,
      status: 'proposed',
      configHash: '0xchash',
    };

    const encoded = encodeSessionConfig(config);
    const decoded = decodeSessionConfig(encoded);

    expect(decoded.sessionId).toBe('session-1');
    expect(decoded.contextGraphId).toBe('paranet-1');
    expect(decoded.appId).toBe('test-app');
    expect(decoded.quorumPolicy.numerator).toBe(2);
    expect(decoded.reducer.name).toBe('test-reducer');
    expect(decoded.maxRounds).toBe(100);
  });

  it('encodes null maxRounds as 0 and decodes back to null', () => {
    const config: SessionConfig = {
      sessionId: 's',
      contextGraphId: 'p',
      appId: 'a',
      createdBy: 'c',
      createdAt: 't',
      membership: [],
      membershipRoot: '',
      quorumPolicy: { type: 'THRESHOLD', numerator: 1, denominator: 1, minSigners: 1 },
      reducer: { name: 'r', version: '1', hash: 'h' },
      genesisStateHash: 'g',
      roundTimeout: 1000,
      maxRounds: null,
      status: 'active',
      configHash: 'c',
    };

    const decoded = decodeSessionConfig(encodeSessionConfig(config));
    expect(decoded.maxRounds).toBeNull();
  });
});

describe('RoundStartPayload encode/decode', () => {
  it('roundtrips', () => {
    const payload: RoundStartPayload = { round: 7, prevStateHash: '0xabc', deadline: 1709500030000 };
    const decoded = decodeRoundStartPayload(encodeRoundStartPayload(payload));
    expect(decoded.round).toBe(7);
    expect(decoded.prevStateHash).toBe('0xabc');
    expect(decoded.deadline).toBe(1709500030000);
  });
});

describe('InputPayload encode/decode', () => {
  it('roundtrips', () => {
    const payload: InputPayload = { round: 3, data: new Uint8Array([1, 2, 3]) };
    const decoded = decodeInputPayload(encodeInputPayload(payload));
    expect(decoded.round).toBe(3);
  });
});

describe('RoundProposalPayload encode/decode', () => {
  it('roundtrips', () => {
    const payload: RoundProposalPayload = {
      round: 5,
      prevStateHash: '0xprev',
      inputSetHash: '0xinput',
      nextStateHash: '0xnext',
      includedMembers: ['peer-1', 'peer-2'],
      includedInputs: [new Uint8Array([1]), new Uint8Array([2])],
    };
    const decoded = decodeRoundProposalPayload(encodeRoundProposalPayload(payload));
    expect(decoded.round).toBe(5);
    expect(decoded.prevStateHash).toBe('0xprev');
    expect(decoded.inputSetHash).toBe('0xinput');
    expect(decoded.nextStateHash).toBe('0xnext');
    expect(decoded.includedMembers).toEqual(['peer-1', 'peer-2']);
  });
});

describe('RoundAckPayload encode/decode', () => {
  it('roundtrips', () => {
    const payload: RoundAckPayload = {
      round: 5,
      prevStateHash: '0xprev',
      inputSetHash: '0xinput',
      nextStateHash: '0xnext',
      turnCommitment: '0xtc',
    };
    const decoded = decodeRoundAckPayload(encodeRoundAckPayload(payload));
    expect(decoded.round).toBe(5);
    expect(decoded.nextStateHash).toBe('0xnext');
    expect(decoded.turnCommitment).toBe('0xtc');
  });
});

describe('RoundFinalizedPayload encode/decode', () => {
  it('roundtrips', () => {
    const payload: RoundFinalizedPayload = {
      round: 10,
      nextStateHash: '0xfinal',
      signerPeerIds: ['peer-1', 'peer-2', 'peer-3'],
      signatures: [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
    };
    const decoded = decodeRoundFinalizedPayload(encodeRoundFinalizedPayload(payload));
    expect(decoded.round).toBe(10);
    expect(decoded.nextStateHash).toBe('0xfinal');
    expect(decoded.signerPeerIds).toEqual(['peer-1', 'peer-2', 'peer-3']);
  });
});

describe('SessionAcceptedPayload encode/decode', () => {
  it('roundtrips', () => {
    const payload: SessionAcceptedPayload = { sessionId: 's-123', configHash: '0xcfg' };
    const decoded = decodeSessionAcceptedPayload(encodeSessionAcceptedPayload(payload));
    expect(decoded.sessionId).toBe('s-123');
    expect(decoded.configHash).toBe('0xcfg');
  });
});

describe('SessionFinalizedPayload encode/decode', () => {
  it('roundtrips', () => {
    const payload: SessionFinalizedPayload = { sessionId: 's-123', finalRound: 50, finalStateHash: '0xdone' };
    const decoded = decodeSessionFinalizedPayload(encodeSessionFinalizedPayload(payload));
    expect(decoded.sessionId).toBe('s-123');
    expect(decoded.finalRound).toBe(50);
    expect(decoded.finalStateHash).toBe('0xdone');
  });
});
