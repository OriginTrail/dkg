import type { EvmAddressV1 } from '@origintrail-official/dkg-core';

import {
  CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1,
  CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1,
  CurrentFinalizedEvmCallErrorV1,
} from './current-finalized-evm-read-profile.js';
import type { StrictCurrentFinalizedEvmReadCallV1 } from './current-finalized-evm-read-model.js';
import { isCanonicalLowerHexBytesV1 } from './strict-finalized-evm-bytes.js';

const RPC_CALL_GAS_QUANTITY = `0x${CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1.toString(16)}`;

export interface StrictFinalizedEvmBatchExecutorInputV1 {
  readonly calls: readonly StrictCurrentFinalizedEvmReadCallV1[];
  readonly blockReference: unknown;
  readonly deployedTargets?: ReadonlySet<EvmAddressV1>;
  readonly rpc: (method: string, params: readonly unknown[]) => Promise<unknown>;
  readonly settle: <T>(operations: readonly Promise<T>[]) => Promise<readonly T[]>;
}

export interface StrictFinalizedEvmBatchExecutorResultV1 {
  readonly returnData: readonly string[];
  /** Targets proven in this batch but not yet committed to caller-owned state. */
  readonly verifiedTargets: readonly EvmAddressV1[];
}

/**
 * Execute the code-check and eth_call phases shared by one-shot and snapshot
 * reads. The helper never mutates caller state: snapshot callers commit the
 * returned deployment evidence only after their anchor proof succeeds.
 */
export async function executeStrictFinalizedEvmBatchV1(
  input: StrictFinalizedEvmBatchExecutorInputV1,
): Promise<Readonly<StrictFinalizedEvmBatchExecutorResultV1>> {
  const uncheckedTargets = [...new Set(input.calls.map(({ to }) => to))]
    .filter((to) => !input.deployedTargets?.has(to));
  const verifiedTargets = await input.settle(uncheckedTargets.map(async (to) => {
    assertDeployedCode(await input.rpc(
      'eth_getCode',
      Object.freeze([to, input.blockReference]),
    ));
    return to;
  }));
  const returnData = await input.settle(input.calls.map(async (call) => {
    const callObject = Object.freeze({
      from: CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1,
      to: call.to,
      data: call.data,
      gas: RPC_CALL_GAS_QUANTITY,
    });
    return parseContractReturn(
      await input.rpc('eth_call', Object.freeze([callObject, input.blockReference])),
      call.maxReturnBytes,
    );
  }));
  return Object.freeze({
    returnData,
    verifiedTargets: Object.freeze([...verifiedTargets]),
  });
}

function assertDeployedCode(input: unknown): void {
  if (!isCanonicalLowerHexBytesV1(input)) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'rpc-unavailable',
      'eth_getCode returned malformed code bytes',
    );
  }
  if (input === '0x') {
    throw new CurrentFinalizedEvmCallErrorV1(
      'no-code',
      'Finalized-read target has no deployed code at the resolved anchor',
    );
  }
}

function parseContractReturn(input: unknown, maxBytes: number): string {
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
