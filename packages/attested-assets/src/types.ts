export type SessionStatus = 'proposed' | 'active' | 'finalized' | 'aborted';
export type MemberRole = 'creator' | 'member';

export interface SessionMember {
  peerId: string;
  pubKey: Uint8Array;
  displayName: string;
  role: MemberRole;
}

export interface QuorumPolicy {
  type: 'THRESHOLD';
  numerator: number;
  denominator: number;
  minSigners: number;
}

export interface ReducerConfig {
  name: string;
  version: string;
  hash: string;
}

export interface SessionConfig {
  sessionId: string;
  paranetId: string;
  appId: string;
  createdBy: string;
  createdAt: string;
  membership: SessionMember[];
  membershipRoot: string;
  quorumPolicy: QuorumPolicy;
  reducer: ReducerConfig;
  genesisStateHash: string;
  roundTimeout: number;
  maxRounds: number | null;
  status: SessionStatus;
  configHash: string;
}

export type AKAEventType =
  | 'SessionProposed'
  | 'SessionAccepted'
  | 'SessionActivated'
  | 'SessionFinalized'
  | 'SessionAborted'
  | 'RoundStart'
  | 'InputSubmitted'
  | 'RoundProposal'
  | 'RoundAck'
  | 'RoundFinalized'
  | 'RoundTimeout';

export interface AKAEvent {
  mode: 'AKA';
  type: AKAEventType;
  sessionId: string;
  round: number;
  prevStateHash: string;
  signerPeerId: string;
  signature: Uint8Array;
  timestamp: number;
  nonce: string;
  payload: Uint8Array;
}

export interface RoundStartPayload {
  round: number;
  prevStateHash: string;
  deadline: number;
}

export interface InputPayload {
  round: number;
  data: Uint8Array;
}

export interface RoundProposalPayload {
  round: number;
  prevStateHash: string;
  inputSetHash: string;
  nextStateHash: string;
  includedMembers: string[];
  includedInputs: Uint8Array[];
}

export interface RoundAckPayload {
  round: number;
  prevStateHash: string;
  inputSetHash: string;
  nextStateHash: string;
  turnCommitment: string;
}

export interface RoundFinalizedPayload {
  round: number;
  nextStateHash: string;
  signerPeerIds: string[];
  signatures: Uint8Array[];
}

export interface SessionAcceptedPayload {
  sessionId: string;
  configHash: string;
}

export interface SessionFinalizedPayload {
  sessionId: string;
  finalRound: number;
  finalStateHash: string;
}

export type ReducerFn = (prevState: Uint8Array, inputSet: Uint8Array[]) => Uint8Array;

export interface ReducerModule {
  name: string;
  version: string;
  hash: string;
  reduce: ReducerFn;
  genesisState: (membership: SessionMember[]) => Uint8Array;
}

export interface RoundState {
  round: number;
  status: 'awaiting_start' | 'collecting_inputs' | 'awaiting_proposal' | 'awaiting_acks' | 'finalized' | 'timed_out';
  proposerPeerId: string;
  viewChangeCount: number;
  inputs: Map<string, InputPayload>;
  proposal: RoundProposalPayload | null;
  acks: Map<string, RoundAckPayload>;
  ackSignatures: Map<string, Uint8Array>;
  startTime: number | null;
  deadline: number | null;
}

export interface SessionState {
  config: SessionConfig;
  currentRound: number;
  latestFinalizedRound: number;
  latestStateHash: string;
  latestStateBytes: Uint8Array;
  roundStates: Map<number, RoundState>;
  equivocators: Set<string>;
  inactiveMembers: Map<string, number>;
  consecutiveSkips: number;
  acceptedMembers: Set<string>;
}

export interface AKAEventEnvelope {
  event: AKAEvent;
  raw: Uint8Array;
}
