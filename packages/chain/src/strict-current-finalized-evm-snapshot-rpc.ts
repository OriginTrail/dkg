import type {
  ChainIdV1,
  EvmAddressV1,
} from '@origintrail-official/dkg-core';

import {
  CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
  CurrentFinalizedEvmCallErrorV1,
} from './current-finalized-evm-read-profile.js';
import type { StrictCurrentFinalizedEvmReadCallV1 } from './current-finalized-evm-read-model.js';
import {
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CONCURRENT_PER_CHAIN_V1,
  CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1,
  createCurrentFinalizedEvmSnapshotBudgetV1,
  type StrictCurrentFinalizedEvmSnapshotRequestV1,
  type StrictCurrentFinalizedEvmSnapshotScopeV1,
  type StrictCurrentFinalizedEvmSnapshotSessionV1,
} from './current-finalized-evm-snapshot.js';
import { createNonqueueingAdmissionGateV1 } from './nonqueueing-admission.js';
import { executeStrictFinalizedEvmBatchV1 } from './strict-current-finalized-evm-batch-executor.js';
import {
  assertDeployedCode,
  assertStrictFinalizedAnchorStableV1,
  cancelled,
  createDeadlineScope,
  executeStrictFinalizedAnchorPolicyV1,
  isTerminalAttemptFailure,
  parseChainId,
  parseContractReturn,
  parseFinalizedAnchor,
  postJsonRpc,
  resourceLimited,
  settleParallelBatch,
  snapshotSnapshotCalls,
  snapshotSnapshotRequest,
  timedOut,
  unavailable,
  type CurrentFinalizedEvmBlockReferenceProfileV1,
  type DeadlineScope,
  type FinalizedAnchorV1,
} from './strict-current-finalized-evm-rpc.js';

export interface StrictFinalizedSnapshotRpcConfigV1 {
  readonly chainId: ChainIdV1;
  readonly endpoints: readonly string[];
  readonly blockReferenceProfile: CurrentFinalizedEvmBlockReferenceProfileV1;
}

interface SnapshotEndpointPreflightV1 {
  readonly anchor: FinalizedAnchorV1;
  readonly lastRequestId: number;
}

/** Package-internal runtime for a scoped, pinned finalized snapshot. */
export function createStrictFinalizedSnapshotRpcRuntimeV1(
  config: StrictFinalizedSnapshotRpcConfigV1,
): StrictCurrentFinalizedEvmSnapshotScopeV1 {
  const admission = createNonqueueingAdmissionGateV1<ChainIdV1>(
    CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CONCURRENT_PER_CHAIN_V1,
  );
  const withSnapshot: StrictCurrentFinalizedEvmSnapshotScopeV1 = async (
    inputRequest,
    consume,
  ) => {
    const request = snapshotSnapshotRequest(inputRequest);
    if (typeof consume !== 'function') {
      throw unavailable('Current-finalized snapshot consumer must be callable');
    }
    if (request.chainId !== config.chainId) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'chain-mismatch',
        `Snapshot adapter is configured for chain ${config.chainId}, not ${request.chainId}`,
      );
    }
    if (request.signal.aborted) {
      throw cancelled(
        'Current-finalized snapshot was cancelled before transport admission',
      );
    }

    return admission.run(request.chainId, async () => {
      const totalDeadline = createDeadlineScope(
        request.signal,
        CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1,
        'current-finalized snapshot total deadline',
      );
      let lastRetryableFailure: CurrentFinalizedEvmCallErrorV1 | undefined;
      try {
        for (let index = 0; index < config.endpoints.length; index += 1) {
          const attemptDeadline = createDeadlineScope(
            totalDeadline.signal,
            CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
            `current-finalized snapshot preflight ${index + 1}`,
          );
          let preflight: SnapshotEndpointPreflightV1 | undefined;
          try {
            preflight = await preflightSnapshotEndpoint(
              config,
              config.endpoints[index]!,
              attemptDeadline.signal,
            );
            if (
              request.signal.aborted
              || totalDeadline.timedOut()
              || attemptDeadline.timedOut()
            ) {
              throw classifySnapshotAttemptFailure(
                new Error('Snapshot preflight completed after its lifecycle ended'),
                request.signal,
                totalDeadline,
                attemptDeadline,
              );
            }
          } catch (cause) {
            const failure = classifySnapshotAttemptFailure(
              cause,
              request.signal,
              totalDeadline,
              attemptDeadline,
            );
            if (isTerminalAttemptFailure(failure)) throw failure;
            lastRetryableFailure = failure;
          } finally {
            attemptDeadline.close();
          }
          if (preflight !== undefined) {
            // Once trusted local consumer code begins, it is never replayed.
            return await executePinnedSnapshotScope(
              config,
              config.endpoints[index]!,
              preflight,
              request,
              consume,
              totalDeadline,
            );
          }
        }
        throw lastRetryableFailure
          ?? unavailable(
            'No configured endpoint completed finalized snapshot preflight',
          );
      } finally {
        totalDeadline.close();
      }
    }, (active) => new CurrentFinalizedEvmCallErrorV1(
      'concurrency-saturated',
      `Chain ${request.chainId} already has ${active} finalized snapshot in flight`,
    ));
  };
  return Object.freeze(withSnapshot);
}

