// SPDX-License-Identifier: Apache-2.0

import type { Contract } from 'ethers';
import type { ContractCache } from './evm-adapter-types.js';

const EVENT_CONTRACTS = {
  profileStorage: { registry: 'contract', name: 'ProfileStorage', optional: true, events: ['RelayCapabilityUpdated'] },
  knowledgeAssetStorage: { registry: 'assetStorage', name: 'DKGKnowledgeAssets', optional: false, events: ['KCCreated', 'KnowledgeAssetCreated'] },
  knowledgeAssetsStorage: { registry: 'assetStorage', name: 'KnowledgeAssetsStorage', optional: true, events: ['KnowledgeBatchCreated'] },
  contextGraphNameRegistry: { registry: 'contract', name: 'ContextGraphNameRegistry', optional: true, events: ['NameClaimed', 'ContextGraphNameClaimed'] },
  contextGraphStorage: { registry: 'assetStorage', name: 'ContextGraphStorage', optional: true, events: ['ContextGraphExpanded', 'KnowledgeAssetRegisteredToContextGraph', 'ContextGraphCreated'] },
} as const;

export type EvmEventContractKey = keyof typeof EVENT_CONTRACTS;
export type EvmEventContracts = Readonly<Pick<ContractCache, EvmEventContractKey>>;
export type EvmEventContractSpec = (typeof EVENT_CONTRACTS)[EvmEventContractKey];
export const ALL_EVM_EVENT_CONTRACT_KEYS = Object.freeze(Object.keys(EVENT_CONTRACTS) as EvmEventContractKey[]);

export function eventContractKeysFor(eventTypes: readonly string[]): readonly EvmEventContractKey[] {
  const selected = new Set(eventTypes);
  return ALL_EVM_EVENT_CONTRACT_KEYS.filter(key => EVENT_CONTRACTS[key].events.some(event => selected.has(event)));
}

export function selectEventContracts(contracts: EvmEventContracts, keys: readonly EvmEventContractKey[]): EvmEventContracts {
  return Object.freeze(Object.fromEntries(keys.map(key => [key, contracts[key]])));
}

/** Optional deployments retain their legacy fallback, but never swallow cancellation. */
export async function optionalEvmContract<T>(load: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  signal?.throwIfAborted();
  try {
    const result = await load();
    signal?.throwIfAborted();
    return result;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

/** One Hub generation owns completed bindings; callers own their staged reads. */
export class EvmEventContractGroup {
  private current: { bindings: EvmEventContracts } = { bindings: Object.freeze({}) };

  invalidate(): void {
    this.current = { bindings: Object.freeze({}) };
  }

  async resolve(
    keys: readonly EvmEventContractKey[],
    load: (spec: EvmEventContractSpec) => Promise<Contract>,
    signal?: AbortSignal,
  ): Promise<EvmEventContracts> {
    for (;;) {
      signal?.throwIfAborted();
      const generation = this.current;
      const staged: Partial<Record<EvmEventContractKey, Contract | undefined>> = {};
      for (const key of keys) {
        signal?.throwIfAborted();
        if (Object.hasOwn(generation.bindings, key)) continue;
        const spec = EVENT_CONTRACTS[key];
        // Sequential reads keep physical ownership local even when a required
        // binding fails: there is no unresolved sibling request to abandon.
        staged[key] = spec.optional
          ? await optionalEvmContract(() => load(spec), signal)
          : await load(spec);
        signal?.throwIfAborted();
      }
      signal?.throwIfAborted();
      // A rotation discards the complete staged group. Retry against the new
      // generation instead of publishing handles resolved before invalidation.
      if (generation !== this.current) continue;
      // Concurrent callers never share an in-flight load. Retain any bindings
      // another caller already committed in this generation, then publish once.
      generation.bindings = Object.freeze({ ...staged, ...generation.bindings });
      return selectEventContracts(generation.bindings, keys);
    }
  }
}
