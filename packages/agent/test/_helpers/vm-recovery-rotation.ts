import { DKGAgentBase } from '../../src/dkg-agent-base.js';
import type { OrdinalRecoveryTarget } from '../../src/chain-reconciler.js';
import type {
  VmRecoveryPreparation,
  VmRecoveryRotationPolicy,
  VmRecoverySlotHandle,
  VmRecoverySlotRegistry,
} from '../../src/internal/vm-recovery-slot-registry.js';

/**
 * Suite-local seams over the host's slot registry.
 *
 * Production drives preparation and clean-absence credit through the batch
 * transaction (`recoverVmReconcileBatchInScope`) and
 * `revalidateVmReconcileRotationAfterFetch`. Only these suites still need a
 * single-target entry point, so it lives here rather than on the host, and it
 * applies the same rotation closure guard and collection deadline production
 * uses.
 */
export interface VmRecoveryRotationHost {
  readonly vmReconcileRotationClosed: boolean;
  readonly vmRecoverySlots: VmRecoverySlotRegistry;
  currentVmReconcileRotationPolicy(): VmRecoveryRotationPolicy;
}

export function prepareVmRecoveryRotationTarget(
  host: VmRecoveryRotationHost,
  target: OrdinalRecoveryTarget,
  candidatePeerIds: readonly string[],
  now: number,
  curatorRosterConfirmed = true,
): VmRecoveryPreparation {
  if (host.vmReconcileRotationClosed) return { kind: 'invalidated' };
  return host.vmRecoverySlots.prepare(target, {
    candidatePeerIds, curatorRosterConfirmed,
    collectionDeadlineAt: now + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS,
  }, now);
}

export function creditVmRecoveryCleanAbsence(
  host: VmRecoveryRotationHost,
  target: OrdinalRecoveryTarget,
  peerId: string,
  expectedCandidatePeerIds: readonly string[],
  slotHandle: VmRecoverySlotHandle,
): void {
  if (host.vmReconcileRotationClosed) return;
  host.vmRecoverySlots.creditCleanAbsence(target, peerId, expectedCandidatePeerIds, slotHandle,
    host.currentVmReconcileRotationPolicy());
}