async function preflightSnapshotEndpoint(
  config: StrictFinalizedSnapshotRpcConfigV1,
  endpoint: string,
  signal: AbortSignal,
): Promise<SnapshotEndpointPreflightV1> {
  let requestId = 0;
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    requestId += 1;
    return postJsonRpc(
      endpoint,
      requestId,
      method,
      params,
      CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
      signal,
    );
  };
  const remoteChainId = parseChainId(
    await rpc('eth_chainId', Object.freeze([])),
  );
  if (remoteChainId !== config.chainId) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'chain-mismatch',
      `Configured snapshot endpoint reported chain ${remoteChainId}, expected ${config.chainId}`,
    );
  }
  const anchor = parseFinalizedAnchor(
    await rpc('eth_getBlockByNumber', Object.freeze(['finalized', false])),
    'current finalized snapshot header',
  );
  return Object.freeze({ anchor, lastRequestId: requestId });
}

async function executePinnedSnapshotScope<T>(
  config: StrictFinalizedSnapshotRpcConfigV1,
  endpoint: string,
  preflight: SnapshotEndpointPreflightV1,
  request: StrictCurrentFinalizedEvmSnapshotRequestV1,
  consume: (session: StrictCurrentFinalizedEvmSnapshotSessionV1) => Promise<T>,
  totalDeadline: DeadlineScope,
): Promise<T> {
  let requestId = preflight.lastRequestId;
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (request.signal.aborted) {
      throw cancelled('Current-finalized snapshot was cancelled');
    }
    if (totalDeadline.timedOut()) {
      throw timedOut(
        `Current-finalized snapshot deadline exceeded ${CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1}ms`,
      );
    }
    const rpcDeadline = createDeadlineScope(
      totalDeadline.signal,
      CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
      `current-finalized snapshot JSON-RPC ${method}`,
    );
    requestId += 1;
    try {
      return await postJsonRpc(
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

  const budget = createCurrentFinalizedEvmSnapshotBudgetV1();
  const deployedTargets = new Set<EvmAddressV1>();
  let active = true;
  let inFlight: Promise<readonly string[]> | undefined;
  const read = Object.freeze(async (
    inputCalls: readonly StrictCurrentFinalizedEvmReadCallV1[],
  ): Promise<readonly string[]> => {
    if (!active) throw unavailable('Current-finalized snapshot session is closed');
    if (inFlight !== undefined) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'concurrency-saturated',
        'Current-finalized snapshot permits only one dynamic batch at a time',
      );
    }
    const calls = snapshotSnapshotCalls(inputCalls);
    try {
      budget.consume(calls);
    } catch {
      throw resourceLimited(
        'Current-finalized snapshot exceeded its fixed scan budget',
      );
    }
    let operation!: Promise<readonly string[]>;
    operation = executeSnapshotBatch(
      config,
      preflight.anchor,
      calls,
      deployedTargets,
      rpc,
      totalDeadline,
    ).finally(() => {
      if (inFlight === operation) inFlight = undefined;
    });
    inFlight = operation;
    return operation;
  });
  const session = Object.freeze({
    chainId: config.chainId,
    blockNumber: preflight.anchor.blockNumber,
    blockHash: preflight.anchor.blockHash,
    read,
  } satisfies StrictCurrentFinalizedEvmSnapshotSessionV1);

  let result!: T;
  let callbackFailure: unknown;
  let callbackSucceeded = false;
  try {
    result = await consume(session);
    callbackSucceeded = true;
  } catch (cause) {
    callbackFailure = cause;
  }
  active = false;

  const danglingRead = inFlight;
  if (danglingRead !== undefined) {
    await danglingRead.catch(() => undefined);
    if (callbackSucceeded) {
      callbackSucceeded = false;
      callbackFailure = unavailable(
        'Current-finalized snapshot consumer settled with an unawaited read in flight',
      );
    }
  }

  if (!callbackSucceeded) throw callbackFailure;
  if (config.blockReferenceProfile === 'trusted-block-number-hash-sandwich') {
    await assertStrictFinalizedAnchorStableV1(
      preflight.anchor,
      async () => parseFinalizedAnchor(
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

async function executeSnapshotBatch(
  config: StrictFinalizedSnapshotRpcConfigV1,
  anchor: FinalizedAnchorV1,
  calls: readonly StrictCurrentFinalizedEvmReadCallV1[],
  deployedTargets: Set<EvmAddressV1>,
  rpc: (method: string, params: readonly unknown[]) => Promise<unknown>,
  totalDeadline: DeadlineScope,
): Promise<readonly string[]> {
  const executeCallsAt = (blockReference: unknown) => executeStrictFinalizedEvmBatchV1({
    calls,
    blockReference,
    deployedTargets,
    rpc,
    settle: (operations) => settleParallelBatch(operations, totalDeadline),
    assertDeployedCode,
    parseContractReturn,
  });

  const batch = await executeStrictFinalizedAnchorPolicyV1({
    blockReferenceProfile: config.blockReferenceProfile,
    anchor,
    executeAtReference: executeCallsAt,
    readPostAnchor: async () => parseFinalizedAnchor(
      await rpc('eth_getBlockByNumber', Object.freeze([anchor.blockNumberQuantity, false])),
      'post-snapshot numbered header',
    ),
    anchorMismatchMessage:
      'Pinned snapshot hash sandwich did not preserve the resolved finalized anchor',
    missingResultMessage: 'Finalized snapshot batch produced no results',
  });
  for (const target of batch.verifiedTargets) deployedTargets.add(target);
  return batch.returnData;
}

function classifySnapshotAttemptFailure(
  cause: unknown,
  callerSignal: AbortSignal,
  totalDeadline: DeadlineScope,
  attemptDeadline: DeadlineScope,
): CurrentFinalizedEvmCallErrorV1 {
  if (callerSignal.aborted) {
    return cancelled('Current-finalized snapshot was cancelled');
  }
  if (totalDeadline.timedOut()) {
    return timedOut(
      `Current-finalized snapshot deadline exceeded ${CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1}ms`,
    );
  }
  if (attemptDeadline.timedOut()) {
    return timedOut(
      `Current-finalized snapshot preflight exceeded ${CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1}ms`,
    );
  }
  if (cause instanceof CurrentFinalizedEvmCallErrorV1) return cause;
  return unavailable('Current-finalized snapshot preflight failed closed', cause);
}
