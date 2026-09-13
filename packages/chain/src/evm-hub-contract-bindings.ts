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

/**
 * The handle store as readers see it. Hub-bound handles are written only by
 * {@link EvmHubContractBindings}; lazily resolved slots stay adapter-owned.
 */
export type EvmHubContractStore =
  Readonly<Pick<ContractCache, 'hub' | EvmHubContractKey>> & Omit<ContractCache, 'hub' | EvmHubContractKey>;

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

/**
 * One Hub generation: the installed handles, the boot keys this generation has
 * decided (a handle, or absent for an optional deployment) and whether full
 * initialization published readiness. Every generation transition replaces the
 * record atomically and only the owner writes into it, so a key is in
 * `resolved` exactly when its handle was committed by this generation.
 */
interface EvmHubContractGeneration {
  readonly contracts: ContractCache;
  readonly resolved: Set<EvmHubContractKey>;
  initialized: boolean;
}

/** One canonical handle store and Hub generation for subset and full initialization. */
export class EvmHubContractBindings {
  private current: EvmHubContractGeneration;

  constructor(contracts: ContractCache) {
    this.current = { contracts, resolved: new Set(), initialized: false };
  }

  get contracts(): EvmHubContractStore { return this.current.contracts; }

  get initialized(): boolean { return this.current.initialized; }

  /** Boot keys the current generation has decided. */
  get resolvedKeys(): ReadonlySet<EvmHubContractKey> { return this.current.resolved; }

  get generation(): object { return this.current; }

  /**
   * The typed installation seam for subclasses and fixtures: a complete,
   * caller-owned handle set. Every boot key is decided by this call — an
   * absent optional entry means "not deployed" — so the new generation is
   * ready and no loader runs until the generation changes.
   */
  install(contracts: ContractCache): void {
    this.current = { contracts, resolved: new Set(ALL_EVM_HUB_CONTRACT_KEYS), initialized: true };
  }

  /**
   * Retire the current generation after a Hub rotation or write-side self-heal.
   * Installed handles stay usable by operations that already passed init; new
   * admissions must resolve against the new generation before use. Keys in
   * `dropped` lose their handle as well, for callers that must not reuse them.
   */
  invalidate(dropped: Iterable<EvmHubContractKey> = []): void {
    const { contracts } = this.current;
    for (const key of dropped) contracts[key] = undefined;
    this.current = { contracts, resolved: new Set(), initialized: false };
  }

  /** A full initializer may finish only the exact, completely decided generation it began. */
  completeInitialization(generation: object): boolean {
    if (generation !== this.current) return false;
    const undecided = ALL_EVM_HUB_CONTRACT_KEYS.filter(key => !this.current.resolved.has(key));
    if (undecided.length > 0) {
      throw new Error(`Hub bindings cannot publish readiness before resolving: ${undecided.join(', ')}`);
    }
    this.current.initialized = true;
    return true;
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
      // Handles and decided keys commit together, synchronously, after the
      // entire subset succeeds. Preserve anything another caller committed in
      // this generation meanwhile.
      for (const [key, value] of staged) {
        if (generation.resolved.has(key)) continue;
        generation.contracts[key] = value;
        generation.resolved.add(key);
      }
      return Object.freeze(Object.fromEntries(keys.map(key => [key, generation.contracts[key]]))) as Readonly<Pick<ContractCache, K>>;
    }
  }
}
