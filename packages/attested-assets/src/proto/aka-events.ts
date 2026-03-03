import protobuf from 'protobufjs';
import type {
  AKAEvent,
  AKAEventType,
  SessionConfig,
  SessionMember,
  QuorumPolicy,
  ReducerConfig,
  RoundStartPayload,
  InputPayload,
  RoundProposalPayload,
  RoundAckPayload,
  RoundFinalizedPayload,
  SessionAcceptedPayload,
  SessionFinalizedPayload,
} from '../types.js';

const { Type, Field } = protobuf;

const SessionMemberSchema = new Type('SessionMember')
  .add(new Field('peerId', 1, 'string'))
  .add(new Field('pubKey', 2, 'bytes'))
  .add(new Field('displayName', 3, 'string'))
  .add(new Field('role', 4, 'string'));

const QuorumPolicySchema = new Type('QuorumPolicy')
  .add(new Field('type', 1, 'string'))
  .add(new Field('numerator', 2, 'uint32'))
  .add(new Field('denominator', 3, 'uint32'))
  .add(new Field('minSigners', 4, 'uint32'));

const ReducerConfigSchema = new Type('ReducerConfig')
  .add(new Field('name', 1, 'string'))
  .add(new Field('version', 2, 'string'))
  .add(new Field('hash', 3, 'string'));

const SessionConfigSchema = new Type('SessionConfig')
  .add(new Field('sessionId', 1, 'string'))
  .add(new Field('paranetId', 2, 'string'))
  .add(new Field('appId', 3, 'string'))
  .add(new Field('createdBy', 4, 'string'))
  .add(new Field('createdAt', 5, 'string'))
  .add(new Field('membership', 6, 'SessionMember', 'repeated'))
  .add(new Field('membershipRoot', 7, 'string'))
  .add(new Field('quorumPolicy', 8, 'QuorumPolicy'))
  .add(new Field('reducer', 9, 'ReducerConfig'))
  .add(new Field('genesisStateHash', 10, 'string'))
  .add(new Field('roundTimeout', 11, 'uint32'))
  .add(new Field('maxRounds', 12, 'uint32'))
  .add(new Field('status', 13, 'string'))
  .add(new Field('configHash', 14, 'string'))
  .add(SessionMemberSchema)
  .add(QuorumPolicySchema)
  .add(ReducerConfigSchema);

const AKAEventSchema = new Type('AKAEvent')
  .add(new Field('mode', 1, 'string'))
  .add(new Field('type', 2, 'string'))
  .add(new Field('sessionId', 3, 'string'))
  .add(new Field('round', 4, 'uint32'))
  .add(new Field('prevStateHash', 5, 'string'))
  .add(new Field('signerPeerId', 6, 'string'))
  .add(new Field('signature', 7, 'bytes'))
  .add(new Field('timestamp', 8, 'uint64'))
  .add(new Field('nonce', 9, 'string'))
  .add(new Field('payload', 10, 'bytes'));

const RoundStartPayloadSchema = new Type('RoundStartPayload')
  .add(new Field('round', 1, 'uint32'))
  .add(new Field('prevStateHash', 2, 'string'))
  .add(new Field('deadline', 3, 'uint64'));

const InputPayloadSchema = new Type('InputPayload')
  .add(new Field('round', 1, 'uint32'))
  .add(new Field('data', 2, 'bytes'));

const RoundProposalPayloadSchema = new Type('RoundProposalPayload')
  .add(new Field('round', 1, 'uint32'))
  .add(new Field('prevStateHash', 2, 'string'))
  .add(new Field('inputSetHash', 3, 'string'))
  .add(new Field('nextStateHash', 4, 'string'))
  .add(new Field('includedMembers', 5, 'string', 'repeated'))
  .add(new Field('includedInputs', 6, 'bytes', 'repeated'));

const RoundAckPayloadSchema = new Type('RoundAckPayload')
  .add(new Field('round', 1, 'uint32'))
  .add(new Field('prevStateHash', 2, 'string'))
  .add(new Field('inputSetHash', 3, 'string'))
  .add(new Field('nextStateHash', 4, 'string'))
  .add(new Field('turnCommitment', 5, 'string'));

const RoundFinalizedPayloadSchema = new Type('RoundFinalizedPayload')
  .add(new Field('round', 1, 'uint32'))
  .add(new Field('nextStateHash', 2, 'string'))
  .add(new Field('signerPeerIds', 3, 'string', 'repeated'))
  .add(new Field('signatures', 4, 'bytes', 'repeated'));

const SessionAcceptedPayloadSchema = new Type('SessionAcceptedPayload')
  .add(new Field('sessionId', 1, 'string'))
  .add(new Field('configHash', 2, 'string'));

