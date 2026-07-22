import type {
  BlockNumberV1,
  ChainIdV1,
  Digest32V1,
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

export interface StrictFinalizedSnapshotRpcConfigV1 {
  readonly chainId: ChainIdV1;
  readonly endpoints: readonly string[];
  readonly blockReferenceProfile: 'eip1898' | 'trusted-block-number-hash-sandwich';
}

interface FinalizedAnchorV1 {
  readonly blockNumber: BlockNumberV1;
  readonly blockNumberQuantity: string;
  readonly blockHash: Digest32V1;
}

interface DeadlineScopeV1 {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly close: () => void;
}

export interface StrictFinalizedSnapshotRpcDependenciesV1 {
  readonly snapshotRequest: (input: unknown) => StrictCurrentFinalizedEvmSnapshotRequestV1;
  readonly snapshotCalls: (input: unknown) => readonly StrictCurrentFinalizedEvmReadCallV1[];
  readonly createDeadline: (
    parent: AbortSignal,
    timeoutMs: number,
    label: string,
  ) => DeadlineScopeV1;
  readonly postJsonRpc: (
    endpoint: string,
    id: number,
    method: string,
    params: readonly unknown[],
    maxResponseBytes: number,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly parseChainId: (input: unknown) => ChainIdV1;
  readonly parseAnchor: (input: unknown, label: string) => FinalizedAnchorV1;
  readonly assertDeployedCode: (input: unknown) => void;
  readonly parseContractReturn: (input: unknown, maxBytes: number) => string;
  readonly settle: <T>(
    operations: readonly Promise<T>[],
    deadline: DeadlineScopeV1,
  ) => Promise<readonly T[]>;
  readonly isTerminalFailure: (error: CurrentFinalizedEvmCallErrorV1) => boolean;
  readonly isAnchorDependentResourceLimit: (error: CurrentFinalizedEvmCallErrorV1) => boolean;
  readonly unavailable: (message: string, cause?: unknown) => CurrentFinalizedEvmCallErrorV1;
  readonly timedOut: (message: string) => CurrentFinalizedEvmCallErrorV1;
  readonly resourceLimited: (message: string) => CurrentFinalizedEvmCallErrorV1;
  readonly cancelled: (message: string) => CurrentFinalizedEvmCallErrorV1;
}

interface SnapshotEndpointPreflightV1 {
  readonly anchor: FinalizedAnchorV1;
  readonly lastRequestId: number;
}

/** Package-internal runtime for a scoped, pinned finalized snapshot. */
export function createStrictFinalizedSnapshotRpcRuntimeV1(
  config: StrictFinalizedSnapshotRpcConfigV1,
  dependencies: StrictFinalizedSnapshotRpcDependenciesV1,
): StrictCurrentFinalizedEvmSnapshotScopeV1 {
  const admission = createNonqueueingAdmissionGateV1<ChainIdV1>(
    CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CONCURRENT_PER_CHAIN_V1,
  );
  const withSnapshot: StrictCurrentFinalizedEvmSnapshotScopeV1 = async (
    inputRequest,
    consume,
  ) => {
    const request = dependencies.snapshotRequest(inputRequest);
    if (typeof consume !== 'function') {
      throw dependencies.unavailable('Current-finalized snapshot consumer must be callable');
    }
    if (request.chainId !== config.chainId) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'chain-mismatch',
        `Snapshot adapter is configured for chain ${config.chainId}, not ${request.chainId}`,
      );
    }
    if (request.signal.aborted) {
      throw dependencies.cancelled(
        'Current-finalized snapshot was cancelled before transport admission',
      );
    }

    return admission.run(request.chainId, async () => {
      const totalDeadline = dependencies.createDeadline(
        request.signal,
        CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1,
        'current-finalized snapshot total deadline',
      );
      let lastRetryableFailure: CurrentFinalizedEvmCallErrorV1 | undefined;
      try {
        for (let index = 0; index < config.endpoints.length; index += 1) {
          const attemptDeadline = dependencies.createDeadline(
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
              dependencies,
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
                dependencies,
              );
            }
          } catch (cause) {
            const failure = classifySnapshotAttemptFailure(
              cause,
              request.signal,
              totalDeadline,
              attemptDeadline,
              dependencies,
            );
            if (dependencies.isTerminalFailure(failure)) throw failure;
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
              dependencies,
            );
          }
        }
        throw lastRetryableFailure
          ?? dependencies.unavailable(
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
  dependencies: StrictFinalizedSnapshotRpcDependenciesV1,
): Promise<SnapshotEndpointPreflightV1> {
  let requestId = 0;
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    requestId += 1;
    return dependencies.postJsonRpc(
      endpoint,
      requestId,
      method,
      params,
      CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
      signal,
    );
  };
  const remoteChainId = dependencies.parseChainId(
    await rpc('eth_chainId', Object.freeze([])),
  );
  if (remoteChainId !== config.chainId) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'chain-mismatch',
      `Configured snapshot endpoint reported chain ${remoteChainId}, expected ${config.chainId}`,
    );
  }
  const anchor = dependencies.parseAnchor(
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
  totalDeadline: DeadlineScopeV1,
  dependencies: StrictFinalizedSnapshotRpcDependenciesV1,
): Promise<T> {
  let requestId = preflight.lastRequestId;
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (request.signal.aborted) {
      throw dependencies.cancelled('Current-finalized snapshot was cancelled');
    }
    if (totalDeadline.timedOut()) {
      throw dependencies.timedOut(
        `Current-finalized snapshot deadline exceeded ${CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1}ms`,
      );
    }
    const rpcDeadline = dependencies.createDeadline(
      totalDeadline.signal,
      CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
      `current-finalized snapshot JSON-RPC ${method}`,
    );
    requestId += 1;
    try {
      return await dependencies.postJsonRpc(
        endpoint,
        requestId,
        method,
        params,
        CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
        rpcDeadline.signal,
      );
    } catch (cause) {
      if (request.signal.aborted) {
        throw dependencies.cancelled('Current-finalized snapshot was cancelled');
      }
      if (totalDeadline.timedOut()) {
        throw dependencies.timedOut(
          `Current-finalized snapshot deadline exceeded ${CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1}ms`,
        );
      }
      if (rpcDeadline.timedOut()) {
        throw dependencies.timedOut(
          `Current-finalized snapshot JSON-RPC exceeded ${CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1}ms`,
        );
      }
      if (cause instanceof CurrentFinalizedEvmCallErrorV1) throw cause;
      throw dependencies.unavailable('Current-finalized snapshot JSON-RPC failed closed', cause);
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
    if (!active) throw dependencies.unavailable('Current-finalized snapshot session is closed');
    if (inFlight !== undefined) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'concurrency-saturated',
        'Current-finalized snapshot permits only one dynamic batch at a time',
      );
    }
    const calls = dependencies.snapshotCalls(inputCalls);
    try {
      budget.consume(calls);
    } catch {
      throw dependencies.resourceLimited(
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
      dependencies,
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
      callbackFailure = dependencies.unavailable(
        'Current-finalized snapshot consumer settled with an unawaited read in flight',
      );
    }
  }

  if (!callbackSucceeded) throw callbackFailure;
  if (config.blockReferenceProfile === 'trusted-block-number-hash-sandwich') {
    await assertSnapshotAnchorStable(rpc, preflight.anchor, dependencies);
  }
  if (request.signal.aborted) {
    throw dependencies.cancelled('Current-finalized snapshot was cancelled');
  }
  if (totalDeadline.timedOut()) {
    throw dependencies.timedOut(
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
  totalDeadline: DeadlineScopeV1,
  dependencies: StrictFinalizedSnapshotRpcDependenciesV1,
): Promise<readonly string[]> {
  const executeCallsAt = (blockReference: unknown) => executeStrictFinalizedEvmBatchV1({
    calls,
    blockReference,
    deployedTargets,
    rpc,
    settle: (operations) => dependencies.settle(operations, totalDeadline),
    assertDeployedCode: dependencies.assertDeployedCode,
    parseContractReturn: dependencies.parseContractReturn,
  });

  if (config.blockReferenceProfile === 'eip1898') {
    const batch = await executeCallsAt(Object.freeze({
      blockHash: anchor.blockHash,
      requireCanonical: true as const,
    }));
    for (const target of batch.verifiedTargets) deployedTargets.add(target);
    return batch.returnData;
  }

  let anchorDependentFailure: CurrentFinalizedEvmCallErrorV1 | undefined;
  let batch: Awaited<ReturnType<typeof executeCallsAt>> | undefined;
  try {
    batch = await executeCallsAt(anchor.blockNumberQuantity);
  } catch (cause) {
    if (
      cause instanceof CurrentFinalizedEvmCallErrorV1
      && (
        cause.code === 'no-code'
        || cause.code === 'revert'
        || cause.code === 'malformed-return'
        || dependencies.isAnchorDependentResourceLimit(cause)
      )
    ) {
      anchorDependentFailure = cause;
    } else {
      throw cause;
    }
  }
  await assertSnapshotAnchorStable(rpc, anchor, dependencies);
  if (anchorDependentFailure !== undefined) throw anchorDependentFailure;
  if (batch === undefined) {
    throw dependencies.unavailable('Finalized snapshot batch produced no results');
  }
  for (const target of batch.verifiedTargets) deployedTargets.add(target);
  return batch.returnData;
}

async function assertSnapshotAnchorStable(
  rpc: (method: string, params: readonly unknown[]) => Promise<unknown>,
  anchor: FinalizedAnchorV1,
  dependencies: StrictFinalizedSnapshotRpcDependenciesV1,
): Promise<void> {
  const postAnchor = dependencies.parseAnchor(
    await rpc('eth_getBlockByNumber', Object.freeze([anchor.blockNumberQuantity, false])),
    'post-snapshot numbered header',
  );
  if (
    postAnchor.blockNumber !== anchor.blockNumber
    || postAnchor.blockHash !== anchor.blockHash
  ) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      'Pinned snapshot hash sandwich did not preserve the resolved finalized anchor',
    );
  }
}

function classifySnapshotAttemptFailure(
  cause: unknown,
  callerSignal: AbortSignal,
  totalDeadline: DeadlineScopeV1,
  attemptDeadline: DeadlineScopeV1,
  dependencies: StrictFinalizedSnapshotRpcDependenciesV1,
): CurrentFinalizedEvmCallErrorV1 {
  if (callerSignal.aborted) {
    return dependencies.cancelled('Current-finalized snapshot was cancelled');
  }
  if (totalDeadline.timedOut()) {
    return dependencies.timedOut(
      `Current-finalized snapshot deadline exceeded ${CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1}ms`,
    );
  }
  if (attemptDeadline.timedOut()) {
    return dependencies.timedOut(
      `Current-finalized snapshot preflight exceeded ${CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1}ms`,
    );
  }
  if (cause instanceof CurrentFinalizedEvmCallErrorV1) return cause;
  return dependencies.unavailable('Current-finalized snapshot preflight failed closed', cause);
}
