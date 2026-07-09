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
  type CompletedOrdinal,
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
  | { status: 'reconciled'; blockNumber: number; assetUal?: string; kaId?: string }
  | { status: 'already'; blockNumber: number; assetUal?: string; kaId?: string }
  | { status: 'pending'; assetUal?: string; kaId?: string; reason?: string }
  | { status: 'skip'; assetUal?: string; kaId?: string; reason?: string };

export type ReconcileLifecycleAction = 'sweep' | 'promote' | 'already-present' | 'defer' | 'cursor-advance';

export interface ReconcileLifecycleEvent {
  assetUal: string;
  action: ReconcileLifecycleAction;
  result: string;
  localCgId: string;
  onChainCgId: string;
  ordinal: number;
  kaId?: string;
  blockNumber?: number;
  head: number;
  watermark: number;
  fromWatermark?: number;
  toWatermark?: number;
  reason?: string;
}

export interface ReconciledAssetDecision {
  assetUal: string;
  status: OrdinalOutcome['status'];
  localCgId: string;
  onChainCgId: string;
  ordinal: number;
  kaId?: string;
  blockNumber?: number;
  reason?: string;
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
  /** Persist the watermark. Called ONLY when it actually moves. */
  persistWatermark: (localCgId: string, watermark: number) => void;
  logLifecycle?: (event: ReconcileLifecycleEvent) => void;
  /** Confirmation depth (blocks) before a completed ordinal advances the watermark. */
  confirmationDepth: number;
  log: (msg: string) => void;
}

export interface ReconcileResult {
  head: number;
  watermark: number;
  reconciled: number;
  pending: number;
  assets: ReconciledAssetDecision[];
}

interface CursorAssetMetadata {
  assetUal: string;
  kaId?: string;
}

const cursorAssetMetadata = new WeakMap<CursorState, Map<number, CursorAssetMetadata>>();

function metadataForCursor(state: CursorState): Map<number, CursorAssetMetadata> {
  let metadata = cursorAssetMetadata.get(state);
  if (!metadata) {
    metadata = new Map();
    cursorAssetMetadata.set(state, metadata);
  }
  return metadata;
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

  let reconciled = 0;
  let pending = 0;
  const assets: ReconciledAssetDecision[] = [];
  const cursorAdvancedAssets: Array<{
    assetUal: string;
    ordinal: number;
    kaId?: string;
    blockNumber?: number;
  }> = [];
  const cursorMetadata = metadataForCursor(state);
  const trackCursorAdvancedAsset = (completion: CompletedOrdinal): void => {
    const metadata = cursorMetadata.get(completion.ordinal);
    if (!metadata) return;
    cursorMetadata.delete(completion.ordinal);
    cursorAdvancedAssets.push({
      assetUal: metadata.assetUal,
      ordinal: completion.ordinal,
      ...(metadata.kaId ? { kaId: metadata.kaId } : {}),
      blockNumber: completion.blockNumber,
    });
  };

  // Re-absorb any depth-held ordinals as the head advances — a long-running
  // node makes progress on confirmation-depth-blocked ordinals even with no
  // new completions this pass. Skipped when the head is unobservable.
  if (headBlock !== undefined) absorbConfirmed(state, headBlock, deps.confirmationDepth, trackCursorAdvancedAsset);

  const ordinals = ordinalsToReconcile(state, head);
  if (headUnavailable) {
    pending = ordinals.length;
  } else {
    for (const ordinal of ordinals) {
      const outcome = await deps.reconcileOrdinal(localCgId, onChainCgId, ordinal, headBlock);
      if (outcome.assetUal) {
        const blockNumber = 'blockNumber' in outcome ? outcome.blockNumber : undefined;
        const reason = 'reason' in outcome ? outcome.reason : undefined;
        assets.push({
          assetUal: outcome.assetUal,
          status: outcome.status,
          localCgId,
          onChainCgId: onChainCgId.toString(),
          ordinal,
          kaId: outcome.kaId,
          blockNumber,
          reason,
        });
        deps.logLifecycle?.({
          assetUal: outcome.assetUal,
          action: 'sweep',
          result: 'scanned',
          localCgId,
          onChainCgId: onChainCgId.toString(),
          ordinal,
          kaId: outcome.kaId,
          blockNumber,
          head,
          watermark: state.watermark,
          reason,
        });
        const action = lifecycleActionForOutcome(outcome.status);
        if (action) {
          deps.logLifecycle?.({
            assetUal: outcome.assetUal,
            action,
            result: outcome.status,
            localCgId,
            onChainCgId: onChainCgId.toString(),
            ordinal,
            kaId: outcome.kaId,
            blockNumber,
            head,
            watermark: state.watermark,
            reason,
          });
        }
      }
      if (outcome.status === 'reconciled' || outcome.status === 'already') {
        reconciled += 1;
        if (outcome.assetUal) {
          cursorMetadata.set(ordinal, {
            assetUal: outcome.assetUal,
            ...(outcome.kaId ? { kaId: outcome.kaId } : {}),
          });
        }
        // With a known head, apply the reorg-depth gate; otherwise (no chain
        // head) absorb as soon as contiguous (depth 0) using the registration
        // block as a self-consistent head.
        recordCompletion(
          state,
          {
            ordinal,
            blockNumber: outcome.blockNumber,
          },
          headBlock ?? outcome.blockNumber,
          headBlock !== undefined ? deps.confirmationDepth : 0,
          trackCursorAdvancedAsset,
        );
      } else {
        pending += 1;
      }
    }
  }

  if (state.watermark !== before) {
    deps.persistWatermark(localCgId, state.watermark);
    for (const asset of cursorAdvancedAssets) {
      if (asset.ordinal < before || asset.ordinal >= state.watermark) continue;
      deps.logLifecycle?.({
        assetUal: asset.assetUal,
        action: 'cursor-advance',
        result: 'advanced',
        localCgId,
        onChainCgId: onChainCgId.toString(),
        ordinal: asset.ordinal,
        kaId: asset.kaId,
        blockNumber: asset.blockNumber,
        head,
        watermark: state.watermark,
        fromWatermark: before,
        toWatermark: state.watermark,
      });
    }
    deps.log(`reconcile ${localCgId}: watermark ${before} -> ${state.watermark} (head=${head}, reconciled=${reconciled}, pending=${pending})`);
  } else if (reconciled > 0 || pending > 0) {
    deps.log(`reconcile ${localCgId}: watermark held at ${state.watermark} (head=${head}, reconciled=${reconciled}, pending=${pending}${headUnavailable ? ', headUnavailable' : ''})`);
  }

  return { head, watermark: state.watermark, reconciled, pending, assets };
}

function lifecycleActionForOutcome(status: OrdinalOutcome['status']): ReconcileLifecycleAction | undefined {
  switch (status) {
    case 'reconciled':
      return 'promote';
    case 'already':
      return 'already-present';
    case 'pending':
      return 'defer';
    case 'skip':
      return undefined;
  }
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
