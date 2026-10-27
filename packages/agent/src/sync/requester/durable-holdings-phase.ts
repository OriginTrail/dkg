// SPDX-License-Identifier: Apache-2.0
import type { GraphScopedDurableManifestPlan, GraphScopedDescriptor } from '../durable-integrity.js';
import type { GraphOwnedRecoveryContext } from './graph-owned-recovery.js';
import type { DurableGraphSettlementGuard } from './durable-prefix-proof.js';
import type { DurableSyncContext } from './durable-sync.js';
import { planDurableDataFromLocalHoldings, type DurableHoldingsPlan } from './durable-data-holdings.js';

type HoldingsPhaseContext = Pick<DurableSyncContext, 'ctx' | 'signal' | 'logWarn'>;

export interface PreparedHoldingsSettlement {
  readonly manifest: GraphScopedDurableManifestPlan;
  readonly plan: Exclude<DurableHoldingsPlan, { kind: 'full' }>;
  readonly descriptors: readonly GraphScopedDescriptor[];
}
type PreparedHoldingsPhase =
  | { readonly kind: 'fetch'; readonly continuation: 'full-graph' | 'reconsider-holdings' }
  | { readonly kind: 'metadata'; readonly settlement: PreparedHoldingsSettlement };

/** Select a DATA plan using evidence borrowed from the graph settlement scope. */
export async function prepareDurableHoldingsPhase(input: {
  readonly context: HoldingsPhaseContext;
  readonly contextGraphId: string;
  readonly manifest: GraphScopedDurableManifestPlan | null;
  readonly recovery: GraphOwnedRecoveryContext;
  readonly settlement: Pick<DurableGraphSettlementGuard, 'proveHoldings' | 'assertCurrent'>;
}): Promise<PreparedHoldingsPhase> {
  const fetch = (continuation: 'full-graph' | 'reconsider-holdings'): PreparedHoldingsPhase => ({ kind: 'fetch', continuation });
  const { context, contextGraphId, manifest, recovery, settlement } = input;
  const held = recovery.held;
  if (!manifest || !held) return fetch('full-graph');
  let proof;
  try { proof = await settlement.proveHoldings(manifest, context.signal); }
  catch (error) {
    context.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    context.logWarn(context.ctx, `Could not prove held content for "${contextGraphId}": ${String(error)}`);
    return fetch('reconsider-holdings');
  }
  if (!proof) return fetch('full-graph');
  const plan = await planDurableDataFromLocalHoldings({
    contextGraphId, manifest, options: recovery.holdings, held: proof.held, confirmCurrent: held.confirmCurrent,
    signal: context.signal, logWarn: message => context.logWarn(context.ctx, message),
  });
  settlement.assertCurrent();
  if (plan.kind === 'full') return fetch(plan.continuation);
  try { await proof.reconcile?.(context.ctx); }
  catch (error) {
    context.signal?.throwIfAborted(); settlement.assertCurrent();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    context.logWarn(context.ctx, `Could not reconcile held content for "${contextGraphId}": ${String(error)}`);
    return fetch('reconsider-holdings');
  }
  settlement.assertCurrent();
  const descriptors = manifest.descriptors.filter(copy => proof.held.has(copy.ual));
  return { kind: 'metadata', settlement: { manifest, plan, descriptors } };
}
