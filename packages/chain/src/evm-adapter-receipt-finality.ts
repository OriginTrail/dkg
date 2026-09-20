// SPDX-License-Identifier: Apache-2.0

import type { JsonRpcProvider } from 'ethers';
import { BoundedLruCache } from '@origintrail-official/dkg-core';

import type { ChainReadOptions } from './chain-adapter.js';
import { requiredHeadBlockForReceipt } from './evm-adapter-constants.js';
import { isEvmBlockUnavailableError } from './evm-error-text.js';
import type { ReadOpts } from './rpc-failover-client.js';

const RECEIPT_BLOCK_HEADER_CACHE_MAX_ENTRIES = 256;

export interface ReceiptBlockHeader {
  readonly number: number;
  readonly hash: string;
  readonly timestamp?: number;
}

type ReceiptFinalityReadResult = {
  header: ReceiptBlockHeader;
  canonical: boolean;
};

export type ReceiptFinalityProviderReader = (
  label: string,
  read: (provider: JsonRpcProvider) => Promise<ReceiptFinalityReadResult | null>,
  options?: ReadOpts,
) => Promise<ReceiptFinalityReadResult | null>;

/**
 * Owns receipt finality reads and the bounded header memo they populate.
 *
 * Keeping the rule and its cache together prevents transaction-wait and
 * explicit-finality callers from growing subtly different implementations.
 */
export class EvmReceiptFinalityReader {
  readonly #headersByHash =
    new BoundedLruCache<string, ReceiptBlockHeader>(RECEIPT_BLOCK_HEADER_CACHE_MAX_ENTRIES);
  readonly #finalityConfirmations: number;
  readonly #readProviderRetryingNull: ReceiptFinalityProviderReader;

  constructor(
    finalityConfirmations: number,
    readProviderRetryingNull: ReceiptFinalityProviderReader,
  ) {
    this.#finalityConfirmations = finalityConfirmations;
    this.#readProviderRetryingNull = readProviderRetryingNull;
  }

  async read(
    receipt: { txHash?: string; blockNumber: number; blockHash: string },
    options: ChainReadOptions & { deadlineMs?: number } = {},
  ): Promise<ReceiptBlockHeader | null> {
    const resolved = await this.#readProviderRetryingNull(
      'publish receipt finality',
      async (provider) => {
        const requiredBlockNumber = requiredHeadBlockForReceipt(
          receipt.blockNumber,
          this.#finalityConfirmations,
        );
        let providerHead: number | undefined;
        if (requiredBlockNumber > receipt.blockNumber) {
          providerHead = await provider.getBlockNumber();
          if (providerHead < requiredBlockNumber) return null;
        }
        let atHeight;
        try {
          atHeight = await provider.getBlock(receipt.blockNumber);
        } catch (error) {
          if (isEvmBlockUnavailableError(error)) {
            // Some clients report an above-head block as an error rather than
            // null. Confirm that narrow condition before treating it as the
            // nullable failover signal: the same bare message from an endpoint
            // already at this height indicates a sync/restart fault and must
            // surface instead of turning into a ten-minute receipt poll.
            providerHead ??= await provider.getBlockNumber();
            if (providerHead < receipt.blockNumber) return null;
          }
          throw error;
        }
        if (!atHeight?.hash) return null;
        const header = Object.freeze({
          number: atHeight.number,
          hash: atHeight.hash.toLowerCase(),
          ...(atHeight.timestamp == null ? {} : { timestamp: Number(atHeight.timestamp) }),
        });
        this.#headersByHash.set(header.hash, header);
        return {
          header,
          canonical: header.hash === receipt.blockHash.toLowerCase(),
        };
      },
      { signal: options.signal, deadlineMs: options.deadlineMs },
    );
    return resolved?.canonical === true ? resolved.header : null;
  }

  finalizedBlockTimestamp(blockNumber: number, blockHash: string): number | undefined {
    const remembered = this.#headersByHash.get(blockHash.toLowerCase());
    return remembered?.number === blockNumber ? remembered.timestamp : undefined;
  }

  clear(): void {
    this.#headersByHash.clear();
  }
}
