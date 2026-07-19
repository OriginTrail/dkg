import { assertCanonicalChainId } from '@origintrail-official/dkg-core';

import {
  CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
  CONTROL_EIP1271_CALL_FROM_V1,
  CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
  CONTROL_EIP1271_GAS_LIMIT_V1,
  CONTROL_EIP1271_MAX_ATTEMPTS_V1,
  CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
  CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1,
  CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
  CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
  CurrentFinalizedEvmCallErrorV1,
  type CurrentFinalizedEvmCallRequestV1,
} from './control-object-signature-verifier.js';

// Package-internal strict data-only snapshot boundary shared by the
// current-finalized router and the strict raw-RPC transport. One canonical
// definition of "plain data record", "dense data-only array", "exact data-only
// record", and the fixed current-finalized request profile, instead of
// near-duplicate reflective validators drifting across feature modules. This
// module is intentionally NOT re-exported from the package barrel (src/index.ts).

const REQUEST_KEYS = Object.freeze([
  'attemptTimeoutMs',
  'ccipReadEnabled',
  'chainId',
  'data',
  'endpointAttemptPolicy',
  'from',
  'gasLimit',
  'maxAttempts',
  'maxConcurrentCallsPerChain',
  'maxReturnBytes',
  'maxRpcResponseBytes',
  'signal',
  'to',
  'totalDeadlineMs',
] as const);
const CANONICAL_NONZERO_EVM_ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

/**
 * Snapshot a dense, data-only ordinary array (own keys are exactly the indices
 * 0..length-1 plus `length`, every element an enumerable data property). Any
 * deviation — including a hostile length/index accessor that throws — fails
 * closed with `invalidMessage`, letting callers keep their exact domain message
 * while sharing one validator.
 */
export function snapshotDenseDataArray(
  input: unknown,
  invalidMessage: string,
): readonly unknown[] {
  try {
    if (!Array.isArray(input)) throw new Error('not an array');
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (
      lengthDescriptor === undefined
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || typeof lengthDescriptor.value !== 'number'
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw new Error('invalid array length');
    }

    const length = lengthDescriptor.value;
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== length + 1
      || ownKeys.some((key) => (
        typeof key !== 'string'
        || (key !== 'length' && !isCanonicalArrayIndex(key, length))
      ))
    ) {
      throw new Error('not a dense ordinary array');
    }

    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        throw new Error('entry must be an enumerable data property');
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    throw new TypeError(invalidMessage);
  }
}

/**
 * Snapshot a plain data-only record whose own string keys are EXACTLY
 * `expectedKeys`, each an enumerable data property. Throws a plain Error on any
 * deviation so callers can map it to their domain-specific disposition.
 */
export function snapshotExactDataRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('not a record');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('not plain');
  const actualKeys = Reflect.ownKeys(input);
  if (
    actualKeys.some((key) => typeof key !== 'string')
    || actualKeys.length !== expectedKeys.length
    || (actualKeys as string[]).sort().some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('unknown or missing fields');
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error('fields must be enumerable data properties');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false;
  try {
    const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
    if (abortedGetter === undefined) return false;
    abortedGetter.call(value);
    return true;
  } catch {
    return false;
  }
}

function assertCanonicalEip1271CallData(data: string): void {
  if (!/^0x[0-9a-f]+$/.test(data)) {
    throw new Error('call data is not canonical lowercase hex');
  }
  const bytes = data.slice(2);
  const selectorLength = 8;
  const wordLength = 64;
  const fixedLength = selectorLength + (wordLength * 3);
  if (
    bytes.slice(0, selectorLength) !== '1626ba7e'
    || bytes.length < fixedLength
    || bytes.slice(selectorLength + wordLength, selectorLength + (wordLength * 2))
      !== `${'0'.repeat(62)}40`
  ) {
    throw new Error('call data is not canonical isValidSignature(bytes32,bytes) ABI');
  }

  const signatureLengthWord = bytes.slice(
    selectorLength + (wordLength * 2),
    fixedLength,
  );
  const signatureLength = BigInt(`0x${signatureLengthWord}`);
  if (signatureLength < 1n || signatureLength > 4096n) {
    throw new Error('EIP-1271 signature length is outside 1..4096 bytes');
  }
  const paddedSignatureHexLength = Math.ceil(Number(signatureLength) / 32) * wordLength;
  const tail = bytes.slice(fixedLength);
  if (tail.length !== paddedSignatureHexLength) {
    throw new Error('EIP-1271 signature tail has noncanonical length');
  }
  const signatureHexLength = Number(signatureLength) * 2;
  if (!/^0*$/.test(tail.slice(signatureHexLength))) {
    throw new Error('EIP-1271 signature tail has nonzero ABI padding');
  }
}

/** Package-internal strict snapshot shared by the router and raw transport. */
export function snapshotCurrentFinalizedEvmCallRequestV1(
  input: unknown,
): CurrentFinalizedEvmCallRequestV1 {
  try {
    const record = snapshotExactDataRecord(input, REQUEST_KEYS);
    assertCanonicalChainId(record.chainId, 'current-finalized request chainId');
    if (
      typeof record.to !== 'string'
      || !CANONICAL_NONZERO_EVM_ADDRESS.test(record.to)
    ) {
      throw new Error('to is not a canonical nonzero EVM address');
    }
    if (record.from !== CONTROL_EIP1271_CALL_FROM_V1) throw new Error('wrong from');
    if (typeof record.data !== 'string') throw new Error('call data is not a string');
    assertCanonicalEip1271CallData(record.data);
    if (record.gasLimit !== CONTROL_EIP1271_GAS_LIMIT_V1) throw new Error('wrong gas limit');
    if (record.maxReturnBytes !== CONTROL_EIP1271_MAX_RETURN_BYTES_V1) {
      throw new Error('wrong return cap');
    }
    if (record.maxRpcResponseBytes !== CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1) {
      throw new Error('wrong RPC response cap');
    }
    if (record.attemptTimeoutMs !== CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1) {
      throw new Error('wrong attempt timeout');
    }
    if (record.maxAttempts !== CONTROL_EIP1271_MAX_ATTEMPTS_V1) {
      throw new Error('wrong attempt count');
    }
    if (record.endpointAttemptPolicy !== CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1) {
      throw new Error('wrong endpoint policy');
    }
    if (
      record.maxConcurrentCallsPerChain
      !== CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1
    ) {
      throw new Error('wrong concurrency ceiling');
    }
    if (record.totalDeadlineMs !== CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1) {
      throw new Error('wrong total deadline');
    }
    if (record.ccipReadEnabled !== false) throw new Error('CCIP Read must be disabled');
    if (!isAbortSignal(record.signal)) throw new Error('signal is not an AbortSignal');

    return Object.freeze({
      chainId: record.chainId,
      to: record.to,
      from: record.from,
      data: record.data,
      gasLimit: record.gasLimit,
      maxReturnBytes: record.maxReturnBytes,
      maxRpcResponseBytes: record.maxRpcResponseBytes,
      attemptTimeoutMs: record.attemptTimeoutMs,
      maxAttempts: record.maxAttempts,
      endpointAttemptPolicy: record.endpointAttemptPolicy,
      maxConcurrentCallsPerChain: record.maxConcurrentCallsPerChain,
      totalDeadlineMs: record.totalDeadlineMs,
      ccipReadEnabled: record.ccipReadEnabled,
      signal: record.signal,
    }) as CurrentFinalizedEvmCallRequestV1;
  } catch {
    throw new CurrentFinalizedEvmCallErrorV1(
      'rpc-unavailable',
      'Current-finalized EVM call request failed the fixed local profile',
    );
  }
}
