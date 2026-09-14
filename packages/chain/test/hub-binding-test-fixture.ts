import type { ContractCache, EVMAdapterConfig } from '../src/evm-adapter-types.js';
import { EVMChainAdapter as ProductionEVMChainAdapter } from '../src/evm-adapter.js';
import { completeContractBindingsForTesting } from './install-hub-contract-bindings-for-testing.js';

export type { EVMAdapterConfig };

/** Test-only subclass that publishes a complete, invariant-valid Hub generation. */
export class EVMChainAdapter extends ProductionEVMChainAdapter {
  installHubContractBindingsForTesting(value: ContractCache): void {
    this.installContractBindings(completeContractBindingsForTesting(value, this.contracts.hub));
  }
}
