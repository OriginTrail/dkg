import {
  createManagedOxigraphOwnershipControllerV1,
} from '@origintrail-official/dkg-storage/internal/managed-oxigraph-ownership-v1';
import type {
  OxigraphServerOwnershipV1,
} from './oxigraph-server-contract.js';

export type OxigraphSupervisorOwnershipControllerV1 = ReturnType<
  typeof createManagedOxigraphOwnershipControllerV1
>;

/** Keep the endpoint-bound mint policy inside the daemon-only owner module. */
export function createOxigraphSupervisorOwnershipV1(input: {
  endpointBound: boolean;
  queryEndpoint: string;
  updateEndpoint: string;
}): OxigraphSupervisorOwnershipControllerV1 {
  return input.endpointBound
    ? createManagedOxigraphOwnershipControllerV1(
        input.queryEndpoint,
        input.updateEndpoint,
      )
    : createManagedOxigraphOwnershipControllerV1();
}

/** Expose lease observation and controlled recovery, never mutation authority. */
export function createOxigraphServerOwnershipViewV1(
  controller: OxigraphSupervisorOwnershipControllerV1,
  recoverGeneration: (expectedGeneration: string) => Promise<string>,
): OxigraphServerOwnershipV1 {
  return Object.freeze({
    lease: controller.lease,
    snapshot: () => controller.snapshot(),
    recoverGeneration,
  });
}
