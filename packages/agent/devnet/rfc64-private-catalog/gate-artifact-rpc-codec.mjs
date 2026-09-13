// SPDX-License-Identifier: Apache-2.0

import {
  RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1,
  RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
  decodeRfc64PrivateRpcEvidenceV1,
} from './rpc-evidence.mjs';
import {
  assertExactKeysV1,
  plainRecordV1,
  stableJsonV1,
} from './gate-artifact-codec-primitives.mjs';

export function decodePrivateGateRpcActorsEvidenceV1(value) {
  const actors = plainRecordV1(value, 'RFC-64 private gate RPC actors');
  assertExactKeysV1(
    actors,
    RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
    'RFC-64 private gate RPC actors',
  );
  const verified = Object.fromEntries(RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1.map((id) => {
    const rpc = decodePrivateGateRpcEvidenceV1(
      actors[id],
      `RFC-64 private gate RPC actor ${id}`,
      RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1.includes(id)
        ? 'finalized-ceiling'
        : 'ceiling',
    );
    return [id, rpc];
  }));
  return Object.freeze(verified);
}

export function decodePrivateGateRpcEvidenceV1(value, label, profile = 'accounting') {
  return decodeRfc64PrivateRpcEvidenceV1(value, label, profile);
}

export function assertPrivateGateStateRpcMatchesActorV1(stateRpc, actorRpc, label) {
  if (stableJsonV1(stateRpc) !== stableJsonV1(actorRpc)) {
    throw new TypeError(`RFC-64 private gate ${label} RPC evidence is not actor-bound`);
  }
}
