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
// @ts-expect-error Lazily resolved slots are not part of the Hub registry.
bindings.contracts.identityStorage = handle;

class Probe extends EVMChainAdapter {
  seed(bindings: ContractCache): void {
    // Whole-cache replacement remains a contained compatibility transition.
    this.contracts = bindings;
    // Legacy per-slot mutation remains source compatible and routes through
    // the binding owners at runtime.
    this.contracts.chronos = handle;
    this.contracts.randomSampling = handle;
    delete this.contracts.token;
    this.adapterContracts.randomSampling = handle;
    this.initialized = true;
    this.initialized = false;
  }
}
void Probe;
