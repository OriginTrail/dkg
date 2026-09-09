/**
 * Phase B — chain-driven VM reconciliation orchestration (B.2 sweep + B.4 driver).
 *
 * This is the engine that turns "chain says a KC was registered to a CG" into
 * "that KC is in my VM", built on the per-CG registration-ordinal cursor
 * (`reconcile-cursor.ts`). It is intentionally a thin, side-effect-injected
 * orchestrator so the sweep + watermark + coalescing logic is unit-testable
 * without a chain / libp2p / store harness — the agent supplies the real
 * `reconcileOrdinal` (chain reads + active fetch + `handleChainReconciledKC`)
 * and persistence.
 *
 * The design (settled by the B.0 spike + review):
 *   * **Sweep-driven, not event-driven.** A live `KnowledgeAssetRegisteredToContextGraph`
 *     event is only a low-latency *nudge* to run the sweep for that CG now — it
 *     does not carry the ordinal, so it is never treated as a cursor position.
 *     The periodic/startup sweep is the safety net that guarantees eventual
 *     reconciliation even if a live event was missed or a fetch transiently
 *     failed.
 *   * **Contiguous watermark.** Out-of-order completions are held in the cursor's
 *     `ahead` set until the gap below them fills; the watermark only advances
 *     over a contiguous, confirmation-depth-buried run (see `reconcile-cursor.ts`).
 *   * **Coalesced per CG.** A burst of N events for one CG triggers ONE sweep,
 *     with a single trailing re-run if more events land mid-sweep.
 */

import {
  type CursorState,
  recordCompletion,
  absorbConfirmed,
  ordinalsToReconcile,
} from './reconcile-cursor.js';
export {
  createVmReconcileDispatcherPair,
  VmReconcileDispatcher,
  type VmReconcileDispatcherOptions,
  type VmReconcileDispatcherPair,
} from './vm-reconcile-dispatcher.js';

/**
 * Outcome of attempting to reconcile a single per-CG registration ordinal.
 *   - `reconciled` — promoted to VM this pass; eligible to advance the watermark
 *     once buried by the confirmation depth. Carries the registration block.
 *   - `already`    — already in VM (idempotent); same watermark treatment.
 *   - `pending`    — no local SWM snapshot yet, or on-chain verification not yet
 *     confirmed; leave the ordinal for the next sweep to retry.
 *   - `skip`       — not actionable right now (e.g. couldn't resolve chain data);
 *     leave for the next sweep.
 */
export type OrdinalOutcome =
  | { status: 'reconciled'; blockNumber: number }
  | { status: 'already'; blockNumber: number }
  | { status: 'pending'; recovery?: OrdinalRecoveryTarget }
  | { status: 'skip' };

export interface OrdinalRecoveryTarget {
  localCgId: string;
  onChainCgId: string;
  ordinal: number;
  ual: string;
  merkleRoot: string;
  kaId: string;
  reason: 'no-swm' | 'verified-vm-metadata-pending';
}

export interface PendingOrdinalRecoveryResult {
  /** Revalidated outcomes for ordinals attempted during this recovery pass. */
  outcomes: ReadonlyMap<number, OrdinalOutcome>;
  /** Ordinals whose exact-fetch attempts consumed this pass's recovery budget. */
  attemptedOrdinals: readonly number[];
  /**
   * First target remaining in the ordered recovery queue. This survives a
   * cooldown-only pass so the next network-eligible pass resumes fairly
   * instead of snapping back to the watermark.
   */
  continuationOrdinal: number | undefined;
  /**
   * Recovery has bounded work that should be scheduled immediately. This is
   * deliberately separate from the ordered scan cursor so implementation-
   * specific retries cannot starve untouched ordinals.
   */
  hasImmediateRecoveryWork: boolean;
  /**
   * True only when recovery intentionally skipped networking because its
   * per-CG cooldown is active. This preserves the continuation without
   * scheduling an immediate retry; ordinary no-eligible-peer outcomes keep
   * the fair scan moving through unvisited ordinals.
   */
  cooldownOnly?: boolean;
}

type PendingOrdinalRecoveryDisposition =
  | { kind: 'not-attempted' }
  | { kind: 'cooldown'; continuationOrdinal: number | undefined }
  | { kind: 'ordinal-continuation'; continuationOrdinal: number }
  | { kind: 'provider-continuation' }
  | { kind: 'exhausted' };

/**
 * Normalize the recovery executor's compatibility result once at its boundary.
 * Cursor and scheduling policy consume this semantic state instead of
 * independently interpreting the legacy result fields.
 */
