// SPDX-License-Identifier: Apache-2.0
// @ts-check

import {
  RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1,
  RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
} from './scenario-actors.ts';

export {
  RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1,
  RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
} from './scenario-actors.ts';

/** Fixed release-gate ceilings, attributed by method to expose load regressions. */
export const RFC64_PRIVATE_GATE_RPC_BUDGET_V1 = Object.freeze({
  total: 128,
  methods: Object.freeze({
    eth_blockNumber: 16,
    eth_call: 96,
    eth_chainId: 16,
    eth_getBlockByNumber: 16,
    // The owner mutation actor performs six independently finalized authority
    // reads (boot, responsibility, acceptance, mutation, raw parity, and
    // shutdown), each of which proves the three fixture contracts are live.
    eth_getCode: 24,
  }),
});

/** @typedef {import('./scenario-result.ts').Rfc64PrivateRpcCallCountsV1} Rfc64PrivateRpcCallCountsV1 */
/** @typedef {'accounting' | 'ceiling' | 'finalized' | 'finalized-ceiling'} Rfc64PrivateRpcEvidenceProfileV1 */

/**
 * Decode method-attributed counts once for live verdicts and persisted codecs.
 * @param {unknown} value
 * @param {string} [label]
 * @param {Rfc64PrivateRpcEvidenceProfileV1} [profile]
 */
export function decodeRfc64PrivateRpcCallCountsV1(
  value,
  label = 'RFC-64 private RPC call counts',
  profile = 'accounting',
) {
  const calls = plainRpcRecordV1(value, label);
  let total = 0;
  /** @type {Record<string, number>} */
  const byMethod = {};
  const ceilings = /** @type {Readonly<Record<string, number>>} */ (
    RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods
  );
  for (const [method, count] of Object.entries(calls)) {
    if (
      !Object.hasOwn(ceilings, method)
      || !Number.isSafeInteger(count)
      || /** @type {number} */ (count) < 0
      || !Number.isSafeInteger(total + /** @type {number} */ (count))
    ) throw new TypeError(`${label} has malformed method accounting`);
    byMethod[method] = /** @type {number} */ (count);
    total += /** @type {number} */ (count);
  }
  if (
    (profile === 'ceiling' || profile === 'finalized-ceiling')
    && (
      total > RFC64_PRIVATE_GATE_RPC_BUDGET_V1.total
      || Object.entries(byMethod).some(([method, count]) => count > ceilings[method])
    )
  ) throw new TypeError(`${label} exceeds its fixed ceiling`);
  if (
    (profile === 'finalized' || profile === 'finalized-ceiling')
    && (!(byMethod.eth_call >= 1) || !(byMethod.eth_getBlockByNumber >= 1))
  ) throw new TypeError(`${label} has no finalized-chain read evidence`);
  return Object.freeze({
    byMethod: Object.freeze(/** @type {Rfc64PrivateRpcCallCountsV1} */ (byMethod)),
    total,
  });
}

/**
 * Decode the persisted `{ byMethod, total }` form through the same count parser.
 * @param {unknown} value
 * @param {string} [label]
 * @param {Rfc64PrivateRpcEvidenceProfileV1} [profile]
 */
export function decodeRfc64PrivateRpcEvidenceV1(
  value,
  label = 'RFC-64 private RPC evidence',
  profile = 'accounting',
) {
  const rpc = plainRpcRecordV1(value, label);
  assertExactRpcKeysV1(rpc, ['byMethod', 'total'], label);
  const decoded = decodeRfc64PrivateRpcCallCountsV1(
    rpc.byMethod,
    `${label} byMethod`,
    profile,
  );
  if (rpc.total !== decoded.total) throw new TypeError(`${label} total is inconsistent`);
  return decoded;
}

/** @param {{ readonly rpcCallCounts?: unknown } | null | undefined} state */
export function rpcEvidenceV1(state) {
  try {
    return decodeRfc64PrivateRpcCallCountsV1(state?.rpcCallCounts);
  } catch {
    return Object.freeze({ byMethod: Object.freeze({}), total: Number.NaN });
  }
}

/** @param {{ readonly rpcCallCounts?: unknown } | null | undefined} state */
export function isWithinRpcBudgetV1(state) {
  try {
    return decodeRfc64PrivateRpcCallCountsV1(
      state?.rpcCallCounts,
      undefined,
      'ceiling',
    ).total >= 1;
  } catch {
    return false;
  }
}

/** A handshake is not finalized-chain evidence: require both block and contract reads. */
/** @param {{ readonly rpcCallCounts?: unknown } | null | undefined} state */
export function hasFinalizedRpcReadEvidenceV1(state) {
  try {
    decodeRfc64PrivateRpcCallCountsV1(state?.rpcCallCounts, undefined, 'finalized');
    return true;
  } catch {
    return false;
  }
}

/** Pure verdict used by the release gate and focused negative tests. */
/** @param {Readonly<Record<string, { readonly rpcCallCounts?: unknown }>>} receipts */
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

/** @param {{ readonly rpcCallCounts?: unknown } | null | undefined} state */
function hasRpcAccountingV1(state) {
  try {
    decodeRfc64PrivateRpcCallCountsV1(state?.rpcCallCounts);
    return true;
  } catch {
    return false;
  }
}

/** Persisted-state inspection may be RPC-free but must never exceed known ceilings. */
/** @param {{ readonly rpcCallCounts?: unknown } | null | undefined} state */
export function isWithinRpcCeilingV1(state) {
  try {
    decodeRfc64PrivateRpcCallCountsV1(state?.rpcCallCounts, undefined, 'ceiling');
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} value @param {string} label */
function plainRpcRecordV1(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return /** @type {Readonly<Record<string, unknown>>} */ (value);
}

/**
 * @param {Readonly<Record<string, unknown>>} value
 * @param {readonly string[]} expected
 * @param {string} label
 */
function assertExactRpcKeysV1(value, expected, label) {
  if (Object.keys(value).sort().join('\n') !== [...expected].sort().join('\n')) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}
