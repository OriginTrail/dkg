import type {
  ChainIdV1,
  Digest32V1,
  EvmAddressV1,
  BlockNumberV1,
} from '@origintrail-official/dkg-core';

import {
  CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1,
  CurrentFinalizedEvmCallErrorV1,
} from './current-finalized-evm-read-profile.js';
import type { StrictCurrentFinalizedEvmReadCallV1 } from './current-finalized-evm-read-model.js';
import {
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CONCURRENT_PER_CHAIN_V1,
  CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1,
  type StrictCurrentFinalizedEvmSnapshotRequestV1,
} from './current-finalized-evm-snapshot.js';
import { executeStrictFinalizedEvmBatchV1 } from './strict-current-finalized-evm-batch-executor.js';
import {
  cancelled,
  timedOut,
  unavailable,
} from './strict-current-finalized-evm-errors.js';
import {
  assertStrictFinalizedAnchorStableV1,
  createDeadlineScopeV1,
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
import {
  assertStrictFinalizedEvmCodeResultV1,
  createStrictFinalizedEvmCallParamsV1,
  createStrictFinalizedEvmCodeParamsV1,
  parseStrictFinalizedEvmCallResultV1,
} from './strict-current-finalized-evm-read-operations.js';
import type {
  DeadlineScopeV1,
  FinalizedAnchorV1,
  StrictRpcConfigSnapshotV1,
} from './strict-current-finalized-evm-types.js';

interface SnapshotEndpointPreflightV1 {
  readonly anchor: FinalizedAnchorV1;
  readonly lastRequestId: number;
}

type SnapshotRpcV1 = (
  method: string,
  params: readonly unknown[],
) => Promise<unknown>;

export interface StrictFinalizedSnapshotTransportSessionV1 {
  readonly chainId: ChainIdV1;
  readonly blockNumber: BlockNumberV1;
  readonly blockHash: Digest32V1;
  readonly read: (
    calls: readonly StrictCurrentFinalizedEvmReadCallV1[],
    deployedTargets: Set<EvmAddressV1>,
  ) => Promise<readonly string[]>;
}

export interface StrictFinalizedSnapshotTransportV1 {
  <T>(
    request: StrictCurrentFinalizedEvmSnapshotRequestV1,
    consume: (session: StrictFinalizedSnapshotTransportSessionV1) => Promise<T>,
  ): Promise<T>;
}

const SNAPSHOT_PREFLIGHT_PROBE_ADDRESS_V1 =
  '0x0000000000000000000000000000000000000000' as EvmAddressV1;

/**
 * Own the complete endpoint/preflight/deadline/anchor lifecycle for one scoped
 * finalized snapshot. Consumers receive only a pinned read session; transport
 * internals never leak into the snapshot materialization layer.
 */
export function createStrictFinalizedSnapshotTransportV1(
  config: StrictRpcConfigSnapshotV1,
): StrictFinalizedSnapshotTransportV1 {
  const runEndpoint = createStrictFinalizedEndpointRunnerV1({
    chainId: config.chainId,
    endpoints: config.endpoints,
    maxConcurrentPerChain: CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CONCURRENT_PER_CHAIN_V1,
    totalDeadlineMs: CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1,
    attemptTimeoutMs: CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
    messages: createSnapshotEndpointRunnerMessagesV1(config.chainId),
  });
  const run: StrictFinalizedSnapshotTransportV1 = async <T>(
    request: StrictCurrentFinalizedEvmSnapshotRequestV1,
    consume: (session: StrictFinalizedSnapshotTransportSessionV1) => Promise<T>,
  ): Promise<T> => runEndpoint({
    chainId: request.chainId,
    signal: request.signal,
    attempt: (endpoint, _attempt, deadline) =>
      preflightSnapshotEndpoint(config, endpoint, deadline.signal),
    accept: (endpoint, preflight, totalDeadline) => executePinnedSnapshotScope(
      config,
      endpoint,
      preflight,
      request,
      consume,
      totalDeadline,
    ),
  });
  return Object.freeze(run);
}

function createSnapshotEndpointRunnerMessagesV1(
  chainId: ChainIdV1,
): StrictFinalizedEndpointRunnerMessagesV1 {
  return Object.freeze({
    chainMismatch: (requested: ChainIdV1) =>
      `Snapshot adapter is configured for chain ${chainId}, not ${requested}`,
    cancelledBeforeAdmission:
      'Current-finalized snapshot was cancelled before transport admission',
    cancelled: 'Current-finalized snapshot was cancelled',
    totalDeadlineLabel: 'current-finalized snapshot total deadline',
    totalDeadline: (timeoutMs: number) =>
      `Current-finalized snapshot deadline exceeded ${timeoutMs}ms`,
    attemptDeadlineLabel: (attempt: number) =>
      `current-finalized snapshot preflight ${attempt}`,
    attemptDeadline: (timeoutMs: number) =>
      `Current-finalized snapshot preflight exceeded ${timeoutMs}ms`,
    attemptFailure: 'Current-finalized snapshot preflight failed closed',
    noEndpoint: 'No configured endpoint completed finalized snapshot preflight',
    saturated: (active: number) =>
      `Chain ${chainId} already has ${active} finalized snapshot in flight`,
  });
}

async function preflightSnapshotEndpoint(
  config: StrictRpcConfigSnapshotV1,
  endpoint: string,
  signal: AbortSignal,
): Promise<SnapshotEndpointPreflightV1> {
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
      `Configured snapshot endpoint reported chain ${remoteChainId}, expected ${config.chainId}`,
    );
  }
  const anchor = parseStrictFinalizedAnchorV1(
    await rpc('eth_getBlockByNumber', Object.freeze(['finalized', false])),
    'current finalized snapshot header',
  );
  const blockReference = config.blockReferenceProfile === 'eip1898'
    ? Object.freeze({ blockHash: anchor.blockHash, requireCanonical: true as const })
    : anchor.blockNumberQuantity;
  await probeSnapshotReadProfile(rpc, blockReference);
  if (config.blockReferenceProfile === 'trusted-block-number-hash-sandwich') {
    await assertStrictFinalizedAnchorStableV1(
      anchor,
      async () => parseStrictFinalizedAnchorV1(
        await rpc(
          'eth_getBlockByNumber',
          Object.freeze([anchor.blockNumberQuantity, false]),
        ),
        'post-preflight numbered header',
      ),
      'Snapshot read-profile preflight did not preserve the resolved finalized anchor',
    );
  }
  return Object.freeze({ anchor, lastRequestId: requestId });
}

