import type { Contract } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import type { ContractCache } from '../src/evm-adapter-types.js';
import type {
  EvmHubContractBindings,
  EvmHubContractInstallation,
} from '../src/evm-hub-contract-bindings.js';

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
  seed(bindings: ContractCache & EvmHubContractInstallation): void {
    this.installContractBindings(bindings);
    // @ts-expect-error Hub bindings cannot be replaced through the snapshot.
    this.contracts = bindings;
    // @ts-expect-error Hub slots cannot be mutated outside an atomic install.
    this.contracts.chronos = handle;
    // @ts-expect-error Adapter slots are also read-only through the compatibility snapshot.
    this.contracts.randomSampling = handle;
    // @ts-expect-error Hub slots cannot be deleted outside an atomic install.
    delete this.contracts.token;
    this.adapterContracts.randomSampling = handle;
    // @ts-expect-error Readiness follows the installed generation.
    this.initialized = true;
    // @ts-expect-error Invalidation is an explicit registry transition.
    this.initialized = false;
  }
}
void Probe;
