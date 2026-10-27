// SPDX-License-Identifier: Apache-2.0
import type { GraphScopedDurableManifestPlan, GraphScopedDescriptor } from '../durable-integrity.js';
import type { GraphOwnedRecoveryContext } from './graph-owned-recovery.js';
import type { HeldAssetsProof } from './held-assets-contracts.js';
import type { DurableSyncContext } from './durable-sync.js';
import { planDurableDataFromLocalHoldings, type DurableHoldingsPlan } from './durable-data-holdings.js';

type HoldingsPhaseContext = Pick<DurableSyncContext, 'ctx' | 'signal' | 'logWarn'>;

export interface PreparedHoldingsProof {
  readonly manifest: GraphScopedDurableManifestPlan;
  readonly proof: HeldAssetsProof;
  assertOwnership(): void;
}
export interface PreparedHoldingsSettlement extends PreparedHoldingsProof {
  readonly plan: Exclude<DurableHoldingsPlan, { kind: 'full' }>;
  readonly descriptors: readonly GraphScopedDescriptor[];
}
type PreparedHoldingsPhase =
  | { readonly kind: 'fetch'; readonly continuation: 'full-graph' | 'reconsider-holdings'; readonly contentProof?: PreparedHoldingsProof }
  | { readonly kind: 'metadata'; readonly settlement: PreparedHoldingsSettlement };

/** Select a DATA plan. A successful held proof transfers to the graph execution scope. */
export async function prepareDurableHoldingsPhase(input: {
  readonly context: HoldingsPhaseContext;
  readonly contextGraphId: string;
  readonly manifest: GraphScopedDurableManifestPlan | null;
  readonly recovery: GraphOwnedRecoveryContext;
}): Promise<PreparedHoldingsPhase> {
  const fetch = (continuation: 'full-graph' | 'reconsider-holdings'): PreparedHoldingsPhase => ({ kind: 'fetch', continuation });
  const full = fetch('full-graph');
  const { context, contextGraphId, manifest, recovery } = input;
  const held = recovery.held;
  if (!manifest) return full;
  if (!held) return full;
  let proof;
  try { proof = await held.prove({ contextGraphId, descriptors: manifest.descriptors, signal: context.signal }); }
  catch (error) {
    context.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    context.logWarn(context.ctx, `Could not prove held content for "${contextGraphId}": ${String(error)}`);
    return fetch('reconsider-holdings');
  }
  if (!proof) return full;
  let transferred = false;
  try {
    const assertCurrent = () => { held.assertCurrent(); proof.assertCurrent(); };
    const fetchWithProof = (continuation: 'full-graph' | 'reconsider-holdings'): PreparedHoldingsPhase => {
      assertCurrent();
      if (proof.held.size === 0) return fetch(continuation);
      transferred = true;
      return { kind: 'fetch', continuation,
        contentProof: { manifest, proof, assertOwnership: () => held.assertCurrent() } };
    };
    assertCurrent();
    const plan = await planDurableDataFromLocalHoldings({
      contextGraphId, manifest, options: recovery.holdings, held: proof.held, confirmCurrent: held.confirmCurrent,
      signal: context.signal, logWarn: message => context.logWarn(context.ctx, message),
    });
    if (plan.kind === 'full') return fetchWithProof(plan.continuation);
    assertCurrent();
    try {
      context.signal?.throwIfAborted();
      await proof.reconcile?.(context.ctx);
    } catch (error) {
      context.signal?.throwIfAborted();
      assertCurrent();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      context.logWarn(context.ctx, `Could not reconcile held content for "${contextGraphId}": ${String(error)}`);
      return fetchWithProof('reconsider-holdings');
    }
    assertCurrent(); context.signal?.throwIfAborted();
    const descriptors = manifest.descriptors.filter(copy => proof.held.has(copy.ual));
    transferred = true;
    return { kind: 'metadata',
      settlement: { manifest, plan, descriptors, proof, assertOwnership: () => held.assertCurrent() } };
  } finally { if (!transferred) proof.close(); }
}
