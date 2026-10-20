import { expect, it } from 'vitest';
import { Network } from 'ethers';
import { createRpcRequestProvider } from '../src/rpc-request-transport.js';
import { RpcUsageScope } from '../src/rpc-usage-scope.js';
import { createRpcUsageRecorder } from '../src/rpc-usage.js';
import { startLoopbackRpc } from './loopback-rpc-harness.js';

it('attributes interleaved queued physical RPCs to their issuer without changing global totals', async () => {
  const rpc = await startLoopbackRpc();
  const accounting = createRpcUsageRecorder(() => 'test:31337');
  const provider = createRpcRequestProvider(rpc.url, {
    network: Network.from(31_337), providerOptions: { batchMaxCount: 1, cacheTimeout: -1 },
    onRequest: (method, slot) => accounting.record(method, slot),
  });
  try {
    const a = new RpcUsageScope(), b = new RpcUsageScope();
    await Promise.all([
      a.run(() => provider.send('eth_getCode', ['0x' + '1'.repeat(40), 'latest'])),
      provider.send('eth_blockNumber', []),
      b.run(() => provider.send('eth_getBalance', ['0x' + '2'.repeat(40), 'latest'])),
      a.run(() => provider.send('eth_getTransactionCount', ['0x' + '1'.repeat(40), 'latest'])),
    ]);
    expect(accounting.rpcUsage(a)).toEqual({ eth_getCode: 1, eth_getTransactionCount: 1 });
    expect(accounting.rpcUsage(b)).toEqual({ eth_getBalance: 1 });
    const totals = accounting.rpcUsage();
    expect(Object.isFrozen(totals)).toBe(true);
    expect(totals.eth_blockNumber).toBe(1);
    expect(Object.values(totals).reduce((sum, count) => sum + count, 0)).toBe(rpc.totalHits());
    expect(accounting.drainRpcUsage().byMethod).toEqual(totals);
    expect(accounting.drainRpcUsage().byMethod).toEqual({});
    expect(accounting.rpcUsage()).toEqual(totals);
    expect(accounting.rpcUsage(a)).toEqual({ eth_getCode: 1, eth_getTransactionCount: 1 });
  } finally { provider.destroy(); await rpc.close(); }
});

it('keeps recorder owners separate and normalizes methods in every accounting view', () => {
  const a = createRpcUsageRecorder(() => 'test:31337');
  const b = createRpcUsageRecorder(() => 'test:31337');
  const scope = new RpcUsageScope();
  scope.run(() => { a.record(''); a.record('__proto__'); b.record('eth_call'); });
  expect(a.rpcUsage(scope)).toEqual({ other: 1, ['__proto__']: 1 });
  expect(a.rpcUsage()).toEqual(a.rpcUsage(scope));
  expect(b.rpcUsage(scope)).toEqual({ eth_call: 1 });
  for (let i = 0; i < 100; i++) a.record('custom_' + i);
  expect(Object.keys(a.rpcUsage()).length).toBeLessThanOrEqual(65);
  expect(Object.values(a.rpcUsage()).reduce((sum, count) => sum + count, 0)).toBe(102);
  expect(a.rpcUsage(scope)).toEqual({ other: 1, ['__proto__']: 1 });
});
