// SPDX-License-Identifier: Apache-2.0

import {
  RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1,
  RFC64_PRIVATE_GATE_RPC_BUDGET_V1,
  RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
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
    );
    if (
      rpc.total > RFC64_PRIVATE_GATE_RPC_BUDGET_V1.total
      || Object.entries(rpc.byMethod).some(([method, count]) => (
        !Object.hasOwn(RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods, method)
        || count > RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods[method]
      ))
      || (RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1.includes(id)
        && (!(rpc.byMethod.eth_call >= 1) || !(rpc.byMethod.eth_getBlockByNumber >= 1)))
    ) throw new TypeError(`RFC-64 private gate RPC actor ${id} is outside its fixed contract`);
    return [id, rpc];
  }));
  return Object.freeze(verified);
}

export function decodePrivateGateRpcEvidenceV1(value, label) {
  const rpc = plainRecordV1(value, label);
  assertExactKeysV1(rpc, ['byMethod', 'total'], label);
  const byMethod = plainRecordV1(rpc.byMethod, `${label} byMethod`);
  const total = Object.entries(byMethod).reduce((sum, [method, count]) => {
    if (
      method.length < 1
      || method.length > 128
      || !Number.isSafeInteger(count)
      || count < 0
      || !Number.isSafeInteger(sum + count)
    ) throw new TypeError(`${label} has malformed method accounting`);
    return sum + count;
  }, 0);
  if (rpc.total !== total) throw new TypeError(`${label} total is inconsistent`);
  return rpc;
}

export function assertPrivateGateStateRpcMatchesActorV1(stateRpc, actorRpc, label) {
  if (stableJsonV1(stateRpc) !== stableJsonV1(actorRpc)) {
    throw new TypeError(`RFC-64 private gate ${label} RPC evidence is not actor-bound`);
  }
}
