// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter, FinalizedEvmReadBindingV1 } from './chain-adapter.js';
import type { FinalizedChainReadOwnerV1 } from './finalized-chain-read-admission.js';

/** Optional EVM integration; the adapter owns endpoint selection and identity. */
export interface FinalizedEvmReadBindingProvider {
  createFinalizedEvmReadBinding(
    owner: FinalizedChainReadOwnerV1,
  ): Promise<Readonly<FinalizedEvmReadBindingV1> | null>;
}

export type FinalizedEvmReadBindingCapability =
  | Readonly<{ status: 'supported'; provider: FinalizedEvmReadBindingProvider }>
  | Readonly<{ status: 'unsupported'; reason: 'finalized-evm-read-binding-unavailable' }>;

const UNSUPPORTED = Object.freeze({
  status: 'unsupported' as const,
  reason: 'finalized-evm-read-binding-unavailable' as const,
});

/** Capture the optional method once, preserving its adapter receiver. */
export function bindFinalizedEvmReadBindingProvider(adapter: ChainAdapter): FinalizedEvmReadBindingCapability {
  const createBinding = adapter.createFinalizedEvmReadBinding;
  if (typeof createBinding !== 'function') return UNSUPPORTED;
  return Object.freeze({
    status: 'supported' as const,
    provider: Object.freeze({
      createFinalizedEvmReadBinding: (owner: FinalizedChainReadOwnerV1) => createBinding.call(adapter, owner),
    }),
  });
}
