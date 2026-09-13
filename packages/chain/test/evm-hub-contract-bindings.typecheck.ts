import type { Contract } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
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
  probe(): void {
    // @ts-expect-error subclasses read Hub-bound handles; they install complete sets instead
    this.contracts.chronos = handle;
    this.contracts.randomSampling = handle;
    // @ts-expect-error subclasses replace the store through an explicit installation transition
    this.contracts = { hub: handle };
    // @ts-expect-error subclasses retire bindings through an explicit invalidation transition
    this.initialized = false;
  }
}
void Probe;
