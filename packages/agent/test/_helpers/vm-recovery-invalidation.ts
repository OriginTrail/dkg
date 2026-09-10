import type { OrdinalRecoveryTarget } from '../../src/chain-reconciler.js';
import { DKGAgentBase } from '../../src/dkg-agent-base.js';
import type { ContextGraphSub } from '../../src/dkg-agent-types.js';

export const VM_RECOVERY_INVALIDATIONS = [
  'unsubscribe', 'rebind', 'fingerprint', 'eviction', 'shutdown',
] as const;
export type VmRecoveryInvalidation = (typeof VM_RECOVERY_INVALIDATIONS)[number];

interface InvalidationAgent {
  unsubscribeFromContextGraph(localCgId: string, options: { persist: false }): void;
}
interface InvalidationHost {
  readonly subscribedContextGraphs: Map<string, ContextGraphSub>;
  bindSubscriptionOnChainId(localCgId: string, subscription: ContextGraphSub, onChainId: string): void;
  prepareVmReconcileRotationTarget(target: OrdinalRecoveryTarget, peers: readonly string[], now: number): unknown;
  vmReconcileRotationNow(): number;
  closeVmReconcileRotationState(): void;
}

/** Apply the same production lifecycle transition in every cancellation suite. */
export function applyVmRecoveryInvalidation(params: {
  readonly invalidation: VmRecoveryInvalidation;
  readonly agent: InvalidationAgent;
  readonly host: InvalidationHost;
  readonly localCgId: string;
  readonly target: OrdinalRecoveryTarget;
  readonly peerId: string;
  readonly replacementMerkleRoot?: string;
  readonly waitingLocalCgId?: string;
}): () => void {
  const capacity = Object.getOwnPropertyDescriptor(
    DKGAgentBase,
    'VM_RECONCILE_CACHE_MAX_ENTRIES',
  )!;
  switch (params.invalidation) {
    case 'unsubscribe':
      params.agent.unsubscribeFromContextGraph(params.localCgId, { persist: false });
      break;
    case 'rebind':
      params.host.bindSubscriptionOnChainId(
        params.localCgId,
        params.host.subscribedContextGraphs.get(params.localCgId)!,
        '2',
      );
      break;
    case 'fingerprint':
      params.host.prepareVmReconcileRotationTarget(
        { ...params.target, merkleRoot: params.replacementMerkleRoot ?? 'replacement-root' },
        [params.peerId],
        params.host.vmReconcileRotationNow(),
      );
      break;
    case 'eviction':
      Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_CACHE_MAX_ENTRIES', {
        ...capacity,
        value: 2,
      });
      params.host.prepareVmReconcileRotationTarget(
        { ...params.target, ordinal: params.target.ordinal + 1 },
        [params.peerId],
        params.host.vmReconcileRotationNow(),
      );
      params.host.prepareVmReconcileRotationTarget(
        { ...params.target, localCgId: params.waitingLocalCgId ?? `${params.localCgId}-waiting` },
        [params.peerId],
        params.host.vmReconcileRotationNow(),
      );
      break;
    case 'shutdown':
      params.host.closeVmReconcileRotationState();
      break;
  }
  return () => Object.defineProperty(
    DKGAgentBase,
    'VM_RECONCILE_CACHE_MAX_ENTRIES',
    capacity,
  );
}
