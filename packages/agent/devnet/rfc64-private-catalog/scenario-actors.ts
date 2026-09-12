// SPDX-License-Identifier: Apache-2.0

export const RFC64_PRIVATE_SCENARIO_ACTORS_V1 = Object.freeze([
  actor('probe-owner', 'owner', 'probe', false, false),
  actor('probe-provider2', 'provider2', 'probe', false, false),
  actor('probe-receiver', 'receiver', 'probe', false, false),
  actor('probe-outsider', 'outsider', 'probe', false, false),
  actor('owner', 'owner', 'run', true, false),
  actor('provider2', 'provider2', 'run', true, true),
  actor('receiver-seed', 'receiver', 'run', true, true),
  actor('receiver', 'receiver', 'run', true, true),
  actor('owner-revoker', 'owner', 'run', true, false),
  actor('outsider', 'outsider', 'run', true, false),
  actor('receiver-restart', 'receiver', 'run', true, false),
]);

export type Rfc64PrivateScenarioActorV1 =
  typeof RFC64_PRIVATE_SCENARIO_ACTORS_V1[number];
export type Rfc64PrivateScenarioProcessIdV1 =
  Rfc64PrivateScenarioActorV1['processId'];
export type Rfc64PrivateRuntimeRoleV1 = Rfc64PrivateScenarioActorV1['role'];

export const RFC64_PRIVATE_RUNTIME_ROLES_V1 = Object.freeze(
  [...new Set(RFC64_PRIVATE_SCENARIO_ACTORS_V1.map(({ role }) => role))],
) as readonly Rfc64PrivateRuntimeRoleV1[];

export const RFC64_PRIVATE_PROBE_ACTORS_V1 = Object.freeze(
  RFC64_PRIVATE_SCENARIO_ACTORS_V1.filter(({ runtimeKind }) => runtimeKind === 'probe'),
);

export const RFC64_PRIVATE_RUNTIME_ACTORS_V1 = Object.freeze(
  RFC64_PRIVATE_SCENARIO_ACTORS_V1.filter(({ runtimeKind }) => runtimeKind === 'run'),
);

export const RFC64_PRIVATE_SCENARIO_PROCESS_IDS_V1 = Object.freeze(
  RFC64_PRIVATE_SCENARIO_ACTORS_V1.map(({ processId }) => processId),
);

export const RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1 = Object.freeze(
  RFC64_PRIVATE_SCENARIO_ACTORS_V1
    .filter(({ rpcAccounting }) => rpcAccounting)
    .map(({ processId }) => processId),
);

export const RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1 = Object.freeze(
  RFC64_PRIVATE_SCENARIO_ACTORS_V1
    .filter(({ finalizedRead }) => finalizedRead)
    .map(({ processId }) => processId),
);

function actor<
  TProcessId extends string,
  TRole extends string,
  TRuntimeKind extends 'probe' | 'run',
>(
  processId: TProcessId,
  role: TRole,
  runtimeKind: TRuntimeKind,
  rpcAccounting: boolean,
  finalizedRead: boolean,
) {
  return Object.freeze({
    processId,
    role,
    runtimeKind,
    rpcAccounting,
    finalizedRead,
  });
}