function recoveryDisposition(
  result: PendingOrdinalRecoveryResult,
): PendingOrdinalRecoveryDisposition {
  if (result.cooldownOnly === true) {
    return { kind: 'cooldown', continuationOrdinal: result.continuationOrdinal };
  }
  if (result.attemptedOrdinals.length === 0) return { kind: 'not-attempted' };
  if (result.continuationOrdinal !== undefined) {
    return {
      kind: 'ordinal-continuation',
      continuationOrdinal: result.continuationOrdinal,
    };
  }
  if (result.hasImmediateRecoveryWork) return { kind: 'provider-continuation' };
  return { kind: 'exhausted' };
}

export interface ChainReconcilerDeps {
  /** Chain-head ordinal for the CG (`getContextGraphKCCount`). */
  getKCCount: (onChainCgId: bigint) => Promise<number>;
  /**
   * Current chain head block, for the reorg-depth gate. When `undefined`
   * (no chain / unavailable) the depth gate is disabled for the pass and
   * completed ordinals are absorbed as soon as they're contiguous.
   */
  getHeadBlock: () => Promise<number | undefined>;
  /**
   * Reconcile one ordinal (chain reads + active fetch + locked promotion).
   * `headBlock` is the chain head this sweep observed (or `undefined` with no
   * chain) — the agent reuses it as the materialization version AND echoes it
   * back as the completion's observation block, so the watermark only commits
   * after `confirmationDepth` blocks of real chain progress past observation
   * (reorg-safe without a per-ordinal registration-block lookup).
   */
  reconcileOrdinal: (
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
    headBlock: number | undefined,
  ) => Promise<OrdinalOutcome>;
  /** Maximum ordinals attempted before yielding the global VM worker. */
  maxOrdinalsPerPass?: number;
  /** Maximum ordinal reconciliations allowed to run concurrently in one pass. */
  maxOrdinalConcurrency?: number;
  /**
   * Number of slots in a bounded pass reserved for the newest outstanding
   * ordinals. The remaining slots keep advancing the historical scan cursor.
   *
   * This is intentionally opt-in. Ordinary member/Core reconciliation keeps
   * strict oldest-first behaviour, while an explicitly selected cold Edge can
   * make the current head useful quickly without starving durable history.
   */
  recentOrdinalsPerPass?: number;
  /**
   * Fetch one exact batch containing only locally-missing KAs, then re-run
   * local verification for those ordinals. Undefined preserves scan-only
   * behavior for callers/tests that do not provide network recovery.
   */
  recoverPendingOrdinals?: (
    localCgId: string,
    onChainCgId: bigint,
    targets: readonly OrdinalRecoveryTarget[],
    headBlock: number | undefined,
  ) => Promise<PendingOrdinalRecoveryResult>;
  /**
   * Revalidate the local-CG -> on-chain-CG binding between ordinals. An active
   * pass must stop when discovery repairs a stale/reused chain id.
   */
  isTargetCurrent?: (localCgId: string, onChainCgId: bigint) => boolean | Promise<boolean>;
  /** Persist the watermark. Called ONLY when it actually moves. */
  persistWatermark: (localCgId: string, watermark: number) => void;
  /** Confirmation depth (blocks) before a completed ordinal advances the watermark. */
  confirmationDepth: number;
  log: (msg: string) => void;
}

export interface ReconcileResult {
  head: number;
  watermark: number;
  reconciled: number;
  pending: number;
  processed: number;
  /**
   * True when the bounded inventory has more work under the historical result
   * contract. Retained for package-subpath compatibility; new scheduler code
   * should consume `shouldContinueImmediately` instead.
   * @deprecated Use `shouldContinueImmediately` for dispatch decisions.
   */
  hasMore: boolean;
  /** Canonical two-way scheduling decision after this bounded slice. */
  shouldContinueImmediately: boolean;
  /** True when this pass stopped because its captured chain binding changed. */
  staleTarget: boolean;
}

interface OrdinalPassPlan {
  /** Oldest outstanding ordinals that advance the durable scan cursor. */
  historicalOrdinals: readonly number[];
  /** Newest outstanding ordinals sampled only to reduce head latency. */
  recentOrdinals: readonly number[];
  /** Deterministic ordinal-ordered union used by the reconciliation workers. */
  ordinals: readonly number[];
  /** True when this pass deliberately sampled both ends of the inventory. */
  usesRecentLane: boolean;
  hasUnvisitedCandidates: boolean;
  /** Next cursor derived exclusively from the oldest-side slice. */
  historicalContinuationOrdinal: number;
  /** Priority comparator for the bounded exact-recovery queue. */
  compareRecoveryTargets: (left: OrdinalRecoveryTarget, right: OrdinalRecoveryTarget) => number;
  /** Derive the next durable scan cursor without conflating recovery order. */
  nextScanOrdinal: (input: {
    watermark: number;
    recovery: PendingOrdinalRecoveryDisposition;
  }) => number | undefined;
}

