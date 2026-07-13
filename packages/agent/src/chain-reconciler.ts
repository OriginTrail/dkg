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
  | { status: 'pending' }
  | { status: 'skip' };

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
}

/**
 * One sweep pass for a single CG: reconcile every ordinal in `[watermark, head)`
 * (skipping ones already completed and held in the cursor), then advance the
 * contiguous, confirmation-depth-buried watermark. Persists the watermark only
 * if it moved. Mutates `state` in place (the agent owns one `CursorState` per CG).
 */
export async function reconcileContextGraph(
  deps: ChainReconcilerDeps,
  state: CursorState,
  localCgId: string,
  onChainCgId: bigint,
): Promise<ReconcileResult> {
  const head = await deps.getKCCount(onChainCgId);
  const before = state.watermark;

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
  let pending = 0;
  const ordinals = ordinalsToReconcile(state, head);
  if (headUnavailable) {
    pending = ordinals.length;
  } else {
    for (const ordinal of ordinals) {
      const outcome = await deps.reconcileOrdinal(localCgId, onChainCgId, ordinal, headBlock);
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
      } else {
        pending += 1;
      }
    }
  }

  if (state.watermark !== before) {
    deps.persistWatermark(localCgId, state.watermark);
    deps.log(`reconcile ${localCgId}: watermark ${before} -> ${state.watermark} (head=${head}, reconciled=${reconciled}, pending=${pending})`);
  } else if (reconciled > 0 || pending > 0) {
    deps.log(`reconcile ${localCgId}: watermark held at ${state.watermark} (head=${head}, reconciled=${reconciled}, pending=${pending}${headUnavailable ? ', headUnavailable' : ''})`);
  }

  return { head, watermark: state.watermark, reconciled, pending };
}

/**
 * Per-key single-flight coalescer: a burst of triggers for the same key runs
 * the action ONCE, with a single trailing re-run if new triggers arrive while
 * a run is in flight (so events that land mid-sweep aren't lost). Used so N
 * KACG events for one CG cause one sweep (+ at most one trailing sweep), not N.
 */
export class ReconcileCoalescer {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();

  constructor(private readonly run: (key: string) => Promise<void>) {}

  trigger(key: string): Promise<void> {
    const existing = this.inFlight.get(key);
    if (existing) {
      // A run is in flight — mark that one more pass is needed after it.
      this.again.add(key);
      return existing;
    }
    const promise = this.run(key)
      .catch(() => { /* run is responsible for its own logging */ })
      .finally(() => {
        this.inFlight.delete(key);
        if (this.again.delete(key)) void this.trigger(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  /** True if a run for `key` is currently in flight. */
  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }
}

/**
 * VM-specific scheduling policy around the generic single-flight coalescer.
 *
 * Live chain events are latency nudges, while the periodic sweep is the
 * reliability path. After a failed VM pass, live nudges for that CG are held so
 * they cannot hot-loop the same expensive store/RPC work. The next periodic
 * sweep explicitly releases the hold and retries. Failure logging also lives at
 * this scheduling boundary; the domain operation remains a normal rejecting
 * async function and the generic coalescer remains policy-free.
 */
export class VmReconcileScheduler {
  private readonly liveBlocked = new Set<string>();
  private readonly coalescer: ReconcileCoalescer;

  constructor(
    run: (key: string) => Promise<void>,
    onFailure: (key: string, error: unknown) => void,
  ) {
    this.coalescer = new ReconcileCoalescer(async (key) => {
      // A failed in-flight pass may already have a trailing live nudge queued
      // inside the coalescer. Consume that trailing pass without re-running the
      // expensive domain operation.
      if (this.liveBlocked.has(key)) return;
      try {
        await run(key);
        this.liveBlocked.delete(key);
      } catch (error) {
        this.liveBlocked.add(key);
        onFailure(key, error);
      }
    });
  }

  /** Low-latency chain-event nudge; suppressed after failure until a sweep. */
  triggerLive(key: string): Promise<void> {
    if (this.liveBlocked.has(key)) return Promise.resolve();
    return this.coalescer.trigger(key);
  }

  /** Reliability path; every periodic sweep gets one retry after a failure. */
  triggerPeriodic(key: string): Promise<void> {
    this.liveBlocked.delete(key);
    return this.coalescer.trigger(key);
  }

  isInFlight(key: string): boolean {
    return this.coalescer.isInFlight(key);
  }
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
