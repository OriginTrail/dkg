// SPDX-License-Identifier: Apache-2.0

/**
 * The EVM adapter's side of one ContextGraphStorage range read: the governed,
 * failover-aware reads that `readContextGraphStorageRangeV1` runs on, and the
 * aggregate request that carries a run of ids in a background pass (see
 * evm-context-graph-storage-enumeration.ts).
 */

import type { Contract, JsonRpcProvider } from 'ethers';

import type {
  ContextGraphStorageRange,
  ContextGraphStorageRangeOptions,
} from './chain-adapter.js';
import { errorMessage } from './evm-adapter-errors.js';
import type { BackgroundContractReadBatching } from './evm-background-read-batching.js';
import {
  CONTEXT_GRAPH_STORAGE_ENUMERATION_RPC_CONSUMER,
  contextGraphStorageBatchCalls,
  decodeContextGraphStorageBatch,
  isContextGraphStorageEnumerationReadRetryable,
  isNonexistentContextGraphStorageRevert,
  readContextGraphStorageRangeV1,
} from './evm-context-graph-storage-enumeration.js';
import { resolveEvmFinalityAnchorBlockV1 } from './evm-finality-anchor.js';
import type { ReadOpts } from './rpc-failover-client.js';
import { hostOnlyRpcText } from './rpc-failover-log.js';
import { isRpcRequestGovernorQueueFullError } from './rpc-request-governor.js';
import { activeRpcRequestAbortSignal, withRpcRequestContext } from './rpc-request-transport.js';

/** What the adapter lends a range read: its bound contract and its read paths. */
export interface EvmContextGraphStorageRangeReads {
  readonly storage: Contract;
  readonly finalityConfirmations: number;
  readonly readTipProvider: <T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
    opts?: ReadOpts,
  ) => Promise<T>;
  readonly readContractWith: <T>(
    contract: Contract,
    label: string,
    fn: (contract: Contract) => Promise<T>,
    opts?: ReadOpts,
  ) => Promise<T>;
  readonly readBatching: BackgroundContractReadBatching;
}

/** See ChainAdapter.readContextGraphStorageRange. */
export async function readEvmContextGraphStorageRange(
  reads: EvmContextGraphStorageRangeReads,
  options: ContextGraphStorageRangeOptions,
): Promise<ContextGraphStorageRange> {
  const { storage } = reads;
  const storageAddress = (await storage.getAddress()).toLowerCase();
  const label = CONTEXT_GRAPH_STORAGE_ENUMERATION_RPC_CONSUMER;
  const readOptions = {
    signal: options.signal,
    rpcUsageConsumer: CONTEXT_GRAPH_STORAGE_ENUMERATION_RPC_CONSUMER,
    // Background bulk reads, like the authority snapshot: the wide-scan
    // attempt cap lets a pass queued behind the RPC governor's background
    // startup jitter finish instead of timing out on the 4 s point-read cap.
    policy: 'wideLogScan' as const,
  };
  const viewReadOptions = {
    ...readOptions,
    isRetryable: isContextGraphStorageEnumerationReadRetryable,
  };
  const range = await readContextGraphStorageRangeV1({
    storageAddress,
    readAnchor: () => reads.readTipProvider(
      `${label} anchor`,
      async (provider) => {
        const anchor = await resolveEvmFinalityAnchorBlockV1({
          finalityConfirmations: reads.finalityConfirmations,
          readHead: () => provider.getBlock('latest'),
          readBlockAt: (blockNumber) => provider.getBlock(blockNumber),
          unavailable: (detail) => new Error(
            `Context Graph storage enumeration anchor unavailable: ${detail}`,
          ),
        });
        return { number: anchor.number, hash: anchor.hash };
      },
      readOptions,
    ),
    readLatestId: (blockTag) => reads.readContractWith(
      storage,
      `${label} getLatestContextGraphId`,
      (c) => c.getLatestContextGraphId({ blockTag }),
      viewReadOptions,
    ),
    readContextGraph: (contextGraphId, blockTag) => reads.readContractWith(
      storage,
      `${label} getContextGraph`,
      (c) => c.getContextGraph(contextGraphId, { blockTag }),
      viewReadOptions,
    ),
    readNameHash: (contextGraphId, blockTag) => reads.readContractWith(
      storage,
      `${label} getNameHash`,
      (c) => c.getNameHash(contextGraphId, { blockTag }),
      viewReadOptions,
    ),
    isNonexistentContextGraph: isNonexistentContextGraphStorageRevert,
    // A background pass reads a whole run of ids in one request, pinned to
    // the anchor like the reads above and billed to the same consumer.
    readEntriesBatch: async (contextGraphIds, blockTag) => {
      try {
        // The range's own signal ends this wait too, as it does every other read.
        const results = await withRpcRequestContext(
          { signal: options.signal },
          () => reads.readBatching.aggregateAtBlock(
            () => contextGraphStorageBatchCalls(storage.interface, storageAddress, contextGraphIds),
            blockTag,
            (multicall3, request) => reads.readContractWith(
              multicall3,
              `${label} aggregate3`,
              request,
              viewReadOptions,
            ),
          ),
        );
        return results === undefined
          ? undefined
          : decodeContextGraphStorageBatch(storage.interface, contextGraphIds, results);
      } catch (error) {
        // Cancelled, or refused by the node's own request admission: every
        // id read on its own would meet the same.
        options.signal?.throwIfAborted();
        activeRpcRequestAbortSignal()?.throwIfAborted();
        if (isRpcRequestGovernorQueueFullError(error)) throw error;
        // Any other failure of the request: each id is read as before.
        console.warn(
          `[chain] ${label}: aggregate request failed, reading id by id: `
            + hostOnlyRpcText(errorMessage(error)),
        );
        return undefined;
      }
    },
  }, options);
  // Cancelled through the request context it runs in: reject, as it does for
  // its own signal, instead of handing back the ids read before that.
  activeRpcRequestAbortSignal()?.throwIfAborted();
  return range;
}
