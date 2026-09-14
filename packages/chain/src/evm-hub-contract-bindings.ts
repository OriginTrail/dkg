// SPDX-License-Identifier: Apache-2.0

import type { Contract } from 'ethers';
import type { ContractCache } from './evm-adapter-types.js';
import { HubContractNotFoundError } from './hub-contract-not-found-error.js';

/** Boot bindings shared by full initialization and event-only capability reads. */
export const EVM_HUB_CONTRACT_SPECS = {
  identity: { registry: 'contract', name: 'Identity', resolution: 'required' },
  profile: { registry: 'contract', name: 'Profile', resolution: 'required' },
  parametersStorage: { registry: 'contract', name: 'ParametersStorage', resolution: 'required' },
  profileStorage: { registry: 'contract', name: 'ProfileStorage', resolution: 'optional-deployment' },
  knowledgeAssetStorage: { registry: 'assetStorage', name: 'DKGKnowledgeAssets', resolution: 'required' },
  knowledgeAssetsStorage: { registry: 'assetStorage', name: 'KnowledgeAssetsStorage', resolution: 'optional-deployment' },
  contextGraphNameRegistry: { registry: 'contract', name: 'ContextGraphNameRegistry', resolution: 'optional-deployment' },
  contextGraphStorage: { registry: 'assetStorage', name: 'ContextGraphStorage', resolution: 'optional-deployment' },
  staking: { registry: 'contract', name: 'Staking', resolution: 'optional-deployment' },
  knowledgeAssets: { registry: 'contract', name: 'KnowledgeAssets', resolution: 'optional-deployment' },
  askStorage: { registry: 'contract', name: 'AskStorage', resolution: 'optional-deployment' },
  contextGraphs: { registry: 'contract', name: 'ContextGraphs', resolution: 'optional-deployment' },
  knowledgeAssetsLifecycle: { registry: 'contract', name: 'KnowledgeAssetsLifecycle', resolution: 'optional-deployment' },
  dkgPublishingConvictionNFT: { registry: 'contract', name: 'DKGPublishingConvictionNFT', resolution: 'optional-deployment' },
  chronos: { registry: 'contract', name: 'Chronos', resolution: 'optional-deployment' },
  token: { registry: 'token', name: 'Token', resolution: 'zero-address-allowed' },
} as const;

export type EvmHubContractKey = keyof typeof EVM_HUB_CONTRACT_SPECS;
export type EvmHubContractSpec = (typeof EVM_HUB_CONTRACT_SPECS)[EvmHubContractKey];
export type RequiredEvmHubContractKey = {
  [K in EvmHubContractKey]: (typeof EVM_HUB_CONTRACT_SPECS)[K]['resolution'] extends 'required' ? K : never;
}[EvmHubContractKey];
export const ALL_EVM_HUB_CONTRACT_KEYS = Object.freeze(Object.keys(EVM_HUB_CONTRACT_SPECS) as EvmHubContractKey[]);
export const REQUIRED_EVM_HUB_CONTRACT_KEYS = Object.freeze(ALL_EVM_HUB_CONTRACT_KEYS.filter(
  (key): key is RequiredEvmHubContractKey => EVM_HUB_CONTRACT_SPECS[key].resolution === 'required',
));
export type EvmHubContractInstallation = ContractCache & Required<Pick<ContractCache, RequiredEvmHubContractKey>>;

/**
 * The handle store as readers see it. Hub-bound handles are written only by
 * {@link EvmHubContractBindings}; lazily resolved slots stay adapter-owned.
 */
export type EvmHubContractStore =
  Readonly<Pick<ContractCache, 'hub' | EvmHubContractKey>> & Omit<ContractCache, 'hub' | EvmHubContractKey>;

const EVM_ADAPTER_LAZY_CONTRACT_KEYS = Object.freeze([
  'randomSampling',
  'randomSamplingStorage',
  'identityStorage',
  'convictionStakingStorage',
  'stakingStorage',
] as const satisfies readonly (Exclude<keyof ContractCache, 'hub' | EvmHubContractKey>)[]);
type EvmAdapterLazyContractKey = (typeof EVM_ADAPTER_LAZY_CONTRACT_KEYS)[number];

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
  readonly id: number;
  readonly contracts: ContractCache;
  readonly resolved: Set<EvmHubContractKey>;
  initialized: boolean;
}

export interface EvmHubContractSnapshot<K extends EvmHubContractKey> {
  readonly generationId: number;
  readonly contracts: Readonly<Pick<ContractCache, K>>;
}

