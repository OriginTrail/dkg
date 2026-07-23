import type {
  VerifiedGraphScopedFinalizationEvidence,
} from './finalization-graph-envelope.js';

export const FINALIZATION_INBOX_DATABASE_FILENAME = 'finalization-inbox-v1.sqlite3';

export type FinalizationRecoveryState =
  | 'RECEIVED'
  | 'VERIFIED'
  | 'REORGED'
  | 'SETTLED'
  | 'SUPERSEDED'
  | 'REJECTED'
  | 'UNSUPPORTED';

export interface FinalizationRecoveryEntry {
  key: string;
  state: FinalizationRecoveryState;
  chainId: string;
  contextGraphId: string;
  sourcePeerId?: string;
  ual: string;
  txHash: string;
  assertionVersion: string;
  merkleRoot: string;
  kaId: string;
  batchId: string;
  targetContextGraphId?: string;
  envelopeSha256: string;
  rawMessage: Uint8Array;
  verifiedEvidence?: VerifiedGraphScopedFinalizationEvidence;
  generation: number;
  attemptCount: number;
  nextAttemptAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FinalizationRecoveryReceiveInput {
  key: string;
  chainId: string;
  contextGraphId: string;
  sourcePeerId?: string;
  ual: string;
  txHash: string;
  assertionVersion: string;
  merkleRoot: string;
  kaId: string;
  batchId: string;
  targetContextGraphId?: string;
  rawMessage: Uint8Array;
}

export type FinalizationRecoveryReceiveResult =
  | { status: 'inserted'; entry: FinalizationRecoveryEntry }
  | { status: 'existing'; entry: FinalizationRecoveryEntry }
  | { status: 'conflict' }
  | { status: 'capacity' }
  | { status: 'closed' };

export type FinalizationRecoveryVerifyResult =
  | { status: 'verified'; entry: FinalizationRecoveryEntry }
  | { status: 'existing'; entry: FinalizationRecoveryEntry }
  | { status: 'conflict' }
  | { status: 'missing' }
  | { status: 'closed' };

export interface FinalizationRecoveryHealth {
  available: boolean;
  closed: boolean;
  ready?: boolean;
  canonicalReceiptCapability?: 'supported' | 'unsupported' | 'not-configured' | 'unknown';
  degradedReason?: string;
  stateCounts: Partial<Record<FinalizationRecoveryState, number>>;
  livePayloadBytes: number;
  oldestPendingAgeMs?: number;
}

export interface FinalizationRecoveryStore {
  readonly closed: boolean;
  receive(input: FinalizationRecoveryReceiveInput): Promise<FinalizationRecoveryReceiveResult>;
  markVerified(
    key: string,
    generation: number,
    evidence: VerifiedGraphScopedFinalizationEvidence,
  ): Promise<FinalizationRecoveryVerifyResult>;
  markReorged(key: string, generation: number, lastError: string): Promise<boolean>;
  clearSettledRetry(key: string, generation: number): Promise<void>;
  rejectSettled(key: string, generation: number, lastError: string): Promise<boolean>;
  listForKnowledgeAsset(input: {
    chainId: string;
    contextGraphId: string;
    ual: string;
    kaId: string;
  }): Promise<FinalizationRecoveryEntry[]>;
  transition(
    key: string,
    generation: number,
    state: Extract<
      FinalizationRecoveryState,
      'SETTLED' | 'SUPERSEDED' | 'REJECTED' | 'UNSUPPORTED'
    >,
    lastError?: string,
  ): Promise<boolean>;
  recordAttempt(
    key: string,
    generation: number,
    lastError?: string,
    retryDelayMs?: number,
  ): Promise<void>;
  health(): Promise<FinalizationRecoveryHealth>;
  close(): Promise<void>;
}
