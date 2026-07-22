import type { EvmAddressV1 } from '@origintrail-official/dkg-core';

import {
  CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1,
  CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1,
  CurrentFinalizedEvmCallErrorV1,
} from './current-finalized-evm-read-profile.js';
import type { StrictCurrentFinalizedEvmReadCallV1 } from './current-finalized-evm-read-model.js';
import { isCanonicalLowerHexBytesV1 } from './strict-finalized-evm-bytes.js';

const RPC_CALL_GAS_QUANTITY = `0x${CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1.toString(16)}`;

/** Canonical eth_getCode parameters for every strict finalized read surface. */
export function createStrictFinalizedEvmCodeParamsV1(
  target: EvmAddressV1,
  blockReference: unknown,
): readonly unknown[] {
  return Object.freeze([target, blockReference]);
}

/**
 * Validate canonical code bytes. Capability probes may tolerate an empty
 * result, while real reads require code to be deployed at the pinned anchor.
 */
export function assertStrictFinalizedEvmCodeResultV1(
  input: unknown,
  options: Readonly<{ readonly allowNoCode: boolean }>,
): void {
  if (!isCanonicalLowerHexBytesV1(input)) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'rpc-unavailable',
      'eth_getCode returned malformed code bytes',
    );
  }
  if (!options.allowNoCode && input === '0x') {
    throw new CurrentFinalizedEvmCallErrorV1(
      'no-code',
      'Finalized-read target has no deployed code at the resolved anchor',
    );
  }
}

/** Canonical eth_call object and pinned block reference for strict reads. */
export function createStrictFinalizedEvmCallParamsV1(
  call: StrictCurrentFinalizedEvmReadCallV1,
  blockReference: unknown,
): readonly unknown[] {
  return Object.freeze([
    Object.freeze({
      from: CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1,
      to: call.to,
      data: call.data,
      gas: RPC_CALL_GAS_QUANTITY,
    }),
    blockReference,
  ]);
}

/** Canonical strict eth_call return-byte validation and caller-owned cap. */
export function parseStrictFinalizedEvmCallResultV1(
  input: unknown,
  maxBytes: number,
): string {
  if (!isCanonicalLowerHexBytesV1(input)) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'malformed-return',
      'Finalized eth_call returned malformed bytes',
    );
  }
  const byteLength = (input.length - 2) / 2;
  if (byteLength > maxBytes) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'malformed-return',
      `Finalized eth_call returned ${byteLength} bytes; limit ${maxBytes}`,
    );
  }
  return input;
}