/** One canonical handle store and Hub generation for subset and full initialization. */
export class EvmHubContractBindings {
  private nextGenerationId = 1;
  private current: EvmHubContractGeneration;
  private readonly adapterContracts: Partial<Pick<ContractCache, EvmAdapterLazyContractKey>> = {};
  private readonly compatibilityView: ContractCache;

  constructor(contracts: ContractCache) {
    this.current = this.createGeneration(contracts, new Set(), false);
    this.copyAdapterContracts(contracts);
    this.compatibilityView = this.createCompatibilityView();
  }

  get contracts(): EvmHubContractStore { return this.compatibilityView; }

  get initialized(): boolean { return this.current.initialized; }

  /** Deprecated subclass view backed by explicit generation and lazy-slot accessors. */
  get compatibilityContracts(): ContractCache { return this.compatibilityView; }

  /** Boot keys the current generation has decided. */
  get resolvedKeys(): ReadonlySet<EvmHubContractKey> { return this.current.resolved; }

  get generation(): object { return this.current; }

  /**
   * The typed installation seam for subclasses and fixtures: a complete,
   * caller-owned handle set. Every boot key is decided by this call — an
   * absent optional entry means "not deployed" — so the new generation is
   * ready and no loader runs until the generation changes.
   */
  install(contracts: EvmHubContractInstallation): void {
    const missing = REQUIRED_EVM_HUB_CONTRACT_KEYS.filter(key => !contracts[key]);
    if (missing.length > 0) {
      throw new Error(`Hub binding installation is missing required handles: ${missing.join(', ')}`);
    }
    this.current = this.createGeneration(
      contracts, new Set(ALL_EVM_HUB_CONTRACT_KEYS), true,
    );
  }

  /** @deprecated Compatibility transition for protected subclass assignment. */
  replaceFromSubclass(contracts: ContractCache): void {
    const initialized = this.current.initialized
      && REQUIRED_EVM_HUB_CONTRACT_KEYS.every(key => contracts[key] !== undefined);
    this.copyAdapterContracts(contracts);
    this.current = this.createGeneration(
      contracts,
      initialized ? new Set(ALL_EVM_HUB_CONTRACT_KEYS) : new Set(),
      initialized,
    );
  }

  /** @deprecated Compatibility transition for protected subclass assignment. */
  setInitializedFromSubclass(initialized: boolean): void {
    if (!initialized) {
      this.invalidate();
      return;
    }
    for (const key of ALL_EVM_HUB_CONTRACT_KEYS) this.current.resolved.add(key);
    this.current.initialized = true;
  }

  /**
   * Retire the current generation after a Hub rotation or write-side self-heal.
   * Installed handles stay usable by operations that already passed init; new
   * admissions must resolve against the new generation before use. Keys in
   * `dropped` lose their handle as well, for callers that must not reuse them.
   */
  invalidate(dropped: Iterable<EvmHubContractKey> = []): void {
    const contracts = { ...this.current.contracts };
    for (const key of dropped) contracts[key] = undefined;
    this.current = this.createGeneration(contracts, new Set(), false);
  }

  /** A full initializer may finish only the exact generation with every required binding decided. */
  completeInitialization(generation: object): boolean {
    if (generation !== this.current) return false;
    const undecided = REQUIRED_EVM_HUB_CONTRACT_KEYS.filter(key => !this.current.resolved.has(key));
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
    return (await this.resolveSnapshot(keys, load, signal)).contracts;
  }

  async resolveSnapshot<K extends EvmHubContractKey>(
    keys: readonly K[],
    load: (spec: EvmHubContractSpec) => Promise<Contract | undefined>,
    signal?: AbortSignal,
  ): Promise<EvmHubContractSnapshot<K>> {
    return this.resolveSnapshotWithPolicy(keys, load, signal, false);
  }

  /** Full boot may defer transient optional failures; targeted reads still surface them. */
  async resolveForInitialization<K extends EvmHubContractKey>(
    keys: readonly K[],
    load: (spec: EvmHubContractSpec) => Promise<Contract | undefined>,
    signal?: AbortSignal,
  ): Promise<EvmHubContractSnapshot<K>> {
    return this.resolveSnapshotWithPolicy(keys, load, signal, true);
  }

