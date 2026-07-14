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
 * Per-CG, source-aware single-flight scheduling policy for VM reconciliation.
 *
 * Live chain events are latency nudges, while the periodic sweep is the
 * reliability path. After a failed VM pass, live nudges for that CG are held so
 * they cannot hot-loop the same expensive store/RPC work. The next periodic
 * sweep explicitly releases the hold and retries. Failure logging also lives at
 * this scheduling boundary; the domain operation remains a normal rejecting
 * async function. Each key has one prioritized queued source and an explicit
 * live-failure hold, so invalid combinations of pending flags are impossible.
 * This is the single owner of per-key coalescing semantics: a burst produces at
 * most one trailing pass, with periodic work taking priority over live nudges.
 * Trigger methods are deliberately fire-and-forget; callers that need an
 * completion boundary must use waitForIdle() explicitly.
 */
type VmReconcileTriggerSource = 'live' | 'periodic';
type VmReconcileHold = 'ready' | 'live-blocked';

interface VmReconcileScheduleState {
  inFlight?: Promise<void>;
  queued: VmReconcileTriggerSource | null;
  hold: VmReconcileHold;
}

export class VmReconcileScheduler {
  private readonly states = new Map<string, VmReconcileScheduleState>();

  constructor(
    private readonly run: (key: string) => Promise<void>,
    private readonly onFailure: (key: string, error: unknown) => void,
  ) {}

  /** Enqueue a low-latency chain-event nudge; suppressed until a sweep after failure. */
  triggerLive(key: string): void {
    this.enqueue(key, 'live');
  }

  /** Enqueue the reliability path; every periodic sweep gets one failure retry. */
  triggerPeriodic(key: string): void {
    this.enqueue(key, 'periodic');
  }

  isInFlight(key: string): boolean {
    return this.states.get(key)?.inFlight !== undefined;
  }

  /** Wait for the active pass and every trailing pass already queued for this key. */
  async waitForIdle(key: string): Promise<void> {
    while (true) {
      const inFlight = this.states.get(key)?.inFlight;
      if (!inFlight) return;
      await inFlight;
    }
  }

  private stateFor(key: string): VmReconcileScheduleState {
    let state = this.states.get(key);
    if (!state) {
      state = {
        queued: null,
        hold: 'ready',
      };
      this.states.set(key, state);
    }
    return state;
  }

  private enqueue(key: string, source: VmReconcileTriggerSource): void {
    const state = this.stateFor(key);
    if (source === 'live' && state.hold === 'live-blocked') {
      return;
    }
    if (state.inFlight) {
      // A periodic reliability pass always replaces a queued live nudge.
      // Otherwise repeated triggers collapse into the existing queued source.
      if (state.queued !== 'periodic') state.queued = source;
      return;
    }
    if (source === 'periodic') state.hold = 'ready';
    this.start(key, state);
  }

  private start(key: string, state: VmReconcileScheduleState): void {
    const promise = (async () => {
      try {
        await this.run(key);
        state.hold = 'ready';
      } catch (error) {
        state.hold = 'live-blocked';
        try {
          this.onFailure(key, error);
        } catch {
          // Observability must never break scheduling or surface to callers.
        }
      }
    })().finally(() => {
      state.inFlight = undefined;
      const queued = state.queued;
      state.queued = null;
      if (queued) {
        this.enqueue(key, queued);
        return;
      }
      // Keep only failed keys so a later live nudge remains suppressed. A
      // periodic retry or successful run releases and removes the state.
      if (state.hold === 'ready') this.states.delete(key);
    });
    state.inFlight = promise;
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
