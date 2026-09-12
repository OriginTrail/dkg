import { afterEach } from 'vitest';
import { PublishMethods } from '../src/evm-adapter-publish.js';

const adapters: PublishMethods[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.destroy();
});

/** Real adapter ownership; individual receipt tests stub their physical reads. */
export function createPublishAdapterFixture(): PublishMethods {
  const adapter = new PublishMethods({
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    hubAddress: '0x0000000000000000000000000000000000000012',
    chainId: 'evm:31337',
  });
  adapters.push(adapter);
  return adapter;
}
