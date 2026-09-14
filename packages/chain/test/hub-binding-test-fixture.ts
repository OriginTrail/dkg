import type { ContractCache, EVMAdapterConfig } from '../src/evm-adapter-types.js';
import type { EvmHubContractKey } from '../src/evm-hub-contract-bindings.js';
import { EVMChainAdapter as ProductionEVMChainAdapter } from '../src/evm-adapter.js';
import { completeContractBindingsForTesting } from './install-hub-contract-bindings-for-testing.js';

export type { EVMAdapterConfig };

/** The generation registry is TS-private; this fixture is its only test reader. */
interface HubBindingRegistryOwner {
  readonly hubContractBindings: { invalidate(dropped?: Iterable<EvmHubContractKey>): void };
}

/** Test-only subclass that publishes a complete, invariant-valid Hub generation. */
export class EVMChainAdapter extends ProductionEVMChainAdapter {
  installHubContractBindingsForTesting(overrides: Partial<ContractCache> = {}): void {
    this.installContractBindings(completeContractBindingsForTesting(this.contracts, overrides));
  }

  /**
   * Retire the installed generation and drop the named handles the way a Hub
   * rotation does. A complete installation cannot express an absent required
   * binding — it fills one with a fail-fast sentinel — so tests that stub
   * `init()` reach that state through this seam instead.
   */
  retireHubContractBindingsForTesting(dropped: readonly EvmHubContractKey[]): void {
    (this as unknown as HubBindingRegistryOwner).hubContractBindings.invalidate(dropped);
  }
}
