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
import {
  compareEventPosition,
  sameEventIdentity,
  type KnowledgeAssetRootMutationKindV1,
} from '@origintrail-official/dkg-core';

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
 * Chain position of the observed mutation. Structurally core's
 * `FinalizedEventPositionV1`, so a lane payload's `position` is assignable
 * here as-is.
 *
 * `blockHash`/`transactionHash` ARE persisted (review r1), for exactly one
 * decision: a reorg can REPLACE the log at an unchanged numeric position with
 * a different event. Numeric ordering alone reads that replacement as a
 * duplicate, and an ABANDONED row would then never be drained again — the
 * hashes are the only observable that tells the two chain histories apart.
 * Nothing else consults them; the repair still re-reads the committed root
 * from chain.
 */
export interface VmReverifyIntentPosition {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
}

/**
 * Does a newly observed event redefine the row `existing` describes?
 *
 * Strictly-later positions do (delegating to core's `compareEventPosition`,
 * the same ordering the finalized update records use — two mutations of one
 * asset can share a block, and a bare `blockNumber >` would silently drop the
 * second). An EQUAL numeric position advances the row only when the event
 * identity (block/tx hash) differs: that is a reorg replacement, a different
 * chain history occupying the same indices, and treating it as a duplicate
 * would leave an abandoned row dead forever (review r1). Same position, same
 * identity is a re-scanned log and changes nothing.
 */
export function positionAdvancesIntent(
  candidate: VmReverifyIntentPosition,
  existing: VmReverifyIntentPosition,
): boolean {
  const ordering = compareEventPosition(candidate, existing);
  if (ordering !== 0) return ordering > 0;
  return !sameEventIdentity(candidate, existing);
}

/**
 * Does a delivered event redefine the row, GIVEN the row's state?
 *
 * For a PENDING row the answer is pure position ordering — the row is being
 * worked and an older canonical log adds nothing. For an ABANDONED row the
 * rule widens (review r2): a reorg is not obliged to put the replacement at
 * the same — or even a later — numeric position, so ANY event whose chain
 * identity differs from the stored one revives the row. The asymmetry of the
 * failure modes decides this: a spurious revival (a stale rescan of a
 * different, genuinely-canonical older log) costs one idempotent,
 * chain-authoritative re-verification cycle that re-abandons loudly; a missed
 * revival leaves the node governed by an orphaned mutation forever. A rescan
 * re-delivering the SAME event that produced the abandonment is identical by
 * chain identity and stays `unchanged`, so no revival loop is possible.
 */
export function eventRedefinesIntent(
  candidate: VmReverifyIntentPosition,
  existing: VmReverifyIntentPosition,
  existingState: VmReverifyIntentState,
): boolean {
  if (positionAdvancesIntent(candidate, existing)) return true;
  return existingState === 'ABANDONED' && !sameEventIdentity(candidate, existing);
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
  /** Start of the 24 h peer-recovery budget. Set once per generation, on the
   *  first PEER-UNRESOLVED attempt (review r2): time spent behind a disabled
   *  durable plane or missing chain evidence is not the network failing to
   *  serve the version, and must not consume the window that measures that. */
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
   * Idempotent by UAL. A strictly-later position — or an equal position whose
   * event identity differs (a reorg replacement, review r1) — revives an
   * ABANDONED row and resets its attempt budget; an equal-and-identical or
   * earlier position changes nothing and reports `unchanged`, so a re-scanned
   * window costs no log line, no metric and no drain slot.
   */
  upsert(input: VmReverifyIntentUpsertInput): Promise<VmReverifyIntentUpsertResult>;
  /** PENDING rows whose backoff has elapsed, oldest observed event first. */
  listDue(now: number, limit: number): Promise<VmReverifyIntentRecord[]>;
  /** The asset is proven current: the work is done and the row is gone. */
  resolve(ual: string, generation: number): Promise<boolean>;
  /**
   * `startsParkBudget` (review r2): only a genuine peer-unresolved attempt
   * may start the 24 h abandonment window — deferrals behind configuration
   * or evidence failures record the attempt but leave the budget untouched.
   */
  recordAttempt(
    ual: string,
    generation: number,
    lastOutcome: string,
    retryDelayMs: number,
    now: number,
    startsParkBudget: boolean,
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
