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

export function rpcEvidenceV1(state) {
  const calls = state?.rpcCallCounts;
  const byMethod = calls !== null && typeof calls === 'object' && !Array.isArray(calls)
    ? Object.fromEntries(Object.entries(calls).map(([method, count]) => [method, Number(count)]))
    : {};
  return Object.freeze({
    byMethod: Object.freeze(byMethod),
    total: Object.values(byMethod).reduce((sum, count) => sum + count, 0),
  });
}

export function isWithinRpcBudgetV1(state) {
  const evidence = rpcEvidenceV1(state);
  return evidence.total >= 1 && isWithinRpcCeilingV1(state);
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
