import type { ContractCache } from '../src/evm-adapter-types.js';
import type { EvmHubContractInstallation } from '../src/evm-hub-contract-bindings.js';

/** Build one complete, invariant-valid Hub installation for a test subclass. */
export function completeContractBindingsForTesting(
  value: ContractCache,
  fallback: ContractCache['hub'],
): ContractCache & EvmHubContractInstallation {
  const hub = value.hub ?? fallback;
  return {
    ...value,
    hub,
    identity: value.identity ?? hub,
    profile: value.profile ?? hub,
    parametersStorage: value.parametersStorage ?? hub,
    knowledgeAssetStorage: value.knowledgeAssetStorage ?? hub,
  };
}