const SessionFinalizedPayloadSchema = new Type('SessionFinalizedPayload')
  .add(new Field('sessionId', 1, 'string'))
  .add(new Field('finalRound', 2, 'uint32'))
  .add(new Field('finalStateHash', 3, 'string'));

export function encodeAKAEvent(event: AKAEvent): Uint8Array {
  return AKAEventSchema.encode(AKAEventSchema.create({
    ...event,
    timestamp: event.timestamp,
  })).finish();
}

export function decodeAKAEvent(buf: Uint8Array): AKAEvent {
  const raw = AKAEventSchema.decode(buf) as unknown as Record<string, unknown>;
  return {
    mode: raw.mode as 'AKA',
    type: raw.type as AKAEventType,
    sessionId: raw.sessionId as string,
    round: raw.round as number,
    prevStateHash: raw.prevStateHash as string,
    signerPeerId: raw.signerPeerId as string,
    signature: raw.signature as Uint8Array,
    timestamp: Number(raw.timestamp),
    nonce: raw.nonce as string,
    payload: raw.payload as Uint8Array,
  };
}

export function encodeSessionConfig(config: SessionConfig): Uint8Array {
  return SessionConfigSchema.encode(SessionConfigSchema.create({
    ...config,
    maxRounds: config.maxRounds ?? 0,
  })).finish();
}

export function decodeSessionConfig(buf: Uint8Array): SessionConfig {
  const raw = SessionConfigSchema.decode(buf) as unknown as Record<string, unknown>;
  const maxRounds = raw.maxRounds as number;
  return {
    ...(raw as unknown as SessionConfig),
    maxRounds: maxRounds === 0 ? null : maxRounds,
  };
}

export function encodeRoundStartPayload(p: RoundStartPayload): Uint8Array {
  return RoundStartPayloadSchema.encode(RoundStartPayloadSchema.create(p)).finish();
}

export function decodeRoundStartPayload(buf: Uint8Array): RoundStartPayload {
  const raw = RoundStartPayloadSchema.decode(buf) as unknown as Record<string, unknown>;
  return { round: raw.round as number, prevStateHash: raw.prevStateHash as string, deadline: Number(raw.deadline) };
}

export function encodeInputPayload(p: InputPayload): Uint8Array {
  return InputPayloadSchema.encode(InputPayloadSchema.create(p)).finish();
}

export function decodeInputPayload(buf: Uint8Array): InputPayload {
  return InputPayloadSchema.decode(buf) as unknown as InputPayload;
}

export function encodeRoundProposalPayload(p: RoundProposalPayload): Uint8Array {
  return RoundProposalPayloadSchema.encode(RoundProposalPayloadSchema.create(p)).finish();
}

export function decodeRoundProposalPayload(buf: Uint8Array): RoundProposalPayload {
  return RoundProposalPayloadSchema.decode(buf) as unknown as RoundProposalPayload;
}

export function encodeRoundAckPayload(p: RoundAckPayload): Uint8Array {
  return RoundAckPayloadSchema.encode(RoundAckPayloadSchema.create(p)).finish();
}

export function decodeRoundAckPayload(buf: Uint8Array): RoundAckPayload {
  return RoundAckPayloadSchema.decode(buf) as unknown as RoundAckPayload;
}

export function encodeRoundFinalizedPayload(p: RoundFinalizedPayload): Uint8Array {
  return RoundFinalizedPayloadSchema.encode(RoundFinalizedPayloadSchema.create(p)).finish();
}

export function decodeRoundFinalizedPayload(buf: Uint8Array): RoundFinalizedPayload {
  return RoundFinalizedPayloadSchema.decode(buf) as unknown as RoundFinalizedPayload;
}

export function encodeSessionAcceptedPayload(p: SessionAcceptedPayload): Uint8Array {
  return SessionAcceptedPayloadSchema.encode(SessionAcceptedPayloadSchema.create(p)).finish();
}

export function decodeSessionAcceptedPayload(buf: Uint8Array): SessionAcceptedPayload {
  return SessionAcceptedPayloadSchema.decode(buf) as unknown as SessionAcceptedPayload;
}

export function encodeSessionFinalizedPayload(p: SessionFinalizedPayload): Uint8Array {
  return SessionFinalizedPayloadSchema.encode(SessionFinalizedPayloadSchema.create(p)).finish();
}

export function decodeSessionFinalizedPayload(buf: Uint8Array): SessionFinalizedPayload {
  return SessionFinalizedPayloadSchema.decode(buf) as unknown as SessionFinalizedPayload;
}
