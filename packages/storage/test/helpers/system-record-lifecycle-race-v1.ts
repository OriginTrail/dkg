import { expect } from 'vitest';

import {
  SystemRecordControllerRegistrationError,
  releaseSystemRecordLaneControllerV1,
  type SystemRecordLaneControllerV1,
} from '../../src/system-record-materializer-v1.js';

export interface TrackedSystemRecordControllerReleaseV1 {
  readonly completion: Promise<void>;
  readonly hasSettled: () => boolean;
}

export function trackSystemRecordControllerReleaseV1(
  controller: SystemRecordLaneControllerV1,
): TrackedSystemRecordControllerReleaseV1 {
  let settled = false;
  const completion = releaseSystemRecordLaneControllerV1(controller).then(() => {
    settled = true;
  });
  return Object.freeze({ completion, hasSettled: () => settled });
}

export function expectSystemRecordControllerSlotRetainedV1(
  createReplacement: () => SystemRecordLaneControllerV1,
): void {
  expect(createReplacement).toThrow(SystemRecordControllerRegistrationError);
}

export async function releaseReplacementSystemRecordControllerV1(
  createReplacement: () => SystemRecordLaneControllerV1,
): Promise<void> {
  await releaseSystemRecordLaneControllerV1(createReplacement());
}

export async function nextSystemRecordLifecycleTurnV1(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