/**
 * Build one bounded ordinal pass without mutating cursor state.
 *
 * The recent lane is a latency sample, not a second cursor. Keeping that
 * distinction explicit prevents a continuation from the recent-first exact
 * recovery queue from jumping the durable historical scan over older gaps.
 */
function planOrdinalPass(
  candidates: readonly number[],
  passLimit: number,
  requestedRecent: number,
  watermark: number,
): OrdinalPassPlan {
  const recentCount = Number.isFinite(passLimit) && passLimit >= 2
    ? Math.min(requestedRecent, passLimit - 1)
    : 0;
  let historicalOrdinals: readonly number[];
  let recentOrdinals: readonly number[] = [];
  if (recentCount > 0 && candidates.length > passLimit) {
    const historicalCount = passLimit - recentCount;
    historicalOrdinals = candidates.slice(0, historicalCount);
    const historicalSet = new Set(historicalOrdinals);
    recentOrdinals = candidates
      .slice(-recentCount)
      .filter((ordinal) => !historicalSet.has(ordinal));
  } else {
    historicalOrdinals = candidates.slice(0, passLimit);
  }
  const ordinals = [...historicalOrdinals, ...recentOrdinals]
    .sort((a, b) => a - b);
  const recentOrdinalSet = new Set(recentOrdinals);
  const usesRecentLane = recentOrdinals.length > 0;
  const hasUnvisitedCandidates = candidates.length > ordinals.length;
  const historicalContinuationOrdinal = historicalOrdinals.length > 0
    ? historicalOrdinals[historicalOrdinals.length - 1]! + 1
    : watermark;
  return {
    historicalOrdinals,
    recentOrdinals,
    ordinals,
    usesRecentLane,
    hasUnvisitedCandidates,
    historicalContinuationOrdinal,
    compareRecoveryTargets: (left, right) => {
      const leftRecent = recentOrdinalSet.has(left.ordinal);
      const rightRecent = recentOrdinalSet.has(right.ordinal);
      if (leftRecent !== rightRecent) return leftRecent ? -1 : 1;
      return leftRecent ? right.ordinal - left.ordinal : left.ordinal - right.ordinal;
    },
    nextScanOrdinal: ({
      watermark: currentWatermark,
      recovery,
    }) => {
      if (usesRecentLane) {
        return hasUnvisitedCandidates
          ? Math.max(currentWatermark, historicalContinuationOrdinal)
          : currentWatermark;
      }
      if (recovery.kind === 'ordinal-continuation') {
        return Math.max(currentWatermark, recovery.continuationOrdinal);
      }
      if (
        recovery.kind === 'cooldown'
        && recovery.continuationOrdinal !== undefined
      ) {
        return Math.max(currentWatermark, recovery.continuationOrdinal);
      }
      if (!hasUnvisitedCandidates) return currentWatermark;
      if (ordinals.length > 0) {
        return Math.max(currentWatermark, historicalContinuationOrdinal);
      }
      return undefined;
    },
  };
}

/**
 * One bounded sweep slice for a single CG: reconcile up to
 * `maxOrdinalsPerPass` ordinals in `[watermark, head)` (skipping ones already
 * completed and held in the cursor), then advance the contiguous,
 * confirmation-depth-buried watermark. Persists the watermark only if it
 * moved. Mutates `state` in place (the agent owns one `CursorState` per CG).
 */
