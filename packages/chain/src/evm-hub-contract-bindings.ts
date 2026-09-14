// SPDX-License-Identifier: Apache-2.0

import type { Contract } from 'ethers';
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
/** Exact state owned by one Hub generation. Adapter lazy caches are separate. */
export type EvmHubBindingSet = {
  hub: Contract;
} & Partial<Record<EvmHubContractKey, Contract>>;

export type EvmHubContractInstallation = EvmHubBindingSet
  & Required<Pick<EvmHubBindingSet, RequiredEvmHubContractKey>>;

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
  readonly contracts: EvmHubBindingSet;
  readonly resolved: Set<EvmHubContractKey>;
  initialized: boolean;
}

export interface EvmHubContractSnapshot<K extends EvmHubContractKey> {
  readonly generationId: number;
  readonly contracts: Readonly<Pick<EvmHubBindingSet, K>>;
}

/** One canonical handle store and Hub generation for subset and full initialization. */
export class EvmHubContractBindings {
  private nextGenerationId = 1;
  private current: EvmHubContractGeneration;

  constructor(contracts: EvmHubBindingSet) {
    this.current = this.createGeneration(contracts, new Set(), false);
  }

  get contracts(): Readonly<EvmHubBindingSet> { return this.current.contracts; }

  get initialized(): boolean { return this.current.initialized; }

  /** Boot keys the current generation has decided. */
  get resolvedKeys(): ReadonlySet<EvmHubContractKey> { return this.current.resolved; }

  get generation(): object { return this.current; }

  /** Whether a borrowed snapshot still belongs to the active Hub generation. */
  isCurrent(snapshot: Pick<EvmHubContractSnapshot<EvmHubContractKey>, 'generationId'>): boolean {
    return snapshot.generationId === this.current.id;
  }

  /**
   * Install a complete caller-owned Hub handle set. Every boot key is decided by this call — an
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
  ): Promise<Readonly<Pick<EvmHubBindingSet, K>>> {
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
      // Every caller owns its sibling requests through settlement, then
      // publishes one atomic stage. Cancellable loaders share the caller's
      // signal, so cancellation retires the whole group without a partial
      // commit while preserving concurrent physical reads.
      const settled = await Promise.allSettled(unresolved.map(key => load(EVM_HUB_CONTRACT_SPECS[key])));
      signal?.throwIfAborted();
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
      signal?.throwIfAborted();
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
      ]))) as Readonly<Pick<EvmHubBindingSet, K>>;
      return Object.freeze({ generationId: generation.id, contracts });
    }
  }

  private createGeneration(
    contracts: EvmHubBindingSet,
    resolved: Set<EvmHubContractKey>,
    initialized: boolean,
  ): EvmHubContractGeneration {
    const ownedContracts = Object.fromEntries([
      ['hub', contracts.hub],
      ...ALL_EVM_HUB_CONTRACT_KEYS.map(key => [key, contracts[key]] as const),
    ]) as unknown as EvmHubBindingSet;
    const generation = {
      id: this.nextGenerationId++,
      contracts: ownedContracts,
      resolved,
      initialized,
    };
    return generation;
  }

}
