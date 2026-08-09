import type { ManagedOxigraphOwnershipLeaseV1 } from '../managed-oxigraph-ownership-v1-internal.js';
import {
  createSystemRecordAtomicApplyExecutorV1,
  type SystemRecordAtomicApplyHttpClientV1,
} from '../system-record-atomic-apply-executor-v1-internal.js';
import {
  createSystemRecordLaneControllerV1,
  type SystemRecordApplyOutcomeV1,
  type SystemRecordChildHandoffV1,
  type SystemRecordLaneBarrierV1,
  type SystemRecordLaneControllerV1,
  type SystemRecordLaneExecutionBindingV1,
  type SystemRecordLaneTypedBarrierV1,
} from '../system-record-materializer-v1.js';
import { resolveOwnedSystemRecordRuntimeV1 } from '../system-record-runtime-v1-internal.js';

export interface ManagedSystemRecordCoordinatorOptionsV1 {
  readonly lease: ManagedOxigraphOwnershipLeaseV1;
  readonly handoff: SystemRecordChildHandoffV1;
  readonly storeId: object;
  readonly queryEndpoint: string;
  readonly updateEndpoint: string;
  readonly resolveClient: (
    binding: SystemRecordLaneExecutionBindingV1,
  ) => SystemRecordAtomicApplyHttpClientV1 | null;
  readonly applyLegacy: (
    proof: unknown,
    childGeneration: string,
  ) => Promise<SystemRecordApplyOutcomeV1>;
  readonly barrier: SystemRecordLaneBarrierV1;
  readonly typedBarrier: SystemRecordLaneTypedBarrierV1;
  readonly setAdmissionActive: (active: boolean) => void;
}

/** Compose the one managed-store lane from adapter-owned endpoints and ownership. */
export function createManagedSystemRecordCoordinatorV1(
  options: ManagedSystemRecordCoordinatorOptionsV1,
): SystemRecordLaneControllerV1 {
  const { consumer } = resolveOwnedSystemRecordRuntimeV1(options.lease);
  const atomicExecutor = createSystemRecordAtomicApplyExecutorV1({
    consumer,
    storeId: options.storeId,
    queryEndpoint: options.queryEndpoint,
    updateEndpoint: options.updateEndpoint,
    resolveClient: options.resolveClient,
  });
  return createSystemRecordLaneControllerV1({
    lease: options.lease,
    handoff: options.handoff,
    executor: {
      applyVerified: options.applyLegacy,
      discardVerified: (proof) => atomicExecutor.discard(proof),
      applyVerifiedSettlementBound: (proof, binding, registerRecovery) =>
        atomicExecutor.execute(proof, binding, registerRecovery),
    },
    barrier: options.barrier,
    typedBarrier: options.typedBarrier,
    setAdmissionActive: options.setAdmissionActive,
  });
}
