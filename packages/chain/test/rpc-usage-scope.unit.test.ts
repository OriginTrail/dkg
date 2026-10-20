import { expect, it } from 'vitest';
import { Network } from 'ethers';
import { createRpcRequestProvider } from '../src/rpc-request-transport.js';
import { RpcUsageScope, recordScopedRpcUsage } from '../src/rpc-usage-scope.js';
import { startLoopbackRpc } from './loopback-rpc-harness.js';

it('attributes interleaved queued physical RPCs to their issuer without changing global totals', async () => {
  const rpc = await startLoopbackRpc();
  const owner = {}, global: Record<string, number> = {};
  const provider = createRpcRequestProvider(rpc.url, {
    network: Network.from(31_337), providerOptions: { batchMaxCount: 1, cacheTimeout: -1 },
    onRequest: method => { global[method] = (global[method] ?? 0) + 1; recordScopedRpcUsage(owner, method); },
  });
  try {
    const a = new RpcUsageScope(), b = new RpcUsageScope();
    await Promise.all([
      a.run(() => provider.send('eth_getCode', ['0x' + '1'.repeat(40), 'latest'])),
      provider.send('eth_blockNumber', []),
      b.run(() => provider.send('eth_getBalance', ['0x' + '2'.repeat(40), 'latest'])),
      a.run(() => provider.send('eth_getTransactionCount', ['0x' + '1'.repeat(40), 'latest'])),
    ]);
    expect(a.usage(owner)).toEqual({ eth_getCode: 1, eth_getTransactionCount: 1 });
    expect(b.usage(owner)).toEqual({ eth_getBalance: 1 });
    expect(global.eth_blockNumber).toBe(1);
    expect(Object.values(global).reduce((sum, count) => sum + count, 0)).toBe(rpc.totalHits());
  } finally { provider.destroy(); await rpc.close(); }
});
