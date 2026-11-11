// SPDX-License-Identifier: Apache-2.0

import { BUYER_SCAN_PAGE_BLOCKS, CG_REGISTRY_REORG_BUFFER_BLOCKS } from './evm-adapter-constants.js';
import { IncrementalEventScan } from './incremental-event-scan.js';

/**
 * The `BuyerAdded` scan behind the marketplace's `listBuyerAccounts`, one per adapter. It is kept per
 * `ServiceSubscriptions` address and buyer, so that a repeat read covers only the blocks since the last
 * one, plus the reorg tail.
 */
export function createBuyerAccountScan(): IncrementalEventScan<bigint> {
  return new IncrementalEventScan<bigint>({
    pageBlocks: BUYER_SCAN_PAGE_BLOCKS,
    tailBlocks: CG_REGISTRY_REORG_BUFFER_BLOCKS,
  });
}
