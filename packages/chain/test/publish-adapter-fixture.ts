import { afterEach } from 'vitest';
import { PublishMethods } from '../src/evm-adapter-publish.js';
import type { ContractCache } from '../src/evm-adapter-types.js';

class PublishAdapterFixture extends PublishMethods {
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

const adapters: PublishAdapterFixture[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.destroy();
});

/** Real adapter ownership; individual receipt tests stub their physical reads. */
export function createPublishAdapterFixture(): PublishAdapterFixture {
  const adapter = new PublishAdapterFixture({
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    hubAddress: '0x0000000000000000000000000000000000000012',
    chainId: 'evm:31337',
  });
  adapters.push(adapter);
  return adapter;
}
