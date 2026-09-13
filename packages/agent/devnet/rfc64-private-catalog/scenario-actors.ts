// SPDX-License-Identifier: Apache-2.0

export const RFC64_PRIVATE_RUNTIME_ROLES_V1 = Object.freeze([
  'owner',
  'provider2',
  'receiver',
  'outsider',
] as const);

export type Rfc64PrivateRuntimeRoleV1 =
  typeof RFC64_PRIVATE_RUNTIME_ROLES_V1[number];

export const RFC64_PRIVATE_PROBE_ACTORS_V1 = Object.freeze(
  RFC64_PRIVATE_RUNTIME_ROLES_V1.map((role) => probeActor(role)),
);

export const RFC64_PRIVATE_RUNTIME_ACTORS_V1 = Object.freeze([
  runtimeActor('owner', 'owner'),
  runtimeActor('provider2', 'provider2', { requiresFinalizedReadEvidence: true }),
  runtimeActor('receiver-seed', 'receiver', { requiresFinalizedReadEvidence: true }),
  runtimeActor('receiver', 'receiver', { requiresFinalizedReadEvidence: true }),
  runtimeActor('owner-revoker', 'owner'),
  runtimeActor('outsider', 'outsider'),
  runtimeActor('receiver-restart', 'receiver'),
]);

export const RFC64_PRIVATE_SCENARIO_ACTORS_V1 = Object.freeze([
  ...RFC64_PRIVATE_PROBE_ACTORS_V1,
  ...RFC64_PRIVATE_RUNTIME_ACTORS_V1,
]);

export type Rfc64PrivateScenarioActorV1 =
  typeof RFC64_PRIVATE_SCENARIO_ACTORS_V1[number];
export type Rfc64PrivateScenarioProcessIdV1 =
  Rfc64PrivateScenarioActorV1['processId'];

export const RFC64_PRIVATE_SCENARIO_PROCESS_IDS_V1 = Object.freeze(
  RFC64_PRIVATE_SCENARIO_ACTORS_V1.map(({ processId }) => processId),
);

export const RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1 = Object.freeze(
  RFC64_PRIVATE_RUNTIME_ACTORS_V1.map(({ processId }) => processId),
);

export const RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1 = Object.freeze(
  RFC64_PRIVATE_SCENARIO_ACTORS_V1
    .filter((actor) => 'requiresFinalizedReadEvidence' in actor)
    .map(({ processId }) => processId),
);

function probeActor<TRole extends Rfc64PrivateRuntimeRoleV1>(role: TRole) {
  return Object.freeze({
    processId: `probe-${role}` as const,
    role,
    runtimeKind: 'probe' as const,
  });
}

function runtimeActor<
  TProcessId extends string,
  TRole extends Rfc64PrivateRuntimeRoleV1,
>(
  processId: TProcessId,
  role: TRole,
  capabilities: Readonly<{ requiresFinalizedReadEvidence?: true }> = {},
) {
  return Object.freeze({
    processId,
    role,
    runtimeKind: 'run' as const,
    ...capabilities,
  });
}
