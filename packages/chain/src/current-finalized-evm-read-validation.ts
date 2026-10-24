import {
  assertCanonicalChainId,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

import {
  CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1,
  CurrentFinalizedEvmCallErrorV1,
} from './current-finalized-evm-read-profile.js';
import type {
  StrictCurrentFinalizedEvmReadCallV1,
  StrictCurrentFinalizedEvmReadRequestV1,
} from './current-finalized-evm-read-model.js';
import type { StrictCurrentFinalizedEvmSnapshotRequestV1 } from './current-finalized-evm-snapshot.js';
import {
  assertCanonicalNonzeroEvmAddress,
  isAbortSignal,
  snapshotDenseDataArray,
  snapshotExactDataRecord,
} from './strict-local-data.js';

const READ_REQUEST_KEYS = Object.freeze(['calls', 'chainId', 'signal'] as const);
const READ_CALL_KEYS = Object.freeze(['data', 'maxReturnBytes', 'to'] as const);
const SNAPSHOT_REQUEST_KEYS = Object.freeze(['chainId', 'signal'] as const);

export function snapshotCurrentFinalizedEvmReadRequestV1(
  input: unknown,
): StrictCurrentFinalizedEvmReadRequestV1 {
  try {
    const record = snapshotExactDataRecord(input, READ_REQUEST_KEYS);
    assertCanonicalChainId(record.chainId, 'strict finalized-read chainId');
    if (!isAbortSignal(record.signal)) throw new Error('signal is not an AbortSignal');
    return Object.freeze({
      chainId: record.chainId,
      calls: snapshotCurrentFinalizedEvmReadCallsV1(record.calls),
      signal: record.signal,
    });
  } catch {
    throw invalidProfile('Strict current-finalized read request failed the fixed local profile');
  }
}

export function snapshotCurrentFinalizedEvmSnapshotRequestV1(
  input: unknown,
): StrictCurrentFinalizedEvmSnapshotRequestV1 {
  try {
    const record = snapshotExactDataRecord(input, SNAPSHOT_REQUEST_KEYS);
    assertCanonicalChainId(record.chainId, 'strict finalized-snapshot chainId');
    if (!isAbortSignal(record.signal)) throw new Error('signal is not an AbortSignal');
    return Object.freeze({ chainId: record.chainId, signal: record.signal });
  } catch {
    throw invalidProfile('Strict current-finalized snapshot request failed the fixed local profile');
  }
}

export function snapshotCurrentFinalizedEvmSnapshotCallsV1(
  input: unknown,
): readonly StrictCurrentFinalizedEvmReadCallV1[] {
  try {
    return snapshotCurrentFinalizedEvmReadCallsV1(input);
  } catch {
    throw invalidProfile('Strict current-finalized snapshot batch failed the fixed local profile');
  }
}

function snapshotCurrentFinalizedEvmReadCallsV1(
  input: unknown,
): readonly StrictCurrentFinalizedEvmReadCallV1[] {
  const entries = snapshotDenseDataArray(input, {
    label: 'Current-finalized read calls',
    minLength: 1,
    maxLength: CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
  });
  const calls: StrictCurrentFinalizedEvmReadCallV1[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const record = snapshotExactDataRecord(entries[index], READ_CALL_KEYS);
    assertCanonicalNonzeroEvmAddress(record.to, `current-finalized read calls[${index}].to`);
    if (
      typeof record.data !== 'string'
      || !/^0x[0-9a-f]{8}(?:[0-9a-f]{2})*$/.test(record.data)
    ) {
      throw new Error(`finalized read calls[${index}].data is not canonical ABI calldata`);
    }
    if (
      typeof record.maxReturnBytes !== 'number'
      || !Number.isSafeInteger(record.maxReturnBytes)
      || record.maxReturnBytes < 1
      || record.maxReturnBytes > CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1
    ) {
      throw new Error(`finalized read calls[${index}].maxReturnBytes is outside the fixed cap`);
    }
    calls.push(Object.freeze({
      to: record.to as EvmAddressV1,
      data: record.data,
      maxReturnBytes: record.maxReturnBytes,
    }));
  }
  return Object.freeze(calls);
}

function invalidProfile(message: string): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1('rpc-unavailable', message);
}
