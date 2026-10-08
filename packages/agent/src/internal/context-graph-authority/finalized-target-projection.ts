// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphAuthorityReadOptions, ContextGraphAuthoritySnapshot, ContextGraphAuthorityIndexRevisionReader } from '@origintrail-official/dkg-chain';
import type { ContextGraphBindingState } from '../../context-graph-binding-state.js';
import type { DurableContextGraphSubscriptionBinding } from '../../dkg-agent-types.js';
import type { FinalizedContextGraphAuthorityTargetV1, FinalizedContextGraphAuthorityTargetsResolutionV1 } from '../../dkg-agent-cg-registry.js';
import { resolveFinalizedContextGraphNameBindingV1, type FinalizedContextGraphNameBindingSourceV1 } from './finalized-context-graph-binding.js';

type BindingTarget = Readonly<{ contextGraphId: string; expectedNameHash: string; expectedOnChainId?: bigint }>;
export function finalizedTargetPlan(
  source: FinalizedContextGraphNameBindingSourceV1,
  authorityId: ContextGraphBindingState['authorityIndexOnChainIdFor'],
  contextGraphIds: readonly string[],
  hints?: ReadonlyMap<string, Readonly<DurableContextGraphSubscriptionBinding>>,
) {
  const targets = new Map<string, FinalizedContextGraphAuthorityTargetV1>();
  const reverseBindingTargets: BindingTarget[] = [];
  for (const contextGraphId of new Set(contextGraphIds)) {
    const hint = hints?.get(contextGraphId);
    const durableHint = hint?.contextGraphId === contextGraphId ? hint : undefined;
    const { localId, subscription, expectedNameHash } = resolveFinalizedContextGraphNameBindingV1(source, contextGraphId, durableHint);
    const id = authorityId(localId, subscription ?? durableHint);
    if (id === undefined) reverseBindingTargets.push({ contextGraphId, expectedNameHash });
    else targets.set(contextGraphId, Object.freeze({ kind: 'durable-binding', expectedNameHash, expectedOnChainId: BigInt(id) }));
  }
  return { targets, reverseBindingTargets };
}

export function projectFinalizedTargets(
  plan: ReturnType<typeof finalizedTargetPlan>, snapshots: ReadonlyMap<string, ContextGraphAuthoritySnapshot>,
): FinalizedContextGraphAuthorityTargetsResolutionV1 {
  for (const { contextGraphId, expectedNameHash } of plan.reverseBindingTargets) {
    const finalizedSnapshot = snapshots.get(expectedNameHash);
    if (finalizedSnapshot !== undefined) plan.targets.set(contextGraphId, Object.freeze({
      kind: 'resolved-snapshot', expectedNameHash, expectedOnChainId: BigInt(finalizedSnapshot.contextGraphId), finalizedSnapshot,
    }));
  }
  return { kind: 'finalized-index', targets: plan.targets };
}

/** An explicit local-read capability; no normal-reader fallback or circuit policy. */
export async function peekFinalizedTargets(
  plan: ReturnType<typeof finalizedTargetPlan>,
  reader: ContextGraphAuthorityIndexRevisionReader | undefined, options: ContextGraphAuthorityReadOptions,
): Promise<FinalizedContextGraphAuthorityTargetsResolutionV1 | undefined> {
  options.signal?.throwIfAborted();
  if (plan.reverseBindingTargets.length === 0) return { kind: 'finalized-index', targets: plan.targets };
  const snapshots = await reader?.peekFinalizedContextGraphAuthoritySnapshotsByNameHashes?.(
    plan.reverseBindingTargets.map(target => target.expectedNameHash), options,
  );
  options.signal?.throwIfAborted();
  return snapshots === undefined ? undefined : projectFinalizedTargets(plan, snapshots);
}
