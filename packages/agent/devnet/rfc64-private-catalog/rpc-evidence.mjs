// SPDX-License-Identifier: Apache-2.0

/** Fixed release-gate ceilings, attributed by method to expose load regressions. */
export const RFC64_PRIVATE_GATE_RPC_BUDGET_V1 = Object.freeze({
  total: 128,
  methods: Object.freeze({
    eth_blockNumber: 16,
    eth_call: 96,
    eth_chainId: 16,
    eth_getBlockByNumber: 16,
    eth_getCode: 8,
  }),
});

// These are the actors that materialize finalized VM authority through RPC in this
// scenario. The owner, outsider, and restarted receiver still have mandatory RPC
// receipts and ceilings below, but are expected to complete from local evidence.
export const RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1 = Object.freeze([
  'provider2',
  'receiver-seed',
  'receiver',
]);
export const RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1 = Object.freeze([
  'owner',
  ...RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1,
  'outsider',
  'receiver-restart',
]);

export function rpcEvidenceV1(state) {
  const calls = state?.rpcCallCounts;
  const byMethod = calls !== null && typeof calls === 'object' && !Array.isArray(calls)
    ? Object.fromEntries(Object.entries(calls))
    : {};
  const counts = Object.values(byMethod);
  return Object.freeze({
    byMethod: Object.freeze(byMethod),
    total: counts.every((count) => Number.isSafeInteger(count) && count >= 0)
      ? counts.reduce((sum, count) => sum + count, 0)
      : Number.NaN,
  });
}

export function isWithinRpcBudgetV1(state) {
  const evidence = rpcEvidenceV1(state);
  return evidence.total >= 1 && isWithinRpcCeilingV1(state);
}

/** A handshake is not finalized-chain evidence: require both block and contract reads. */
export function hasFinalizedRpcReadEvidenceV1(state) {
  const { byMethod } = rpcEvidenceV1(state);
  return Number.isSafeInteger(byMethod.eth_call)
    && byMethod.eth_call >= 1
    && Number.isSafeInteger(byMethod.eth_getBlockByNumber)
    && byMethod.eth_getBlockByNumber >= 1;
}

/** Pure verdict used by the release gate and focused negative tests. */
export function finalizedRuntimeRpcVerdictV1(receipts) {
  return Object.freeze({
    finalizedChainPathExecuted: RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1.every(
      (id) => Object.hasOwn(receipts ?? {}, id)
        && hasRpcAccountingV1(receipts[id])
        && hasFinalizedRpcReadEvidenceV1(receipts[id]),
    ),
    finalizedChainRpcWithinBudget: RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1.every(
      (id) => Object.hasOwn(receipts ?? {}, id)
        && hasRpcAccountingV1(receipts[id])
        && isWithinRpcCeilingV1(receipts[id]),
    ),
  });
}

function hasRpcAccountingV1(state) {
  const calls = state?.rpcCallCounts;
  return calls !== null
    && typeof calls === 'object'
    && !Array.isArray(calls)
    && Object.entries(calls).every(([method, count]) => (
      method.length > 0
      && Number.isSafeInteger(count)
      && count >= 0
    ));
}

/** Persisted-state inspection may be RPC-free but must never exceed known ceilings. */
export function isWithinRpcCeilingV1(state) {
  const evidence = rpcEvidenceV1(state);
  if (evidence.total > RFC64_PRIVATE_GATE_RPC_BUDGET_V1.total) return false;
  return Object.entries(evidence.byMethod).every(([method, count]) => (
    Number.isSafeInteger(count)
    && count >= 0
    && Object.hasOwn(RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods, method)
    && count <= RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods[method]
  ));
}
