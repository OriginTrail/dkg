// SPDX-License-Identifier: Apache-2.0

import type { Contract } from 'ethers';
import type { ContractCache } from './evm-adapter-types.js';

/** Boot bindings shared by full initialization and event-only capability reads. */
export const EVM_HUB_CONTRACT_SPECS = {
  identity: { registry: 'contract', name: 'Identity', optional: false },
  profile: { registry: 'contract', name: 'Profile', optional: false },
  parametersStorage: { registry: 'contract', name: 'ParametersStorage', optional: false },
  profileStorage: { registry: 'contract', name: 'ProfileStorage', optional: true },
  knowledgeAssetStorage: { registry: 'assetStorage', name: 'DKGKnowledgeAssets', optional: false },
  knowledgeAssetsStorage: { registry: 'assetStorage', name: 'KnowledgeAssetsStorage', optional: true },
  contextGraphNameRegistry: { registry: 'contract', name: 'ContextGraphNameRegistry', optional: true },
  contextGraphStorage: { registry: 'assetStorage', name: 'ContextGraphStorage', optional: true },
  staking: { registry: 'contract', name: 'Staking', optional: true },
  knowledgeAssets: { registry: 'contract', name: 'KnowledgeAssets', optional: true },
  askStorage: { registry: 'contract', name: 'AskStorage', optional: true },
  contextGraphs: { registry: 'contract', name: 'ContextGraphs', optional: true },
  knowledgeAssetsLifecycle: { registry: 'contract', name: 'KnowledgeAssetsLifecycle', optional: true },
  dkgPublishingConvictionNFT: { registry: 'contract', name: 'DKGPublishingConvictionNFT', optional: true },
  chronos: { registry: 'contract', name: 'Chronos', optional: true },
  token: { registry: 'token', name: 'Token', optional: false },
} as const;

export type EvmHubContractKey = keyof typeof EVM_HUB_CONTRACT_SPECS;
export type EvmHubContractSpec = (typeof EVM_HUB_CONTRACT_SPECS)[EvmHubContractKey];
export const ALL_EVM_HUB_CONTRACT_KEYS = Object.freeze(Object.keys(EVM_HUB_CONTRACT_SPECS) as EvmHubContractKey[]);

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

/** One canonical handle store and Hub generation for subset and full initialization. */
export class EvmHubContractBindings {
  private current = { resolved: new Set<EvmHubContractKey>(), initialized: false };

  constructor(private installed: ContractCache) {}

  get contracts(): ContractCache { return this.installed; }

  /** Preserve the adapter's protected cache replacement contract for subclasses. */
  set contracts(value: ContractCache) {
    const initialized = this.initialized;
    this.installed = value;
    this.invalidate();
    for (const key of ALL_EVM_HUB_CONTRACT_KEYS) {
      if (initialized || Object.hasOwn(value, key)) this.current.resolved.add(key);
    }
    this.current.initialized = initialized;
  }

  get initialized(): boolean { return this.current.initialized; }

  /** Protected adapter compatibility: an installed full cache is caller-owned. */
  set initialized(value: boolean) {
    if (!value) { this.invalidate(); return; }
    for (const key of ALL_EVM_HUB_CONTRACT_KEYS) this.current.resolved.add(key);
    this.current.initialized = true;
  }

  get generation(): object { return this.current; }

  /** A full initializer may finish only the exact generation it began. */
  completeInitialization(generation: object): boolean {
    if (generation !== this.current) return false;
    this.initialized = true;
    return true;
  }

  invalidate(): void {
    // Keep installed handles usable by operations that already passed init.
    // New admissions must resolve against the new generation before use.
    this.current = { resolved: new Set(), initialized: false };
  }

  async resolve<K extends EvmHubContractKey>(
    keys: readonly K[],
    load: (spec: EvmHubContractSpec) => Promise<Contract | undefined>,
    signal?: AbortSignal,
  ): Promise<Readonly<Pick<ContractCache, K>>> {
    for (;;) {
      signal?.throwIfAborted();
      const generation = this.current;
      const staged = new Map<K, Contract | undefined>();
      for (const key of keys) {
        signal?.throwIfAborted();
        if (generation.resolved.has(key)) continue;
        const spec = EVM_HUB_CONTRACT_SPECS[key];
        // Sequential staging leaves no sibling physical request to abandon.
        staged.set(key, spec.optional
          ? await optionalEvmContract(() => load(spec), signal)
          : await load(spec));
        signal?.throwIfAborted();
      }
      if (generation !== this.current) continue;
      // The canonical store is updated atomically after the entire subset
      // succeeds. Preserve anything another caller committed in this generation.
      for (const [key, value] of staged) {
        if (generation.resolved.has(key)) continue;
        this.installed[key] = value;
        generation.resolved.add(key);
      }
      return Object.freeze(Object.fromEntries(keys.map(key => [key, this.installed[key]]))) as Readonly<Pick<ContractCache, K>>;
    }
  }
}
