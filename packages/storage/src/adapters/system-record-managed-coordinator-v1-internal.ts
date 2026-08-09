import type { ManagedOxigraphOwnershipLeaseV1 } from '../managed-oxigraph-ownership-v1-internal.js';
import {
  createSystemRecordAtomicApplyExecutorV1,
  type SystemRecordAtomicApplyHttpClientV1,
} from '../system-record-atomic-apply-executor-v1-internal.js';
import {
  createSystemRecordLaneControllerTypedV1,
  type SystemRecordApplyOutcomeV1,
  type SystemRecordChildHandoffV1,
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
  /**
   * The ONLY barrier the managed path accepts. There is deliberately no
   * string-barrier member on these options: the purpose-string contract is
   * retired for first-party composition (#2179), and its absence here is
   * structural — a future edit cannot fall back onto it without changing
   * this interface, which is the loudest possible place for that change.
   * External composers with string barriers use the public
   * `createSystemRecordLaneControllerV1` compatibility adapter instead.
   */
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
  return createSystemRecordLaneControllerTypedV1({
    lease: options.lease,
    handoff: options.handoff,
    executor: {
      applyVerified: options.applyLegacy,
      discardVerified: (proof) => atomicExecutor.discard(proof),
      applyVerifiedSettlementBound: (proof, binding, registerRecovery) =>
        atomicExecutor.execute(proof, binding, registerRecovery),
    },
    typedBarrier: options.typedBarrier,
    setAdmissionActive: options.setAdmissionActive,
  });
}
