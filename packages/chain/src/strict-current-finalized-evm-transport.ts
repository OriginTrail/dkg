// Public one-shot orchestration. Cohesive config, lifecycle, JSON-RPC, and
// snapshot transport concerns live in their own package-internal modules.
import type { ChainIdV1 } from '@origintrail-official/dkg-core';

import {
  CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
  CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1,
  CurrentFinalizedEvmCallErrorV1,
} from './current-finalized-evm-read-profile.js';
import {
  snapshotCurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmChainAdapterV1,
} from './current-finalized-evm-call.js';
import {
  type StrictCurrentFinalizedEvmReadRequestV1,
  type StrictCurrentFinalizedEvmReadResultV1,
  type StrictCurrentFinalizedEvmReadV1,
} from './current-finalized-evm-read-model.js';
import { snapshotCurrentFinalizedEvmReadRequestV1 } from './current-finalized-evm-read-validation.js';
import { executeStrictFinalizedEvmBatchV1 } from './strict-current-finalized-evm-batch-executor.js';
import { snapshotStrictCurrentFinalizedEvmConfigV1 } from './strict-current-finalized-evm-config.js';
import {
  readStrictCurrentFinalizedEvmRevertDataV1,
  unavailable,
} from './strict-current-finalized-evm-errors.js';
import {
  createStrictFinalizedEndpointRunnerV1,
  executeStrictFinalizedAnchorPolicyV1,
  settleStrictFinalizedParallelBatchV1,
  type StrictFinalizedEndpointRunnerMessagesV1,
} from './strict-current-finalized-evm-lifecycle.js';
import {
  parseStrictFinalizedAnchorV1,
  parseStrictFinalizedChainIdV1,
  postStrictFinalizedJsonRpcV1,
} from './strict-current-finalized-evm-rpc-client.js';
import type {
  DeadlineScopeV1,
  StrictCurrentFinalizedEvmRpcConfigV1,
  StrictRpcConfigSnapshotV1,
} from './strict-current-finalized-evm-types.js';

export {
  CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1,
  type CurrentFinalizedEvmBlockReferenceProfileV1,
  type StrictCurrentFinalizedEvmRpcConfigV1,
} from './strict-current-finalized-evm-types.js';
export { readStrictCurrentFinalizedEvmRevertDataV1 };
export type {
  StrictCurrentFinalizedEvmReadCallV1,
  StrictCurrentFinalizedEvmReadRequestV1,
  StrictCurrentFinalizedEvmReadResultV1,
  StrictCurrentFinalizedEvmReadV1,
} from './current-finalized-evm-read-model.js';

/**
 * Build one strict raw-JSON-RPC adapter from trusted local chain configuration.
 * Native fetch preserves the streamed body cap and real HTTP cancellation.
 */
export function createStrictCurrentFinalizedEvmChainAdapterV1(
  input: StrictCurrentFinalizedEvmRpcConfigV1,
): CurrentFinalizedEvmChainAdapterV1 {
  const read = createStrictCurrentFinalizedEvmReadV1(input);

  const adapter: CurrentFinalizedEvmChainAdapterV1 = async (inputRequest) => {
    const request = snapshotCurrentFinalizedEvmCallRequestV1(inputRequest);
    const result = await read({
      chainId: request.chainId,
      calls: Object.freeze([Object.freeze({
        to: request.to,
        data: request.data,
        maxReturnBytes: request.maxReturnBytes,
      })]),
      signal: request.signal,
    });
    const returnData = result.returnData[0];
    if (returnData === undefined) {
      throw unavailable('Single-call finalized read produced no contract result');
    }
    return Object.freeze({
      chainId: result.chainId,
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      returnData,
    });
  };

  return Object.freeze(adapter);
}

