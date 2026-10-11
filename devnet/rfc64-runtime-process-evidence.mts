// SPDX-License-Identifier: Apache-2.0

export const RUNTIME_PROCESS_IDENTITY_SCHEMA_VERSION =
  'dkg-rfc64-runtime-process-identity-v1' as const;

const HOST_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Stable host plus OS PID; the pair is the process identity across hosts. */
export interface RuntimeProcessIdentityV1 {
  readonly hostIdentity: string;
  readonly pid: number;
}

export function createRuntimeProcessIdentityV1(
  hostIdentity: string,
  pid: number,
): Readonly<RuntimeProcessIdentityV1> {
  if (!HOST_IDENTITY.test(hostIdentity)) {
    throw new TypeError('runtime process host identity is malformed');
  }
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError('runtime process PID is malformed');
  }
  return Object.freeze({ hostIdentity, pid });
}

export function assertRuntimeProcessIdentityV1(
  value: unknown,
  label = 'runtime process identity',
): asserts value is RuntimeProcessIdentityV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'hostIdentity' || keys[1] !== 'pid') {
    throw new TypeError(`${label} must contain only hostIdentity and pid`);
  }
  if (typeof record.hostIdentity !== 'string' || !HOST_IDENTITY.test(record.hostIdentity)) {
    throw new TypeError(`${label}.hostIdentity is malformed`);
  }
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1) {
    throw new TypeError(`${label}.pid is malformed`);
  }
}

export function runtimeProcessIdentityKeyV1(identity: RuntimeProcessIdentityV1): string {
  assertRuntimeProcessIdentityV1(identity);
  return `${identity.hostIdentity}\u0000${identity.pid.toString()}`;
}

/** One scenario-neutral fixed-topology process evidence entry. */
export interface FixedRuntimeProcessEvidenceV1<ProcessId extends string, Loaded> {
  readonly id: ProcessId;
  readonly identity: RuntimeProcessIdentityV1;
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
  const identities = new Set<string>();
  return Object.freeze(input.processes.map((processEvidence, index) => {
    const expectedId = input.expectedProcessIds[index]!;
    if (processEvidence.id !== expectedId) {
      throw new Error(`runtime provenance process ${index} must be ${expectedId}`);
    }
    assertRuntimeProcessIdentityV1(processEvidence.identity, `runtime process ${expectedId} identity`);
    const identityKey = runtimeProcessIdentityKeyV1(processEvidence.identity);
    if (identities.has(identityKey)) {
      throw new Error(`runtime provenance has duplicate process identity: ${identityKey}`);
    }
    identities.add(identityKey);
    input.validateLoaded(processEvidence.loaded, expectedId);
    return Object.freeze({
      id: expectedId,
      identity: Object.freeze({
        hostIdentity: processEvidence.identity.hostIdentity,
        pid: processEvidence.identity.pid,
      }),
      loaded: processEvidence.loaded,
    });
  }));
}
