// SPDX-License-Identifier: Apache-2.0
import type { ChainReadOptions } from './chain-adapter.js';

export interface CanonicalFinalizationReceiptReadOptions extends ChainReadOptions {
  /** Persisted block identity supplied during replay canonicality checks. */
  expectedBlockHash?: string;
  expectedBlockNumber?: number;
  /** Confirmed catalog obligations also accept authenticated V10 update events.
   * Omission preserves the historical creation-only receipt contract. */
  includeKnowledgeAssetUpdates?: boolean;
}
