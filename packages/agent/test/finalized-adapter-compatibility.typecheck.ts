// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter, FinalizedEvmReadBindingProvider, FinalizedEvmReadBindingV1 } from '@origintrail-official/dkg-chain';

// Existing implementations need no finalized-EVM method to remain adapters.
declare const legacyAdapter: Omit<ChainAdapter, 'createFinalizedEvmReadBinding'>;
const supportedAdapter: ChainAdapter = legacyAdapter;
void supportedAdapter;

// Advertising the capability guarantees a binding; refusal is an exception.
declare const provider: FinalizedEvmReadBindingProvider;
const binding: Promise<Readonly<FinalizedEvmReadBindingV1>> =
  provider.createFinalizedEvmReadBinding('rfc64');
void binding;
const nullableProvider: FinalizedEvmReadBindingProvider = {
  // @ts-expect-error A supported provider cannot return an absent binding.
  createFinalizedEvmReadBinding: async () => null,
};
void nullableProvider;
