// SPDX-License-Identifier: Apache-2.0
/**
 * Compile-time: the EVM adapter and the mock each implement the whole
 * marketplace a buyer or seller is handed (marketplace.ts). A method missing
 * from either fails this file's type check.
 */
import type { EVMChainAdapter, MarketplaceChainAdapter, MockChainAdapter } from '../src/index.js';

declare const evm: EVMChainAdapter;
declare const mock: MockChainAdapter;

const evmMarketplace: MarketplaceChainAdapter = evm;
const mockMarketplace: MarketplaceChainAdapter = mock;

void evmMarketplace;
void mockMarketplace;