async function probeSnapshotReadProfile(
  rpc: SnapshotRpcV1,
  blockReference: unknown,
): Promise<void> {
  try {
    assertStrictFinalizedEvmCodeResultV1(
      await rpc(
        'eth_getCode',
        createStrictFinalizedEvmCodeParamsV1(
          SNAPSHOT_PREFLIGHT_PROBE_ADDRESS_V1,
          blockReference,
        ),
      ),
      { allowNoCode: true },
    );
    const probeCall = Object.freeze({
      to: SNAPSHOT_PREFLIGHT_PROBE_ADDRESS_V1,
      data: '0x',
      maxReturnBytes: CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1,
    } satisfies StrictCurrentFinalizedEvmReadCallV1);
    parseStrictFinalizedEvmCallResultV1(
      await rpc(
        'eth_call',
        createStrictFinalizedEvmCallParamsV1(probeCall, blockReference),
      ),
      probeCall.maxReturnBytes,
    );
  } catch (cause) {
    throw unavailable(
      'Configured snapshot endpoint cannot execute the required finalized read profile',
      cause,
    );
  }
}

async function executePinnedSnapshotScope<T>(
  config: StrictRpcConfigSnapshotV1,
  endpoint: string,
  preflight: SnapshotEndpointPreflightV1,
  request: StrictCurrentFinalizedEvmSnapshotRequestV1,
  consume: (session: StrictFinalizedSnapshotTransportSessionV1) => Promise<T>,
  totalDeadline: DeadlineScopeV1,
): Promise<T> {
  const rpc = createPinnedSnapshotRpcClient(
    endpoint,
    preflight.lastRequestId,
    request,
    totalDeadline,
  );
  const session = Object.freeze({
    chainId: config.chainId,
    blockNumber: preflight.anchor.blockNumber,
    blockHash: preflight.anchor.blockHash,
    read: (
      calls: readonly StrictCurrentFinalizedEvmReadCallV1[],
      deployedTargets: Set<EvmAddressV1>,
    ) => executeSnapshotBatch(
      config,
      preflight.anchor,
      calls,
      deployedTargets,
      rpc,
      totalDeadline,
    ),
  } satisfies StrictFinalizedSnapshotTransportSessionV1);
  const result = await consume(session);
  if (config.blockReferenceProfile === 'trusted-block-number-hash-sandwich') {
    await assertStrictFinalizedAnchorStableV1(
      preflight.anchor,
      async () => parseStrictFinalizedAnchorV1(
        await rpc(
          'eth_getBlockByNumber',
          Object.freeze([preflight.anchor.blockNumberQuantity, false]),
        ),
        'post-snapshot numbered header',
      ),
      'Pinned snapshot hash sandwich did not preserve the resolved finalized anchor',
    );
  }
  if (request.signal.aborted) {
    throw cancelled('Current-finalized snapshot was cancelled');
  }
  if (totalDeadline.timedOut()) {
    throw timedOut(
      `Current-finalized snapshot deadline exceeded ${CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1}ms`,
    );
  }
  return result;
}

