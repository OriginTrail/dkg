import type { ContractCache } from '../src/evm-adapter-types.js';

type LegacyContractCacheOwner = {
  contracts: ContractCache;
  initialized: boolean;
};

/** One test-only bridge through the protected legacy subclass facade. */
export function installHubContractBindingsForTesting(
  adapter: object,
  value: ContractCache,
): void {
  const owner = adapter as LegacyContractCacheOwner;
  const fallback = value.hub ?? owner.contracts.hub;
  owner.contracts = {
    ...value,
    hub: fallback,
    identity: value.identity ?? fallback,
    profile: value.profile ?? fallback,
    parametersStorage: value.parametersStorage ?? fallback,
    knowledgeAssetStorage: value.knowledgeAssetStorage ?? fallback,
  };
  owner.initialized = true;
}