  private async resolveSnapshotWithPolicy<K extends EvmHubContractKey>(
    keys: readonly K[],
    load: (spec: EvmHubContractSpec) => Promise<Contract | undefined>,
    signal: AbortSignal | undefined,
    deferTransientOptionalFailures: boolean,
  ): Promise<EvmHubContractSnapshot<K>> {
    for (;;) {
      signal?.throwIfAborted();
      const generation = this.current;
      const staged = new Map<K, Contract | undefined>();
      const unresolved = keys.filter(key => !generation.resolved.has(key));
      if (signal) {
        for (const key of unresolved) {
          signal.throwIfAborted();
          const spec = EVM_HUB_CONTRACT_SPECS[key];
          // Sequential staging leaves no sibling physical request to abandon.
          try {
            staged.set(key, await load(spec));
          } catch (error) {
            signal.throwIfAborted();
            if (spec.resolution !== 'optional-deployment') throw error;
            if (error instanceof HubContractNotFoundError) staged.set(key, undefined);
            else if (!deferTransientOptionalFailures) throw error;
          }
          signal.throwIfAborted();
        }
      } else {
        // Full initialization and other non-cancellable callers own every
        // sibling request through settlement, then publish one atomic stage.
        const settled = await Promise.allSettled(unresolved.map(key => load(EVM_HUB_CONTRACT_SPECS[key])));
        for (const [index, result] of settled.entries()) {
          const key = unresolved[index];
          const spec = EVM_HUB_CONTRACT_SPECS[key];
          if (result.status === 'fulfilled') {
            staged.set(key, result.value);
          } else if (spec.resolution !== 'optional-deployment') {
            throw result.reason;
          } else if (result.reason instanceof HubContractNotFoundError) {
            staged.set(key, undefined);
          } else if (!deferTransientOptionalFailures) {
            throw result.reason;
          }
        }
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
      const contracts = Object.freeze(Object.fromEntries(keys.map(key => [
        key, generation.resolved.has(key) ? generation.contracts[key] : undefined,
      ]))) as Readonly<Pick<ContractCache, K>>;
      return Object.freeze({ generationId: generation.id, contracts });
    }
  }

  private createGeneration(
    contracts: ContractCache,
    resolved: Set<EvmHubContractKey>,
    initialized: boolean,
  ): EvmHubContractGeneration {
    const ownedContracts = Object.fromEntries([
      ['hub', contracts.hub],
      ...ALL_EVM_HUB_CONTRACT_KEYS.map(key => [key, contracts[key]] as const),
    ]) as unknown as ContractCache;
    const generation = {
      id: this.nextGenerationId++,
      contracts: ownedContracts,
      resolved,
      initialized,
    };
    return generation;
  }

  private createCompatibilityView(): ContractCache {
    const view = {} as ContractCache;
    Object.defineProperty(view, 'hub', this.bindingDescriptor('hub'));
    for (const key of ALL_EVM_HUB_CONTRACT_KEYS) {
      Object.defineProperty(view, key, this.bindingDescriptor(key));
    }
    for (const key of EVM_ADAPTER_LAZY_CONTRACT_KEYS) {
      Object.defineProperty(view, key, {
        enumerable: true,
        configurable: false,
        get: () => this.adapterContracts[key],
        set: (value: Contract | undefined) => { this.adapterContracts[key] = value; },
      });
    }
    return view;
  }

  private bindingDescriptor(key: 'hub' | EvmHubContractKey): PropertyDescriptor {
    return {
      enumerable: true,
      configurable: false,
      get: () => this.current.contracts[key],
      set: (value: Contract | undefined) => this.replaceBindingFromSubclass(key, value),
    };
  }

  private replaceBindingFromSubclass(
    key: 'hub' | EvmHubContractKey,
    value: Contract | undefined,
  ): void {
    if (this.current.contracts[key] === value) return;
    if (key === 'hub' && value === undefined) {
      throw new Error('Hub binding cannot be removed');
    }
    const contracts = { ...this.current.contracts, [key]: value } as ContractCache;
    if (key === 'hub') {
      this.current = this.createGeneration(contracts, new Set(), false);
      return;
    }
    const resolved = new Set(this.current.resolved);
    resolved.add(key);
    const initialized = this.current.initialized
      && REQUIRED_EVM_HUB_CONTRACT_KEYS.every(required => contracts[required] !== undefined);
    this.current = this.createGeneration(contracts, resolved, initialized);
  }

  private copyAdapterContracts(contracts: ContractCache): void {
    for (const key of EVM_ADAPTER_LAZY_CONTRACT_KEYS) {
      this.adapterContracts[key] = contracts[key];
    }
  }
}
