// SPDX-License-Identifier: Apache-2.0

/** One scenario-neutral fixed-topology process evidence entry. */
export interface FixedRuntimeProcessEvidenceV1<ProcessId extends string, Loaded> {
  readonly id: ProcessId;
  readonly loaded: Loaded;
}

/**
 * Validate and freeze one ordered fixed process topology.
 *
 * Scenario wrappers own their wire schema and loaded-runtime validation; this
 * primitive owns the count/order/id invariant once for every RFC-64 gate.
 */
export function validateFixedRuntimeProcessEvidenceV1<
  ProcessId extends string,
  Loaded,
>(input: {
  readonly expectedProcessIds: readonly ProcessId[];
  readonly processes: readonly FixedRuntimeProcessEvidenceV1<ProcessId, Loaded>[];
  readonly validateLoaded: (loaded: Loaded, id: ProcessId) => void;
}): readonly Readonly<FixedRuntimeProcessEvidenceV1<ProcessId, Loaded>>[] {
  if (input.processes.length !== input.expectedProcessIds.length) {
    throw new Error('runtime provenance has an unexpected process count');
  }
  return Object.freeze(input.processes.map((processEvidence, index) => {
    const expectedId = input.expectedProcessIds[index]!;
    if (processEvidence.id !== expectedId) {
      throw new Error(`runtime provenance process ${index} must be ${expectedId}`);
    }
    input.validateLoaded(processEvidence.loaded, expectedId);
    return Object.freeze({ id: expectedId, loaded: processEvidence.loaded });
  }));
}
