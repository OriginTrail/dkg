// SPDX-License-Identifier: Apache-2.0

type EvidenceValue = Readonly<Record<string, unknown>>;

export interface Rfc64PrivateBaselineResultV1 {
  readonly baseline: EvidenceValue;
  readonly ownerSourceState: EvidenceValue;
  readonly provider2Bootstrap: EvidenceValue;
  readonly provider2State: EvidenceValue;
  readonly published: EvidenceValue;
  readonly receiverSeedBootstrap: EvidenceValue;
  readonly receiverSeedState: EvidenceValue;
}

export interface Rfc64PrivateFailoverResultV1 {
  readonly ownerListenerClosed: boolean;
  readonly provider2ListenerDialable: boolean;
  readonly provider2StateAfterOwnerExit: EvidenceValue;
  readonly receiverBootstrap: EvidenceValue;
  readonly receiverState: EvidenceValue;
}

export interface Rfc64PrivateRevocationResultV1 {
  readonly outsiderDenial: EvidenceValue;
  readonly outsiderState: EvidenceValue;
  readonly ownerRevocation: EvidenceValue;
  readonly provider2StateAfterRevocation: EvidenceValue;
  readonly providerAccessState: EvidenceValue;
  readonly receiverRevocation: EvidenceValue;
  readonly receiverStateAfterRevocation: EvidenceValue;
  readonly revokedReceiverDenial: EvidenceValue;
}

export interface Rfc64PrivateRestartResultV1 {
  readonly restartState: EvidenceValue;
}

export interface Rfc64PrivateScenarioPhasesV1 {
  readonly baseline: Readonly<Rfc64PrivateBaselineResultV1>;
  readonly failover: Readonly<Rfc64PrivateFailoverResultV1>;
  readonly restart: Readonly<Rfc64PrivateRestartResultV1>;
  readonly revocation: Readonly<Rfc64PrivateRevocationResultV1>;
}

const PHASE_FIELDS = Object.freeze({
  baseline: Object.freeze([
    'baseline',
    'ownerSourceState',
    'provider2Bootstrap',
    'provider2State',
    'published',
    'receiverSeedBootstrap',
    'receiverSeedState',
  ]),
  failover: Object.freeze([
    'ownerListenerClosed',
    'provider2ListenerDialable',
    'provider2StateAfterOwnerExit',
    'receiverBootstrap',
    'receiverState',
  ]),
  restart: Object.freeze(['restartState']),
  revocation: Object.freeze([
    'outsiderDenial',
    'outsiderState',
    'ownerRevocation',
    'provider2StateAfterRevocation',
    'providerAccessState',
    'receiverRevocation',
    'receiverStateAfterRevocation',
    'revokedReceiverDenial',
  ]),
} as const);

/** Seal the scenario's one typed, named result instead of an open string-key bag. */
export function composeRfc64PrivateScenarioResultV1(input: Readonly<{
  peerIds: Readonly<Record<string, string>>;
  phases: Readonly<Rfc64PrivateScenarioPhasesV1>;
  processes: Readonly<Record<string, EvidenceValue>>;
  runtimeProvenance: EvidenceValue;
}>): Readonly<typeof input> {
  assertExactKeys(input.phases, Object.keys(PHASE_FIELDS), 'private scenario phases');
  for (const [phase, fields] of Object.entries(PHASE_FIELDS)) {
    const value = input.phases[phase as keyof Rfc64PrivateScenarioPhasesV1];
    assertExactKeys(value, fields, `private scenario ${phase} result`);
  }
  return Object.freeze({
    peerIds: Object.freeze({ ...input.peerIds }),
    phases: Object.freeze({ ...input.phases }),
    processes: Object.freeze({ ...input.processes }),
    runtimeProvenance: input.runtimeProvenance,
  });
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (keys.length !== canonicalExpected.length
    || keys.some((key, index) => key !== canonicalExpected[index])) {
    throw new TypeError(`${label} must contain exactly ${canonicalExpected.join(', ')}`);
  }
}
