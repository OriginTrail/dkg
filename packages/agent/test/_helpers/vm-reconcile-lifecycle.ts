import { VmRecoverySlotRegistry } from '../../src/internal/vm-recovery-slot-registry.js';

/** Required VM retirement dependencies for tests that bypass the agent constructor. */
export function createVmReconcileLifecycleFixture() {
  return {
    vmRecoverySlots: new VmRecoverySlotRegistry(2),
    vmReconcileLifecycleController: new AbortController(),
    vmReconcileLifecycleGeneration: 0,
    vmReconcileRotationClosed: false,
    vmReconcileRotationAdmissionCursorByCg: new Map<string, number>(),
    vmReconcileCuratorPeersByCg: new Map<string, string[]>(),
    vmReconcileCuratorPageCursorByCg: new Map<string, string>(),
  };
}
