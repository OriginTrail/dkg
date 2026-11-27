// SPDX-License-Identifier: Apache-2.0
import { Contract, type ContractRunner, type Interface, type FunctionFragment } from 'ethers';
import type { BatchedContractCall, BatchedContractCallResult } from './contract-read-batcher.js';

/** Multicall3 is deployed at this address on every chain that has it. */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** keccak256 of the canonical Multicall3 runtime bytecode (3,808 bytes). */
export const MULTICALL3_RUNTIME_CODE_HASH =
  '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';

const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
] as const;

export function createMulticall3(runner?: ContractRunner): Contract {
  return new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, runner);
}

export function decodeContractResult(iface: Interface, method: string | FunctionFragment, data: string): unknown {
  const result = iface.decodeFunctionResult(method, data);
  return result.length === 1 ? result[0] : result;
}

/** Provider-bound aggregate read; callers choose inner-call failure policy. */
export async function staticAggregate3(
  multicall3: Contract,
  calls: readonly BatchedContractCall[],
  blockTag?: number,
  allowFailure = true,
): Promise<readonly BatchedContractCallResult[]> {
  const innerCalls = calls.map(({ target, callData }) => ({ target, allowFailure, callData }));
  const results = await (blockTag === undefined
    ? multicall3.aggregate3.staticCall(innerCalls)
    : multicall3.aggregate3.staticCall(innerCalls, { blockTag })
  ) as ReadonlyArray<{ success: unknown; returnData: unknown }>;
  if (results.length !== calls.length) throw new Error(`Aggregate call answered ${results.length} of ${calls.length} calls`);
  return results.map(({ success, returnData }) => ({
    success: success === true,
    returnData: String(returnData),
  }));
}

