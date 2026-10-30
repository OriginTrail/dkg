// SPDX-License-Identifier: Apache-2.0
import type { GraphScopedDurableManifestPlan, GraphScopedDescriptor } from '../durable-integrity.js';
import type { VerifiedDurableBoundary } from '../durable-recovery-boundary-seed.js';
import type { GraphOwnedRecoveryContext } from './graph-owned-recovery.js';
import type { DurableGraphSettlementGuard } from './durable-prefix-proof.js';
import type { DurableSyncContext } from './durable-sync.js';
import { HeldGenerationNotCurrentError, planDurableDataFromHoldings, type DurableDataStrategy } from './durable-data-holdings.js';

type HoldingsPhaseContext = Pick<DurableSyncContext, 'ctx' | 'signal' | 'logWarn'>;

export type PreparedDurableDataStrategy = DurableDataStrategy<{
  readonly manifest: GraphScopedDurableManifestPlan;
  readonly descriptors: readonly GraphScopedDescriptor[];
}, {
  readonly continuation: 'full-graph' | 'reconsider-holdings';
  readonly boundary?: VerifiedDurableBoundary;
}>;

/** Select a DATA plan using evidence borrowed from the graph settlement scope. */
export async function prepareDurableHoldingsPhase(input: {
  readonly context: HoldingsPhaseContext;
  readonly contextGraphId: string;
  readonly manifest: GraphScopedDurableManifestPlan | null;
  readonly recovery: GraphOwnedRecoveryContext;
  readonly settlement: Pick<DurableGraphSettlementGuard, 'proveHoldings' | 'assertCurrent'>;
}): Promise<PreparedDurableDataStrategy> {
  const fetch = (continuation: 'full-graph' | 'reconsider-holdings'): PreparedDurableDataStrategy => ({ kind: 'full', held: 0, continuation });
  const { context, contextGraphId, manifest, recovery, settlement } = input;
  const held = recovery.held;
  context.signal?.throwIfAborted();
  if (!manifest || !held || recovery.holdings.skipHoldingsPreflight) return fetch('full-graph');
  try {
    const proof = await settlement.proveHoldings(manifest, context.signal);
    if (!proof) return fetch('full-graph');
    const plan = planDurableDataFromHoldings(manifest, proof.held, recovery.holdings.ownerFetchesMissingAssets === true);
    // Full DATA rounds authenticate every fetched asset; only shortcuts need held-copy chain evidence.
    if (plan.kind !== 'full') await held.confirmCurrent({
      contextGraphId, descriptors: manifest.descriptors, signal: context.signal,
    }, proof.held, { reuseIntermediateConfirmations: plan.kind === 'fetch-missing' });
    settlement.assertCurrent();
    if (plan.kind === 'full') return { ...plan, continuation: 'full-graph' };
    await proof.reconcile?.(context.ctx);
    settlement.assertCurrent();
    const descriptors = manifest.descriptors.filter(copy => proof.held.has(copy.ual));
    return { ...plan, manifest, descriptors };
  } catch (error) {
    context.signal?.throwIfAborted();
    // Invalidated content or ownership must fail the round, even when another preflight operation also failed.
    settlement.assertCurrent();
    if (error instanceof HeldGenerationNotCurrentError || (error instanceof Error && error.name === 'AbortError')) throw error;
    context.logWarn(context.ctx, `Could not establish held content for "${contextGraphId}"; fetching the graph: ${String(error)}`);
    return fetch('reconsider-holdings');
  }
}
