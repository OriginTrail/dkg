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
  isOrdinalBackedOff,
  recordOrdinalBackoff,
  clearOrdinalBackoff,
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
  /**
   * Clock (ms since epoch). Injectable for tests; defaults to `Date.now`. Used
   * only for the per-ordinal skip-backoff window (#1609).
   */
  now?: () => number;
}

export interface ReconcileResult {
  head: number;
  watermark: number;
  reconciled: number;
  pending: number;
  /**
   * Ordinals skipped this pass because they are inside an active skip-backoff
   * window (they are still counted in `pending` — they block the watermark).
   */
  backedOff: number;
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

  const now = deps.now?.() ?? Date.now();
  let reconciled = 0;
  let pending = 0;
  let backedOff = 0;
  const ordinals = ordinalsToReconcile(state, head);
  if (headUnavailable) {
    pending = ordinals.length;
  } else {
    for (const ordinal of ordinals) {
      if (isOrdinalBackedOff(state, ordinal, now)) {
        // Inside an active skip-backoff window: still pending (it blocks the
        // watermark), but don't re-run the expensive reconcile this pass — a
        // never-matching ordinal must not be re-probed on every sweep (#1609).
        pending += 1;
        backedOff += 1;
        continue;
      }
      const outcome = await deps.reconcileOrdinal(localCgId, onChainCgId, ordinal, headBlock);
      if (outcome.status === 'reconciled' || outcome.status === 'already') {
        reconciled += 1;
        clearOrdinalBackoff(state, ordinal);
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
        // `pending`/`skip` both mean "not actionable this pass, retry later"
        // (no local SWM snapshot yet, or a transient chain-read failure) — grow
        // the backoff so the next sweeps don't immediately re-run the search.
        recordOrdinalBackoff(state, ordinal, now);
      }
    }
  }

  if (state.watermark !== before) {
    deps.persistWatermark(localCgId, state.watermark);
    deps.log(`reconcile ${localCgId}: watermark ${before} -> ${state.watermark} (head=${head}, reconciled=${reconciled}, pending=${pending}, backedOff=${backedOff})`);
  } else if (reconciled > 0 || pending > 0) {
    deps.log(`reconcile ${localCgId}: watermark held at ${state.watermark} (head=${head}, reconciled=${reconciled}, pending=${pending}, backedOff=${backedOff}${headUnavailable ? ', headUnavailable' : ''})`);
  }

  return { head, watermark: state.watermark, reconciled, pending, backedOff };
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
