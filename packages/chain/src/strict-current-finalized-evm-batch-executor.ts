import type { EvmAddressV1 } from '@origintrail-official/dkg-core';

import {
  assertStrictFinalizedEvmCodeResultV1,
  createStrictFinalizedEvmCallParamsV1,
  createStrictFinalizedEvmCodeParamsV1,
  parseStrictFinalizedEvmCallResultV1,
} from './strict-current-finalized-evm-read-operations.js';
import type { StrictCurrentFinalizedEvmReadCallV1 } from './current-finalized-evm-read-model.js';

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
    assertStrictFinalizedEvmCodeResultV1(await input.rpc(
      'eth_getCode',
      createStrictFinalizedEvmCodeParamsV1(to, input.blockReference),
    ), { allowNoCode: false });
    return to;
  }));
  const returnData = await input.settle(input.calls.map(async (call) => {
    return parseStrictFinalizedEvmCallResultV1(
      await input.rpc(
        'eth_call',
        createStrictFinalizedEvmCallParamsV1(call, input.blockReference),
      ),
      call.maxReturnBytes,
    );
  }));
  return Object.freeze({
    returnData,
    verifiedTargets: Object.freeze([...verifiedTargets]),
  });
}
