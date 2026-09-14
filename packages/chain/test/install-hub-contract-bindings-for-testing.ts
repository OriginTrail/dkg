import type { Contract } from 'ethers';
import type { ContractCache } from '../src/evm-adapter-types.js';
import type { EvmHubContractInstallation } from '../src/evm-hub-contract-bindings.js';

function undeclaredRequiredBinding(name: string): Contract {
  const marker = { target: `test-only:undeclared-hub-binding:${name}` };
  return new Proxy(marker, {
    get(target, property, receiver) {
      if (property === 'then') return undefined;
      if (property === 'target') return Reflect.get(target, property, receiver);
      throw new Error(`Test used undeclared required Hub binding "${name}"`);
    },
  }) as unknown as Contract;
}

const REQUIRED_BINDING_SENTINELS = Object.freeze({
  identity: undeclaredRequiredBinding('identity'),
  profile: undeclaredRequiredBinding('profile'),
  parametersStorage: undeclaredRequiredBinding('parametersStorage'),
  knowledgeAssetStorage: undeclaredRequiredBinding('knowledgeAssetStorage'),
});

/**
 * Patch the current test generation and fill required but undeclared bindings
 * with distinct fail-fast sentinels. No unrelated capability aliases the Hub.
 */
export function completeContractBindingsForTesting(
  current: Readonly<ContractCache>,
  overrides: Partial<ContractCache>,
): ContractCache & EvmHubContractInstallation {
  const value = { ...current, ...overrides };
  return {
    ...value,
    hub: value.hub,
    identity: value.identity ?? REQUIRED_BINDING_SENTINELS.identity,
    profile: value.profile ?? REQUIRED_BINDING_SENTINELS.profile,
    parametersStorage: value.parametersStorage ?? REQUIRED_BINDING_SENTINELS.parametersStorage,
    knowledgeAssetStorage:
      value.knowledgeAssetStorage ?? REQUIRED_BINDING_SENTINELS.knowledgeAssetStorage,
  };
}
