// SPDX-License-Identifier: Apache-2.0

import { type Contract, type JsonRpcProvider } from 'ethers';
import {
  ContextGraphAuthorityIndex,
} from './context-graph-authority-index.js';
import type { ContextGraphAuthorityIndexCheckpoint } from
  './context-graph-authority-index-checkpoint.js';
import {
  contextGraphAuthorityEventTopics,
  normalizeContextGraphAuthorityIndexLog,
} from './evm-context-graph-authority-source.js';
import { readAdaptiveEvmLogRange } from './evm-log-range.js';
import { withRpcRequestAbortSignal } from './rpc-request-transport.js';

export interface EvmContextGraphAuthorityIndexReadV1 {
  readonly checkpoint: ContextGraphAuthorityIndexCheckpoint;
  /** Final fence shared by snapshot and revision projections. */
  stabilize(): Promise<void>;
}

/**
 * One shared finalized-anchor/index-scan boundary for every authority
 * projection. Callers supply only the projection-specific operation label.
 */
export async function readEvmContextGraphAuthorityIndexV1(input: Readonly<{
  index: ContextGraphAuthorityIndex;
  deploymentId: string;
  contract: Contract;
  contractAddress: string;
  provider: JsonRpcProvider;
  deploymentBlockNumber: number;
  finalized: Readonly<{ number: number; hash: string }>;
  pageSize: number;
  stabilizationOperation: 'resolution' | 'revision scan';
  signal?: AbortSignal;
}>): Promise<EvmContextGraphAuthorityIndexReadV1> {
  const authorityTopics = contextGraphAuthorityEventTopics(input.contract.interface);
  const checkpoint = await input.index.snapshot({
    scope: [input.deploymentId, input.contractAddress].join(':'),
    readScope: input.provider,
    deploymentBlockNumber: input.deploymentBlockNumber,
    finalized: input.finalized,
    pageSize: input.pageSize,
    signal: input.signal,
    readBlockHash: async (blockNumber, lifecycleSignal) => (
      (await withRpcRequestAbortSignal(
        lifecycleSignal,
        () => input.provider.getBlock(blockNumber),
      ))?.hash ?? null
    ),
    readPage: async (fromBlock, toBlock, lifecycleSignal) => {
      const logs = await readAdaptiveEvmLogRange({
        read: (rangeFrom, rangeTo) => withRpcRequestAbortSignal(
          lifecycleSignal,
          () => input.provider.getLogs({
            address: input.contractAddress,
            topics: [[...authorityTopics]],
            fromBlock: rangeFrom,
            toBlock: rangeTo,
          }),
        ),
        fromBlock,
        toBlock,
        signal: lifecycleSignal,
      });
      return logs.map((log) => normalizeContextGraphAuthorityIndexLog(
        input.contract.interface,
        log,
      ));
    },
  });
  input.signal?.throwIfAborted();
  return Object.freeze({
    checkpoint,
    stabilize: async () => {
      input.signal?.throwIfAborted();
      const stable = input.signal === undefined
        ? await input.provider.getBlock(input.finalized.number)
        : await withRpcRequestAbortSignal(
            input.signal,
            () => input.provider.getBlock(input.finalized.number),
          );
      if (stable?.hash?.toLowerCase() !== input.finalized.hash.toLowerCase()) {
        throw new Error(
          `finalized Context Graph authority anchor changed during ${input.stabilizationOperation}`,
        );
      }
    },
  });
}
