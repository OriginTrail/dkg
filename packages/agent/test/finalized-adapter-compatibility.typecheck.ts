// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter } from '@origintrail-official/dkg-chain';

// Existing implementations need no finalized-EVM method to remain adapters.
declare const legacyAdapter: Omit<ChainAdapter, 'createFinalizedEvmReadBinding'>;
const supportedAdapter: ChainAdapter = legacyAdapter;
void supportedAdapter;
