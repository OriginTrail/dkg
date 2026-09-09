import {
  VerifiedGraphScopedFinalizationEvidenceCodec,
  type VerifiedGraphScopedFinalizationEvidence,
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
  trustedPublisherPeerId?: string;
  publisherUpgradePending: boolean;
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
  failureSignature?: string;
  failureStreak: number;
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
  | { status: 'pending' }
  | { status: 'conflict' }
  | { status: 'capacity' }
  | { status: 'closed' };

export type FinalizationRecoveryVerifyResult =
  | { status: 'verified'; entry: FinalizationRecoveryEntry }
  | { status: 'existing'; entry: FinalizationRecoveryEntry }
  | { status: 'conflict' }
  | { status: 'missing' }
  | { status: 'closed' };

export type FinalizationRecoveryVerifiedEvidenceCommit =
  | {
      evidence: VerifiedGraphScopedFinalizationEvidence;
      placement: 'original';
    }
  | {
      evidence: VerifiedGraphScopedFinalizationEvidence;
      placement: 'canonical-moved';
      reason: string;
    };

export interface FinalizationRecoveryVerifiedEvidenceUpdate {
  state: 'VERIFIED';
  verifiedEvidence: VerifiedGraphScopedFinalizationEvidence;
  generation: number;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  failureSignature: string | null;
  failureStreak: number;
}

export type FinalizationRecoveryVerifiedEvidenceTransitionPlan =
  | { status: 'update'; fields: FinalizationRecoveryVerifiedEvidenceUpdate }
  | { status: 'existing'; entry: FinalizationRecoveryEntry }
  | { status: 'conflict' };

/**
 * Plans the domain transition before a store applies it atomically. Generation
 * remains the compare-and-swap token; placement decides whether this commit
 * preserves or advances it.
 */
export function planFinalizationRecoveryVerifiedEvidenceTransition(
  current: FinalizationRecoveryEntry,
  generation: number,
  commit: FinalizationRecoveryVerifiedEvidenceCommit,
): FinalizationRecoveryVerifiedEvidenceTransitionPlan {
  const { evidence } = commit;
  if (current.generation !== generation) return { status: 'conflict' };
  if (current.verifiedEvidence) {
    return VerifiedGraphScopedFinalizationEvidenceCodec.same(
      current.verifiedEvidence,
      evidence,
    )
      ? { status: 'existing', entry: current }
      : { status: 'conflict' };
  }
  if (
    (current.state !== 'RECEIVED' && current.state !== 'REORGED')
    || (
      commit.placement === 'canonical-moved'
      && (current.state !== 'RECEIVED' || generation !== 0)
    )
    || current.txHash.toLowerCase() !== evidence.transactionHash.toLowerCase()
    || current.assertionVersion !== evidence.assertionVersion
  ) return { status: 'conflict' };

  return {
    status: 'update',
    fields: {
      state: 'VERIFIED',
      verifiedEvidence: evidence,
      generation: commit.placement === 'canonical-moved'
        ? generation + 1
        : generation,
      attemptCount: commit.placement === 'canonical-moved'
        ? 0
        : current.attemptCount,
      nextAttemptAt: commit.placement === 'canonical-moved'
        ? null
        : current.nextAttemptAt ?? null,
      lastError: commit.placement === 'canonical-moved'
        ? commit.reason
        : current.lastError ?? null,
      failureSignature: commit.placement === 'canonical-moved'
        ? null
        : current.failureSignature ?? null,
      failureStreak: commit.placement === 'canonical-moved'
        ? 0
        : current.failureStreak,
    },
  };
}

export type FinalizationRecoverySettledPublisherUpgradeResult =
  | { status: 'recorded' | 'existing'; entry: FinalizationRecoveryEntry }
  | { status: 'conflict' | 'missing' | 'closed' };

export interface FinalizationRecoveryAttemptPolicy {
  retryDelayMs?: number;
  failureSignature?: string;
  stableFailureThreshold?: number;
  stableFailureRetryMs?: number;
  /** Autonomous poison entries must be reconsidered no later than this time. */
  retryDeadlineAt?: number;
}

export type FinalizationRecoveryAttemptResult =
  | { status: 'updated'; entry: FinalizationRecoveryEntry }
  | { status: 'stale' | 'closed' };

export interface FinalizationRecoveryAttemptUpdate {
  attemptCount: number;
  lastError: string | null;
  failureSignature: string | null;
  failureStreak: number;
  nextAttemptAt: number | null;
}

/** Pure retry policy over one durable entry snapshot. */
export function planFinalizationRecoveryAttempt(
  current: FinalizationRecoveryEntry,
  lastError: string | undefined,
  policy: FinalizationRecoveryAttemptPolicy,
  now: number,
): FinalizationRecoveryAttemptUpdate {
  const failureSignature = policy.failureSignature;
  const failureStreak = failureSignature === undefined
    ? 0
    : current.failureSignature === failureSignature
      ? current.failureStreak + 1
      : 1;
  let delayMs = policy.retryDelayMs;
  if (
    delayMs !== undefined
    && failureSignature !== undefined
    && failureStreak >= (policy.stableFailureThreshold ?? Number.POSITIVE_INFINITY)
  ) {
    delayMs = Math.max(delayMs, policy.stableFailureRetryMs ?? 0);
  }
  let nextAttemptAt = delayMs === undefined
    ? current.nextAttemptAt ?? null
    : Math.max(current.nextAttemptAt ?? 0, now + Math.max(0, delayMs));
  if (policy.retryDeadlineAt !== undefined && nextAttemptAt !== null) {
    nextAttemptAt = Math.min(nextAttemptAt, Math.max(now, policy.retryDeadlineAt));
  }
  return {
    attemptCount: current.attemptCount + 1,
    lastError: lastError ?? null,
    failureSignature: failureSignature ?? null,
    failureStreak,
    nextAttemptAt,
  };
}

export interface FinalizationRecoveryHealth {
  available: boolean;
  closed: boolean;
  ready?: boolean;
  canonicalReceiptCapability?: 'supported' | 'unsupported' | 'not-configured' | 'unknown';
  degradedReason?: string;
  stateCounts: Partial<Record<FinalizationRecoveryState, number>>;
  livePayloadBytes: number;
  dueEntries: number;
  deferredEntries?: number;
  deferredPayloadBytes?: number;
  oldestDueAgeMs?: number;
  oldestPendingAgeMs?: number;
  oldestDeferredAgeMs?: number;
}

export interface FinalizationRecoveryStore {
  readonly closed: boolean;
  /** Reloads one entry after waiting on an in-process serialization boundary. */
  get(key: string): Promise<FinalizationRecoveryEntry | undefined>;
  receive(input: FinalizationRecoveryReceiveInput): Promise<FinalizationRecoveryReceiveResult>;
  /** Moves a bounded oldest-first deferred snapshot into the live inbox. */
  promotePending(limit: number): Promise<number>;
  /** Monotonically records publisher authority validated while an envelope is deferred. */
  recordPendingTrustedPublisher(
    key: string,
    publisherPeerId: string,
  ): Promise<boolean>;
  recordTrustedPublisher(
    key: string,
    generation: number,
    publisherPeerId: string,
  ): Promise<boolean>;
  /** Persists validated late-publisher authority without changing settled evidence. */
  recordSettledPublisherUpgrade(
    key: string,
    generation: number,
    publisherPeerId: string,
  ): Promise<FinalizationRecoverySettledPublisherUpgradeResult>;
  /** Caller-validated authority upgrade; SQLite only enforces monotonic CAS state. */
  rearmSettledWithTrustedPublisher(
    key: string,
    generation: number,
    publisherPeerId: string,
    lastError: string,
  ): Promise<boolean>;
  /** Atomically records verified evidence and any canonical receipt move. */
  commitVerifiedEvidence(
    key: string,
    generation: number,
    commit: FinalizationRecoveryVerifiedEvidenceCommit,
  ): Promise<FinalizationRecoveryVerifyResult>;
  markReorged(key: string, generation: number, lastError: string): Promise<boolean>;
  clearSettledRetry(key: string, generation: number): Promise<void>;
  rejectSettled(key: string, generation: number, lastError: string): Promise<boolean>;
  isAttemptDue(entry: FinalizationRecoveryEntry): boolean;
  /**
   * Returns a bounded, oldest-first snapshot of entries whose persisted retry
   * gate is open. Callers must still rely on generation-checked transitions:
   * live gossip or reconciliation may update an entry after this read.
   */
  listDue(limit: number): Promise<FinalizationRecoveryEntry[]>;
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
    policy?: FinalizationRecoveryAttemptPolicy,
  ): Promise<FinalizationRecoveryAttemptResult>;
  health(): Promise<FinalizationRecoveryHealth>;
  close(): Promise<void>;
}
