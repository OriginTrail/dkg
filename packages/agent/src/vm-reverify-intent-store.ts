// SPDX-License-Identifier: Apache-2.0
/**
 * Durable re-verification intents (#2435).
 *
 * One row per HELD Knowledge Asset whose on-chain Merkle root was observed to
 * change and whose local copy has not yet been proven to match it again. The
 * row is a piece of WORK, not a piece of history: it is created by the chain
 * event lane, drained by the re-verify worker, and DELETED the moment the
 * asset is proven current. Nothing downstream reads it as a record of what
 * happened — the chain is that record.
 *
 * Why its own file, not the finalization inbox: adding a table to
 * `finalization-inbox-v1.sqlite3` would be a one-way `user_version` migration
 * that runs whenever `dataDir` is set — i.e. regardless of this feature's kill
 * switch — and would make a binary rollback boot-fatal. This store is opened
 * only when the feature is effectively on, and the base release simply never
 * looks at the file. (ADR-W2R-6.)
 */
import type { KnowledgeAssetRootMutationKindV1 } from '@origintrail-official/dkg-core';

export const VM_REVERIFY_INTENTS_DATABASE_FILENAME = 'vm-reverify-intents-v1.sqlite3';

/** Live work vs. terminal-until-revived. There is deliberately no third state. */
export type VmReverifyIntentState = 'PENDING' | 'ABANDONED';

/**
 * Why a row stopped being retried. Every one of these is loud (warn + counter)
 * and every one is revivable by a strictly-newer event or by the CG being
 * (re-)subscribed / (re-)hosted — nothing here is a permanent verdict about
 * the asset, only about the evidence available so far.
 */
export type VmReverifyAbandonReason =
  /** `root-removed`: the chain moved BACKWARDS; this design cannot repair that. */
  | 'version-regression-unsupported'
  /** Not registered / no committed version / CG binding mismatch on chain. */
  | 'chain-identity-conflict'
  /** The repair primitive rejected our own arguments — a bug, not a condition. */
  | 'programmer-error'
  /** The 24 h budget expired with no reachable peer holding the version. */
  | 'no-peer-has-version';

/**
 * Chain position of the observed mutation, reduced to the three fields that
 * ORDER events. Structurally a subset of core's `FinalizedEventPositionV1`, so
 * a lane payload's `position` is assignable here as-is.
 *
 * `blockHash`/`transactionHash` are deliberately NOT persisted: they would be
 * the only columns in this table that a reorg can invalidate, and nothing in
 * the drain consults them — the repair re-reads the committed root from chain,
 * so a reorged event costs at most one wasted, idempotent inspection.
 */
export interface VmReverifyIntentPosition {
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
}

export interface VmReverifyIntentUpsertInput {
  ual: string;
  localCgId: string;
  kaId: string;
  kind: KnowledgeAssetRootMutationKindV1;
  position: VmReverifyIntentPosition;
}

export interface VmReverifyIntentRecord {
  ual: string;
  localCgId: string;
  kaId: string;
  kind: KnowledgeAssetRootMutationKindV1;
  observed: VmReverifyIntentPosition;
  state: VmReverifyIntentState;
  abandonReason?: VmReverifyAbandonReason;
  /**
   * Advances ONLY when a strictly-newer event (or a revive) redefines what this
   * row is about. Attempts and terminal marking leave it alone. That single
   * meaning is what makes the compare-and-set honest: a worker holding
   * generation N is asserting "the event I planned against is still the event
   * this row describes", and nothing else.
   */
  generation: number;
  attemptCount: number;
  /** Start of the 24 h budget. Set once per generation, on the first attempt. */
  firstAttemptAt?: number;
  nextAttemptAt?: number;
  lastOutcome?: string;
  createdAt: number;
  updatedAt: number;
}

export interface VmReverifyIntentHealth {
  pending: number;
  abandoned: number;
  oldestPendingFirstAttemptAt?: number;
}

export type VmReverifyIntentUpsertResult = 'inserted' | 'advanced' | 'unchanged';

export interface VmReverifyIntentStore {
  /**
   * Record an observed root mutation for a held asset.
   *
   * Idempotent by UAL. A strictly-later position revives an ABANDONED row and
   * resets its attempt budget; an equal or earlier position changes nothing and
   * reports `unchanged`, so a re-scanned window costs no log line, no metric and
   * no drain slot.
   */
  upsert(input: VmReverifyIntentUpsertInput): Promise<VmReverifyIntentUpsertResult>;
  /** PENDING rows whose backoff has elapsed, oldest observed event first. */
  listDue(now: number, limit: number): Promise<VmReverifyIntentRecord[]>;
  /** The asset is proven current: the work is done and the row is gone. */
  resolve(ual: string, generation: number): Promise<boolean>;
  recordAttempt(
    ual: string,
    generation: number,
    lastOutcome: string,
    retryDelayMs: number,
    now: number,
  ): Promise<boolean>;
  abandon(ual: string, generation: number, reason: VmReverifyAbandonReason): Promise<boolean>;
  /** (Re-)subscribing or (re-)hosting a CG is new evidence: retry its dead rows. */
  reviveForContextGraph(localCgId: string): Promise<number>;
  countPending(localCgId?: string): Promise<number>;
  health(): Promise<VmReverifyIntentHealth>;
  /** Bound the file: abandoned rows are diagnostics, not durable state. */
  gcAbandoned(olderThanMs: number): Promise<number>;
  close(): Promise<void>;
}
