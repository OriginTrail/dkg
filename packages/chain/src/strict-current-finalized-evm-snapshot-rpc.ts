import type { EvmAddressV1 } from '@origintrail-official/dkg-core';

import {
  CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
  CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1,
  CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1,
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
import { executeStrictFinalizedEvmBatchV1 } from './strict-current-finalized-evm-batch-executor.js';
import {
  snapshotCurrentFinalizedEvmSnapshotCallsV1,
  snapshotCurrentFinalizedEvmSnapshotRequestV1,
} from './current-finalized-evm-read-validation.js';
import {
  assertStrictFinalizedAnchorStableV1,
  cancelled,
  createDeadlineScope,
  createStrictFinalizedEndpointRunnerV1,
  executeStrictFinalizedAnchorPolicyV1,
  parseChainId,
  parseFinalizedAnchor,
  postJsonRpc,
  resourceLimited,
  settleParallelBatch,
  timedOut,
  unavailable,
  type DeadlineScope,
  type FinalizedAnchorV1,
  type StrictRpcConfigSnapshotV1,
} from './strict-current-finalized-evm-transport.js';
import { isCanonicalLowerHexBytesV1 } from './strict-finalized-evm-bytes.js';

interface SnapshotEndpointPreflightV1 {
  readonly anchor: FinalizedAnchorV1;
  readonly lastRequestId: number;
}

type SnapshotRpcV1 = (
  method: string,
  params: readonly unknown[],
) => Promise<unknown>;

interface SnapshotReadSessionControllerV1 {
  readonly session: StrictCurrentFinalizedEvmSnapshotSessionV1;
  readonly closeAndDrain: () => Promise<boolean>;
}

const SNAPSHOT_PREFLIGHT_PROBE_ADDRESS_V1 =
  '0x0000000000000000000000000000000000000000' as EvmAddressV1;
const SNAPSHOT_PREFLIGHT_PROBE_GAS_QUANTITY_V1 =
  `0x${CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1.toString(16)}`;
/** Package-internal runtime for a scoped, pinned finalized snapshot. */
export function createStrictFinalizedSnapshotRpcRuntimeV1(
  config: StrictRpcConfigSnapshotV1,
): StrictCurrentFinalizedEvmSnapshotScopeV1 {
  const runEndpoint = createStrictFinalizedEndpointRunnerV1({
    mode: 'snapshot-preflight',
    chainId: config.chainId,
    endpoints: config.endpoints,
    maxConcurrentPerChain: CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CONCURRENT_PER_CHAIN_V1,
    totalDeadlineMs: CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1,
    attemptTimeoutMs: CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
  });
  const withSnapshot: StrictCurrentFinalizedEvmSnapshotScopeV1 = async (
    inputRequest,
    consume,
  ) => {
    const request = snapshotCurrentFinalizedEvmSnapshotRequestV1(inputRequest);
    if (typeof consume !== 'function') {
      throw unavailable('Current-finalized snapshot consumer must be callable');
    }
    return runEndpoint({
      chainId: request.chainId,
      signal: request.signal,
      attempt: (endpoint, _attempt, deadline) =>
        preflightSnapshotEndpoint(config, endpoint, deadline.signal),
      // This runs outside the runner's retry catch, so consumer code is never replayed.
      accept: (endpoint, preflight, totalDeadline) => executePinnedSnapshotScope(
        config,
        endpoint,
        preflight,
        request,
        consume,
        totalDeadline,
      ),
    });
  };
  return Object.freeze(withSnapshot);
}

async function preflightSnapshotEndpoint(
  config: StrictRpcConfigSnapshotV1,
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
  const blockReference = config.blockReferenceProfile === 'eip1898'
    ? Object.freeze({ blockHash: anchor.blockHash, requireCanonical: true as const })
    : anchor.blockNumberQuantity;
  await probeSnapshotReadProfile(rpc, blockReference);
  if (config.blockReferenceProfile === 'trusted-block-number-hash-sandwich') {
    await assertStrictFinalizedAnchorStableV1(
      anchor,
      async () => parseFinalizedAnchor(
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
    const code = await rpc('eth_getCode', Object.freeze([
      SNAPSHOT_PREFLIGHT_PROBE_ADDRESS_V1,
      blockReference,
    ]));
    if (!isCanonicalLowerHexBytesV1(code)) {
      throw new Error('eth_getCode capability probe returned malformed bytes');
    }
    const callResult = await rpc('eth_call', Object.freeze([
      Object.freeze({
        from: CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1,
        to: SNAPSHOT_PREFLIGHT_PROBE_ADDRESS_V1,
        data: '0x',
        gas: SNAPSHOT_PREFLIGHT_PROBE_GAS_QUANTITY_V1,
      }),
      blockReference,
    ]));
    if (!isCanonicalLowerHexBytesV1(callResult)) {
      throw new Error('eth_call capability probe returned malformed bytes');
    }
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
  consume: (session: StrictCurrentFinalizedEvmSnapshotSessionV1) => Promise<T>,
  totalDeadline: DeadlineScope,
): Promise<T> {
  const rpc = createPinnedSnapshotRpcClient(
    endpoint,
    preflight.lastRequestId,
    request,
    totalDeadline,
  );
  const readSession = createSnapshotReadSession(
    config,
    preflight.anchor,
    rpc,
    totalDeadline,
  );
  const result = await runConsumerWithDrainedReads(readSession, consume);
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

function createPinnedSnapshotRpcClient(
  endpoint: string,
  lastRequestId: number,
  request: StrictCurrentFinalizedEvmSnapshotRequestV1,
  totalDeadline: DeadlineScope,
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
}

function createSnapshotReadSession(
  config: StrictRpcConfigSnapshotV1,
  anchor: FinalizedAnchorV1,
  rpc: SnapshotRpcV1,
  totalDeadline: DeadlineScope,
): Readonly<SnapshotReadSessionControllerV1> {
  const budget = createCurrentFinalizedEvmSnapshotBudgetV1();
  const deployedTargets = new Set<EvmAddressV1>();
  let active = true;
  let inFlight: Promise<readonly string[]> | undefined;
  const read = Object.freeze((
    inputCalls: readonly StrictCurrentFinalizedEvmReadCallV1[],
  ): Promise<readonly string[]> => {
    if (!active) {
      return handledRejectedRead(unavailable('Current-finalized snapshot session is closed'));
    }
    if (inFlight !== undefined) {
      return handledRejectedRead(new CurrentFinalizedEvmCallErrorV1(
        'concurrency-saturated',
        'Current-finalized snapshot permits only one dynamic batch at a time',
      ));
    }
    let calls: readonly StrictCurrentFinalizedEvmReadCallV1[];
    try {
      calls = snapshotCurrentFinalizedEvmSnapshotCallsV1(inputCalls);
    } catch (cause) {
      return handledRejectedRead(cause);
    }
    try {
      budget.consume(calls);
    } catch {
      return handledRejectedRead(resourceLimited(
        'Current-finalized snapshot exceeded its fixed scan budget',
      ));
    }
    const operation = executeSnapshotBatch(
      config,
      anchor,
      calls,
      deployedTargets,
      rpc,
      totalDeadline,
    );
    const clearInFlight = () => {
      if (inFlight === operation) inFlight = undefined;
    };
    // Attach both handlers to the same promise exposed to the consumer. This
    // lets the scope own/drain an unawaited rejection without creating a
    // second rejecting wrapper promise that can surface as unhandled.
    void operation.then(clearInFlight, clearInFlight);
    inFlight = operation;
    return operation;
  });
  const session = Object.freeze({
    chainId: config.chainId,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
    read,
  } satisfies StrictCurrentFinalizedEvmSnapshotSessionV1);
  return Object.freeze({
    session,
    closeAndDrain: async (): Promise<boolean> => {
      active = false;
      const danglingRead = inFlight;
      if (danglingRead === undefined) return false;
      await danglingRead.catch(() => undefined);
      return true;
    },
  });
}

async function runConsumerWithDrainedReads<T>(
  readSession: Readonly<SnapshotReadSessionControllerV1>,
  consume: (session: StrictCurrentFinalizedEvmSnapshotSessionV1) => Promise<T>,
): Promise<T> {
  let execution:
    | Readonly<{ readonly ok: true; readonly value: T }>
    | Readonly<{ readonly ok: false; readonly failure: unknown }>;
  try {
    execution = Object.freeze({ ok: true, value: await consume(readSession.session) });
  } catch (cause) {
    execution = Object.freeze({ ok: false, failure: cause });
  }
  const hadDanglingRead = await readSession.closeAndDrain();
  if (execution.ok && hadDanglingRead) {
    throw unavailable(
      'Current-finalized snapshot consumer settled with an unawaited read in flight',
    );
  }
  if (!execution.ok) throw execution.failure;
  return execution.value;
}

function handledRejectedRead(cause: unknown): Promise<never> {
  const rejected = Promise.reject(cause);
  void rejected.catch(() => undefined);
  return rejected;
}

async function executeSnapshotBatch(
  config: StrictRpcConfigSnapshotV1,
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
  });
  for (const target of batch.verifiedTargets) deployedTargets.add(target);
  return batch.returnData;
}
