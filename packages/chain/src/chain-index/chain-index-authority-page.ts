// SPDX-License-Identifier: Apache-2.0

import { ContextGraphAuthorityIndexRetryableError } from
  '../context-graph-authority-index-errors.js';
import type { RawContextGraphAuthorityIndexEvent } from
  '../context-graph-authority-index-reducer.js';
import type { ChainEventDecoderRegistry } from './chain-event-decoders.js';
import {
  chainEventLogCoverageIncludes,
  findChainEventLogCoverage,
  normalizeChainEventLogAddress,
  type ChainEventLogStore,
} from './chain-event-log.js';

export interface ChainIndexAuthorityPageSourceOptions {
  readonly scope: string;
  readonly store: ChainEventLogStore;
  readonly registry: ChainEventDecoderRegistry;
  /** Physical `ContextGraphStorage` address this read is bound to. */
  readonly contractAddress: string;
  /**
   * Fallback for a block hash the log does not hold. The log knows the hash of
   * every block that emitted an indexed event plus its own cursor; empty blocks
   * in between still need the chain.
   */
  readonly readBlockHash: (
    blockNumber: number,
    signal: AbortSignal,
  ) => Promise<string | null>;
}

export interface ChainIndexAuthorityPageSource {
  readPage(
    fromBlockNumber: number,
    throughBlockNumber: number,
    signal: AbortSignal,
  ): Promise<readonly RawContextGraphAuthorityIndexEvent[]>;
  /** Topic-indexed local lookup used to validate one immutable creation pair. */
  readContextGraphEvents(
    contextGraphId: bigint,
    fromBlockNumber: number,
    throughBlockNumber: number,
    signal: AbortSignal,
  ): Promise<readonly RawContextGraphAuthorityIndexEvent[]>;
  readBlockHash(blockNumber: number, signal: AbortSignal): Promise<string | null>;
}

/**
 * The #2670 authority index, fed from the one log instead of its own scan.
 *
 * This is the whole "authority becomes a reducer" change: `readPage` is the
 * only port through which that index ever saw the chain, so pointing it at
 * stored rows retires its `eth_getLogs` without touching its reducer, its
 * admission rules, its CAS or the JSON wire format other nodes consume.
 *
 * THE ONE GUARD THAT MATTERS. An empty page and an unindexed page look
 * identical to the reducer: both fold to "no events happened", which for a
 * Context Graph means absent — and absent is one hop from PUBLIC, from a
 * roster that does not list a revoked member, and from a 0. So a range the log
 * does not PROVABLY hold is a retryable error here, never an empty array. The
 * caller then does exactly what it did before this log existed: reads the
 * chain.
 */
export function createChainIndexAuthorityPageSource(
  options: ChainIndexAuthorityPageSourceOptions,
): ChainIndexAuthorityPageSource {
  const contractAddress = normalizeChainEventLogAddress(options.contractAddress);
  if (contractAddress === undefined) {
    throw new Error('Context Graph authority page source address is invalid');
  }
  const { scope, store, registry } = options;

  return Object.freeze({
    async readPage(
      fromBlockNumber: number,
      throughBlockNumber: number,
      signal: AbortSignal,
    ): Promise<readonly RawContextGraphAuthorityIndexEvent[]> {
      signal.throwIfAborted();
      const state = await store.load(scope);
      if (state === undefined) {
        throw new ContextGraphAuthorityIndexRetryableError(
          `chain event log has no cursor for ${scope}`,
        );
      }
      const coverage = findChainEventLogCoverage(
        state.coverage,
        'context-graph-authority',
        contractAddress,
      );
      if (!chainEventLogCoverageIncludes(coverage, fromBlockNumber, throughBlockNumber)) {
        throw new ContextGraphAuthorityIndexRetryableError(
          `chain event log does not cover blocks ${fromBlockNumber}-${throughBlockNumber} `
          + `for ${contractAddress}`,
        );
      }
      const rows = await store.readEvents(scope, {
        fromBlockNumber,
        throughBlockNumber,
        addresses: [contractAddress],
      });
      signal.throwIfAborted();
      return registry.decodeContextGraphAuthority(rows);
    },

    async readContextGraphEvents(
      contextGraphId: bigint,
      fromBlockNumber: number,
      throughBlockNumber: number,
      signal: AbortSignal,
    ): Promise<readonly RawContextGraphAuthorityIndexEvent[]> {
      signal.throwIfAborted();
      if (contextGraphId < 0n || contextGraphId >= (1n << 256n)) {
        throw new RangeError('Context Graph authority event id is outside uint256');
      }
      const state = await store.load(scope);
      if (state === undefined) {
        throw new ContextGraphAuthorityIndexRetryableError(
          `chain event log has no cursor for ${scope}`,
        );
      }
      const coverage = findChainEventLogCoverage(
        state.coverage,
        'context-graph-authority',
        contractAddress,
      );
      if (!chainEventLogCoverageIncludes(coverage, fromBlockNumber, throughBlockNumber)) {
        throw new ContextGraphAuthorityIndexRetryableError(
          `chain event log does not cover blocks ${fromBlockNumber}-${throughBlockNumber} `
          + `for ${contractAddress}`,
        );
      }
      const rows = await store.readEvents(scope, {
        fromBlockNumber,
        throughBlockNumber,
        addresses: [contractAddress],
        topic1: [`0x${contextGraphId.toString(16).padStart(64, '0')}`],
      });
      signal.throwIfAborted();
      return registry.decodeContextGraphAuthority(rows);
    },

    async readBlockHash(blockNumber: number, signal: AbortSignal): Promise<string | null> {
      signal.throwIfAborted();
      const known = await store.blockHashAt(scope, blockNumber);
      if (known !== undefined) return known;
      return options.readBlockHash(blockNumber, signal);
    },
  });
}
