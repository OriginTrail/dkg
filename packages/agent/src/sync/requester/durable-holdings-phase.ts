// SPDX-License-Identifier: Apache-2.0
import type { GraphScopedDurableManifestPlan } from '../durable-integrity.js';
import type { DurableSyncAccumulator } from '../durable-progress.js';
import type { DurableRecoveryRoundDecision } from '../durable-recovery-round.js';
import type { GraphOwnedRecoveryContext } from './graph-owned-recovery.js';
import type { DurableSyncContext } from './durable-sync.js';
import type { SyncPageResult } from './page-fetch.js';
import { planDurableDataFromLocalHoldings, settleDurableDataFromHoldings } from './durable-data-holdings.js';
import { persistDurableHoldingsMetadata } from './durable-verified-page.js';

type HoldingsPhaseContext = Parameters<typeof persistDurableHoldingsMetadata>[0]
  & Pick<DurableSyncContext, 'remotePeerId' | 'deleteCheckpoint' | 'setCheckpoint' | 'logInfo' | 'logWarn'>;

/** Own the complete held attempt, including proof lifetime and synchronous settlement.
 * Every path returns one round decision; no callback communicates a decision.
 */
export async function attemptDurableHoldingsPhase(input: {
  readonly context: HoldingsPhaseContext;
  readonly contextGraphId: string;
  readonly manifest: GraphScopedDurableManifestPlan | null;
  readonly recovery: GraphOwnedRecoveryContext;
  readonly meta: SyncPageResult;
  readonly accumulator: DurableSyncAccumulator;
  readonly recordMetaPhase: () => void;
}): Promise<DurableRecoveryRoundDecision> {
  const full: DurableRecoveryRoundDecision = { strategy: 'full', continuation: 'full-graph' };
  const { context, contextGraphId, manifest, recovery, meta, accumulator } = input;
  const held = recovery.held;
  if (!manifest) return { strategy: 'legacy' };
  if (!held) return full;
  let proof;
  try { proof = await held.prove({ contextGraphId, descriptors: manifest.descriptors, signal: context.signal }); }
  catch (error) {
    context.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    context.logWarn(context.ctx, `Could not prove held content for "${contextGraphId}": ${String(error)}`);
    return { strategy: 'full', continuation: 'reconsider-holdings' };
  }
  if (!proof) return full;
  try {
    const assertCurrent = () => { held.assertCurrent(); proof.assertCurrent(); };
    assertCurrent();
    const plan = await planDurableDataFromLocalHoldings({
      contextGraphId, manifest, options: recovery.holdings, held: proof.held, confirmCurrent: held.confirmCurrent,
      signal: context.signal, logWarn: message => context.logWarn(context.ctx, message),
    });
    if (plan.kind === 'full') return { strategy: 'full', continuation: plan.continuation };
    assertCurrent();
    try {
      context.signal?.throwIfAborted();
      await held.reconcile?.({ contextGraphId, descriptors: manifest.descriptors, signal: context.signal }, proof.held);
    } catch (error) {
      context.signal?.throwIfAborted();
      assertCurrent();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      context.logWarn(context.ctx, `Could not reconcile held content for "${contextGraphId}": ${String(error)}`);
      return { strategy: 'full', continuation: 'reconsider-holdings' };
    }
    assertCurrent(); context.signal?.throwIfAborted();
    await persistDurableHoldingsMetadata(context, contextGraphId, meta, accumulator, assertCurrent);
    assertCurrent();
    input.recordMetaPhase();
    context.logInfo(context.ctx, settleDurableDataFromHoldings({
      plan, remotePeerId: context.remotePeerId, contextGraphId, manifest, metaResult: meta,
      accumulator, deleteCheckpoint: context.deleteCheckpoint, setCheckpoint: context.setCheckpoint,
    }));
    return plan.kind === 'held'
      ? { strategy: 'held' }
      : { strategy: 'exact-missing', batches: plan.batches };
  } finally { proof.close(); }
}
