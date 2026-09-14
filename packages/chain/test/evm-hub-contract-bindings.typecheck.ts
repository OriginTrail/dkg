import type { Contract } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import type { ContractCache } from '../src/evm-adapter-types.js';
import type { EvmHubContractBindings } from '../src/evm-hub-contract-bindings.js';

declare const bindings: EvmHubContractBindings;
declare const handle: Contract;

// Hub-bound handles, readiness and the store itself change only through the
// owner's install / resolve / invalidate / completeInitialization transitions.
// @ts-expect-error a boot binding is not writable through the store view
bindings.contracts.contextGraphStorage = handle;
// @ts-expect-error the Hub handle is installed, never reassigned
bindings.contracts.hub = handle;
// @ts-expect-error readiness is published only by completeInitialization or install
bindings.initialized = true;
// @ts-expect-error the store is replaced only through install
bindings.contracts = { hub: handle };
// Lazily resolved slots remain adapter-owned.
bindings.contracts.identityStorage = handle;

class Probe extends EVMChainAdapter {
  seed(bindings: ContractCache): void {
    // Whole-cache replacement remains a contained legacy transition.
    this.contracts = bindings;
    // @ts-expect-error boot bindings are readonly through the subclass view
    this.contracts.chronos = handle;
    // Adapter-owned lazy slots remain writable.
    this.contracts.randomSampling = handle;
    this.initialized = true;
    this.initialized = false;
  }
}
void Probe;
