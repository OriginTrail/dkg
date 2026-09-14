import type { ContractCache, EVMAdapterConfig } from '../src/evm-adapter-types.js';
import { EVMChainAdapter as ProductionEVMChainAdapter } from '../src/evm-adapter.js';

export type { EVMAdapterConfig };

/** Test-only subclass that publishes a complete, invariant-valid Hub generation. */
export class EVMChainAdapter extends ProductionEVMChainAdapter {
  installHubContractBindingsForTesting(value: ContractCache): void {
    const fallback = value.hub ?? this.contracts.hub;
    this.installHubContractBindings({
      ...value,
      hub: fallback,
      identity: value.identity ?? fallback,
      profile: value.profile ?? fallback,
      parametersStorage: value.parametersStorage ?? fallback,
      knowledgeAssetStorage: value.knowledgeAssetStorage ?? fallback,
    });
    this.contracts.randomSampling = value.randomSampling;
    this.contracts.randomSamplingStorage = value.randomSamplingStorage;
    this.contracts.identityStorage = value.identityStorage;
    this.contracts.convictionStakingStorage = value.convictionStakingStorage;
    this.contracts.stakingStorage = value.stakingStorage;
  }
}