function createPinnedSnapshotRpcClient(
  endpoint: string,
  lastRequestId: number,
  request: StrictCurrentFinalizedEvmSnapshotRequestV1,
  totalDeadline: DeadlineScopeV1,
): SnapshotRpcV1 {
  let requestId = lastRequestId;
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (request.signal.aborted) {
      throw cancelled('Current-finalized snapshot was cancelled');
    }
    if (totalDeadline.timedOut()) {
      throw timedOut(
        `Current-finalized snapshot deadline exceeded ${CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1}ms`,
      );
    }
    const rpcDeadline = createDeadlineScopeV1(
      totalDeadline.signal,
      CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
      `current-finalized snapshot JSON-RPC ${method}`,
    );
    requestId += 1;
    try {
      return await postStrictFinalizedJsonRpcV1(
        endpoint,
        requestId,
        method,
        params,
        CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
        rpcDeadline.signal,
      );
    } catch (cause) {
      if (request.signal.aborted) {
        throw cancelled('Current-finalized snapshot was cancelled');
      }
      if (totalDeadline.timedOut()) {
        throw timedOut(
          `Current-finalized snapshot deadline exceeded ${CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1}ms`,
        );
      }
      if (rpcDeadline.timedOut()) {
        throw timedOut(
          `Current-finalized snapshot JSON-RPC exceeded ${CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1}ms`,
        );
      }
      if (cause instanceof CurrentFinalizedEvmCallErrorV1) throw cause;
      throw unavailable('Current-finalized snapshot JSON-RPC failed closed', cause);
    } finally {
      rpcDeadline.close();
    }
  };
}

async function executeSnapshotBatch(
  config: StrictRpcConfigSnapshotV1,
  anchor: FinalizedAnchorV1,
  calls: readonly StrictCurrentFinalizedEvmReadCallV1[],
  deployedTargets: Set<EvmAddressV1>,
  rpc: SnapshotRpcV1,
  totalDeadline: DeadlineScopeV1,
): Promise<readonly string[]> {
  const executeCallsAt = (blockReference: unknown) => executeStrictFinalizedEvmBatchV1({
    calls,
    blockReference,
    deployedTargets,
    rpc,
    settle: (operations) => settleStrictFinalizedParallelBatchV1(operations, totalDeadline),
  });

  const batch = await executeStrictFinalizedAnchorPolicyV1({
    blockReferenceProfile: config.blockReferenceProfile,
    anchor,
    executeAtReference: executeCallsAt,
    readPostAnchor: async () => parseStrictFinalizedAnchorV1(
      await rpc('eth_getBlockByNumber', Object.freeze([anchor.blockNumberQuantity, false])),
      'post-snapshot numbered header',
    ),
    anchorMismatchMessage:
      'Pinned snapshot hash sandwich did not preserve the resolved finalized anchor',
  });
  for (const target of batch.verifiedTargets) deployedTargets.add(target);
  return batch.returnData;
}
