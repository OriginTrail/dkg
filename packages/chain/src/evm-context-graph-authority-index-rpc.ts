// SPDX-License-Identifier: Apache-2.0

/** Physical RPC lifetime and cached-head retry for the EVM authority-index reader. */
import { setTimeout as sleep } from 'node:timers/promises';
import { RPC_LOG_SCAN_TIMEOUT_MS } from './evm-adapter-constants.js';
import { isContextGraphAuthorityIndexRetryableError } from './context-graph-authority-index-errors.js';
import { withOwnedRpcRequestContext, withRpcRequestContext, withRpcRequestTimeout } from './rpc-request-transport.js';


/** Bound one physical authority-index RPC without capping the durable scan. */
export function readEvmContextGraphAuthorityIndexRpcV1<T>(
  operation: string,
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const bounded = () => withRpcRequestTimeout(
    RPC_LOG_SCAN_TIMEOUT_MS,
    operation,
    read,
  );
  return signal === undefined
    ? bounded()
    : withRpcRequestContext({ signal }, bounded);
}

/**
 * Shared page/hash work belongs to the authority-index lifecycle, not to the
 * first caller whose AsyncLocalStorage context starts the single flight.
 */
export function readOwnedAuthorityIndexRpcV1<T>(
  lifecycleSignal: AbortSignal,
  operation: string,
  read: () => Promise<T>,
): Promise<T> {
  return withOwnedRpcRequestContext(
    { signal: lifecycleSignal },
    () => readEvmContextGraphAuthorityIndexRpcV1(operation, read),
  );
}

/** Refresh an ethers-cached tip once before classifying cursor skew as endpoint failure. */
export async function retryCachedAuthorityIndexHeadV1<T>(
  read: () => Promise<T>,
  lifecycleSignal: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isContextGraphAuthorityIndexRetryableError(error)
      || error.reason !== 'cursor-ahead') throw error;
    // Rapid writes can advance the durable cursor while `getBlock('latest')`
    // still returns a recently cached block from this very endpoint. A
    // persistent lag remains retryable and takes the usual endpoint failover.
    await sleep(300, undefined, { signal: lifecycleSignal });
    callerSignal?.throwIfAborted();
    return read();
  }
}