/** Build a bounded, non-queueing same-finalized-anchor read primitive. */
export function createStrictCurrentFinalizedEvmReadV1(
  input: StrictCurrentFinalizedEvmRpcConfigV1,
): StrictCurrentFinalizedEvmReadV1 {
  const config = snapshotStrictCurrentFinalizedEvmConfigV1(input);
  const runEndpoint = createStrictFinalizedEndpointRunnerV1({
    chainId: config.chainId,
    endpoints: config.endpoints,
    maxConcurrentPerChain: CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1,
    totalDeadlineMs: CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1,
    attemptTimeoutMs: CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
    messages: createReadEndpointRunnerMessagesV1(config.chainId),
  });

  const read: StrictCurrentFinalizedEvmReadV1 = async (inputRequest) => {
    const request = snapshotCurrentFinalizedEvmReadRequestV1(inputRequest);
    return runEndpoint({
      chainId: request.chainId,
      signal: request.signal,
      attempt: (endpoint, _attempt, deadline) =>
        executeEndpointAttempt(config, endpoint, request, deadline),
      accept: async (_endpoint, result) => result,
    });
  };

  return Object.freeze(read);
}

function createReadEndpointRunnerMessagesV1(
  chainId: ChainIdV1,
): StrictFinalizedEndpointRunnerMessagesV1 {
  return Object.freeze({
    chainMismatch: (requested: ChainIdV1) =>
      `Adapter is configured for chain ${chainId}, not ${requested}`,
    cancelledBeforeAdmission:
      'Current-finalized EVM call was cancelled before transport admission',
    cancelled: 'Current-finalized EVM call was cancelled',
    totalDeadlineLabel: 'current-finalized total deadline',
    totalDeadline: (timeoutMs: number) =>
      `Current-finalized total deadline exceeded ${timeoutMs}ms`,
    attemptDeadlineLabel: (attempt: number) =>
      `current-finalized endpoint attempt ${attempt}`,
    attemptDeadline: (timeoutMs: number) =>
      `Current-finalized endpoint attempt exceeded ${timeoutMs}ms`,
    attemptFailure: 'Current-finalized endpoint attempt failed closed',
    noEndpoint: 'No configured current-finalized endpoint succeeded',
    saturated: (active: number) =>
      `Chain ${chainId} already has ${active} finalized reads in flight`,
  });
}

async function executeEndpointAttempt(
  config: StrictRpcConfigSnapshotV1,
  endpoint: string,
  request: StrictCurrentFinalizedEvmReadRequestV1,
  attemptDeadline: DeadlineScopeV1,
): Promise<StrictCurrentFinalizedEvmReadResultV1> {
  const { signal } = attemptDeadline;
  let requestId = 0;
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    requestId += 1;
    return postStrictFinalizedJsonRpcV1(
      endpoint,
      requestId,
      method,
      params,
      CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
      signal,
    );
  };

  const remoteChainId = parseStrictFinalizedChainIdV1(
    await rpc('eth_chainId', Object.freeze([])),
  );
  if (remoteChainId !== config.chainId) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'chain-mismatch',
      `Configured endpoint attempt reported chain ${remoteChainId}, expected ${config.chainId}`,
    );
  }

  const anchor = parseStrictFinalizedAnchorV1(
    await rpc('eth_getBlockByNumber', Object.freeze(['finalized', false])),
    'current finalized header',
  );
  const executeCallsAt = async (blockReference: unknown): Promise<readonly string[]> => {
    const batch = await executeStrictFinalizedEvmBatchV1({
      calls: request.calls,
      blockReference,
      rpc,
      settle: (operations) => settleStrictFinalizedParallelBatchV1(
        operations,
        attemptDeadline,
      ),
    });
    return batch.returnData;
  };

  const returnData = await executeStrictFinalizedAnchorPolicyV1({
    blockReferenceProfile: config.blockReferenceProfile,
    anchor,
    executeAtReference: executeCallsAt,
    readPostAnchor: async () => parseStrictFinalizedAnchorV1(
      await rpc(
        'eth_getBlockByNumber',
        Object.freeze([anchor.blockNumberQuantity, false]),
      ),
      'post-call numbered header',
    ),
    anchorMismatchMessage:
      'Block-number fallback hash sandwich did not preserve the resolved finalized anchor',
  });

  return Object.freeze({
    chainId: config.chainId,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
    returnData,
  });
}