export async function reconcileContextGraph(
  deps: ChainReconcilerDeps,
  state: CursorState,
  localCgId: string,
  onChainCgId: bigint,
): Promise<ReconcileResult> {
  const head = await deps.getKCCount(onChainCgId);
  const before = state.watermark;

  // The persisted contiguous watermark is durable completeness evidence. If
  // it already covers the chain head, avoid the head-block RPC and all ordinal
  // work. A watermark ahead of the observed head is surfaced by the caller as
  // an evidence mismatch, but is equally non-actionable in this pass.
  if (before >= head) {
    state.scanOrdinal = before;
    return {
      head,
      watermark: before,
      reconciled: 0,
      pending: 0,
      processed: 0,
      hasMore: false,
      shouldContinueImmediately: false,
      staleTarget: false,
    };
  }

  // Keep transient head-fetch failures distinct from truly head-less chains.
  // A thrown head read means the chain is temporarily unavailable; skip
  // materialization for this pass so reconcileOrdinal never falls back to a
  // synthetic version block for chain-backed data.
  let headBlock: number | undefined;
  let headUnavailable = false;
  try {
    headBlock = await deps.getHeadBlock();
  } catch (err) {
    headUnavailable = true;
    deps.log(`reconcile ${localCgId}: getHeadBlock failed, holding watermark (${err instanceof Error ? err.message : String(err)})`);
  }

  // Re-absorb any depth-held ordinals as the head advances — a long-running
  // node makes progress on confirmation-depth-blocked ordinals even with no
  // new completions this pass. Skipped when the head is unobservable.
  if (headBlock !== undefined) absorbConfirmed(state, headBlock, deps.confirmationDepth);

  let reconciled = 0;
  let processed = 0;
  let staleTarget = false;
  let recovery: PendingOrdinalRecoveryDisposition = { kind: 'not-attempted' };
  const outstandingBefore = ordinalsToReconcile(state, head);
  const configuredLimit = deps.maxOrdinalsPerPass;
  const passLimit = configuredLimit === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(configuredLimit));
  const scanStart = Math.max(state.watermark, state.scanOrdinal);
  let candidates = outstandingBefore.filter((ordinal) => ordinal >= scanStart);
  if (candidates.length === 0 && outstandingBefore.length > 0) {
    // A prior slice reached the observed head. A later periodic pass starts a
    // fresh cycle from the first still-missing contiguous gap.
    state.scanOrdinal = state.watermark;
    candidates = outstandingBefore;
  }
  const requestedRecent = Number.isFinite(deps.recentOrdinalsPerPass)
    ? Math.max(0, Math.floor(deps.recentOrdinalsPerPass ?? 0))
    : 0;
  const passPlan = planOrdinalPass(
    candidates,
    passLimit,
    requestedRecent,
    state.watermark,
  );
  const {
    ordinals,
    hasUnvisitedCandidates,
  } = passPlan;
  if (headUnavailable) {
    state.scanOrdinal = state.watermark;
  } else {
    const configuredConcurrency = deps.maxOrdinalConcurrency;
    const ordinalConcurrency = configuredConcurrency === undefined
      ? 1
      : Math.max(1, Math.floor(configuredConcurrency));
    const outcomes = new Map<number, OrdinalOutcome>();
    let nextOrdinalIndex = 0;
    let workerFailed = false;
    let workerError: unknown;

    const runOrdinalWorker = async (): Promise<void> => {
      // Contain failures instead of racing them: a thrown ordinal must not
      // leave sibling workers running past this pass's lifetime (their network
      // and store side effects would overlap the caller's retry). The first
      // error stops dispatch across all workers, every in-flight ordinal is
      // drained, and only then does the pass reject with that error.
      try {
        while (!staleTarget && !workerFailed) {
          const index = nextOrdinalIndex;
          nextOrdinalIndex += 1;
          if (index >= ordinals.length) return;

          if (deps.isTargetCurrent && !(await deps.isTargetCurrent(localCgId, onChainCgId))) {
            staleTarget = true;
            return;
          }
          const ordinal = ordinals[index]!;
          const outcome = await deps.reconcileOrdinal(localCgId, onChainCgId, ordinal, headBlock);
          processed += 1;
          if (deps.isTargetCurrent && !(await deps.isTargetCurrent(localCgId, onChainCgId))) {
            staleTarget = true;
            return;
          }
          outcomes.set(ordinal, outcome);
        }
      } catch (error) {
        if (!workerFailed) {
          workerFailed = true;
          workerError = error;
        }
      }
    };

    const workerCount = Math.min(ordinalConcurrency, ordinals.length);
    await Promise.all(Array.from({ length: workerCount }, () => runOrdinalWorker()));
    if (workerFailed) throw workerError;

    const recoveryTargets = ordinals
      .map((ordinal) => outcomes.get(ordinal))
      .filter((outcome): outcome is Extract<OrdinalOutcome, { status: 'pending' }> =>
        outcome?.status === 'pending' && outcome.recovery !== undefined,
      )
      .map((outcome) => outcome.recovery!)
      // The exact-recovery executor has a tighter physical peer/request budget
      // than the ordinal scanner. Spend that scarce budget on the recent slots
      // this selected pass deliberately reserved, then use any remainder for
      // the historical side. Cursor completion is still merged below in
      // ordinal order, so this changes latency rather than correctness.
      .sort(passPlan.compareRecoveryTargets);
    if (!staleTarget && recoveryTargets.length > 0 && deps.recoverPendingOrdinals) {
      const recoveryResult = await deps.recoverPendingOrdinals(
        localCgId,
        onChainCgId,
        recoveryTargets,
        headBlock,
      );
      // Recovery is the longest await in the pass; the binding can be repaired
      // while it runs. Outcomes recovered under the old binding must never
      // advance or persist cursor state for the rebound CG, so re-check before
      // merging and treat staleness exactly like staleness during ordinal work.
      if (deps.isTargetCurrent && !(await deps.isTargetCurrent(localCgId, onChainCgId))) {
        staleTarget = true;
      } else {
        for (const [ordinal, outcome] of recoveryResult.outcomes) {
          outcomes.set(ordinal, outcome);
        }
        recovery = recoveryDisposition(recoveryResult);
      }
    }

    // Cursor state is deliberately updated in ordinal order even though chain
    // reads, store verification, and independent per-KA materializations ran in
    // parallel. This preserves the contiguous-watermark contract and makes the
    // observable result deterministic.
    if (!staleTarget) for (const ordinal of ordinals) {
      const outcome = outcomes.get(ordinal);
      if (!outcome) continue;
      if (outcome.status === 'reconciled' || outcome.status === 'already') {
        reconciled += 1;
        // With a known head, apply the reorg-depth gate; otherwise (no chain
        // head) absorb as soon as contiguous (depth 0) using the registration
        // block as a self-consistent head.
        recordCompletion(
          state,
          { ordinal, blockNumber: outcome.blockNumber },
          headBlock ?? outcome.blockNumber,
          headBlock !== undefined ? deps.confirmationDepth : 0,
        );
      }
    }
  }

  if (staleTarget || headUnavailable) {
    state.scanOrdinal = state.watermark;
  } else {
    // The recovery executor consumes recent targets first and therefore its
    // continuation is ordered by recovery priority, not by chain ordinal. It
    // must never become the durable scan cursor: on a growing graph that would
    // move the cursor near the head and starve the untouched historical gap.
    // Advance only from the oldest-side slice. The recovery continuation still
    // contributes to the continuation decision below, while pending outcomes
    // remain in the inventory and are revisited on a later historical cycle.
    const nextScanOrdinal = passPlan.nextScanOrdinal({
      watermark: state.watermark,
      recovery,
    });
    if (nextScanOrdinal !== undefined) state.scanOrdinal = nextScanOrdinal;
  }

  const pending = ordinalsToReconcile(state, head).length;
  const recoveryAttempted = recovery.kind === 'ordinal-continuation'
    || recovery.kind === 'provider-continuation'
    || recovery.kind === 'exhausted';
  const hasImmediateRecoveryContinuation = recovery.kind === 'ordinal-continuation'
    || recovery.kind === 'provider-continuation';
  const hasMore = !headUnavailable
    && !staleTarget
    && recovery.kind !== 'cooldown'
    && (
      recoveryAttempted
        ? hasImmediateRecoveryContinuation
          || hasUnvisitedCandidates
        : hasUnvisitedCandidates
    );
  const shouldContinueImmediately = staleTarget
    || (hasMore && (reconciled > 0 || hasImmediateRecoveryContinuation));

  if (state.watermark !== before) {
    deps.persistWatermark(localCgId, state.watermark);
    deps.log(`reconcile ${localCgId}: watermark ${before} -> ${state.watermark} (head=${head}, processed=${processed}, reconciled=${reconciled}, pending=${pending})`);
  } else if (reconciled > 0 || pending > 0) {
    deps.log(`reconcile ${localCgId}: watermark held at ${state.watermark} (head=${head}, processed=${processed}, reconciled=${reconciled}, pending=${pending}${headUnavailable ? ', headUnavailable' : ''})`);
  }

  return {
    head,
    watermark: state.watermark,
    reconciled,
    pending,
    processed,
    hasMore,
    shouldContinueImmediately,
    staleTarget,
  };
}


/**
 * Bounded LRU-ish dedupe set for recently-reconciled UALs, so a burst of
 * live events for the same KA doesn't trigger redundant chain reads / fetches
 * within a short window. Insertion-ordered eviction (Map keeps insertion order).
 */
export class RecentUalSet {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 1000) {}

  has(ual: string): boolean {
    return this.seen.has(ual);
  }

  add(ual: string): void {
    if (this.seen.has(ual)) return;
    this.seen.set(ual, Date.now());
    if (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  deleteByPrefix(prefix: string, except?: string): void {
    for (const key of this.seen.keys()) {
      if (key !== except && key.startsWith(prefix)) this.seen.delete(key);
    }
  }
}
