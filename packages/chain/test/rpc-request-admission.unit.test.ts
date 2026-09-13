// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'vitest';

import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { createRpcTimeoutError } from '../src/chain-rpc-transport-error.js';
import { RpcRequestGovernor } from '../src/rpc-request-governor.js';
import {
  createRpcRequestProvider,
  withRpcRequestContext,
} from '../src/rpc-request-transport.js';
import { startLoopbackRpc, type LoopbackRpc } from './loopback-rpc-harness.js';

const DEPLOYER_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB = '0x0000000000000000000000000000000000000001';

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    privateKey: DEPLOYER_PK,
    hubAddress: HUB,
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    ...overrides,
  };
}

describe('RPC request admission and cancellation', () => {
  const adapters: EVMChainAdapter[] = [];
  const servers: LoopbackRpc[] = [];

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) adapter.destroy();
    for (const server of servers.splice(0)) await server.close();
  });

  it('cancels the active ethers HTTP request when the caller aborts a chain read', async () => {
    const rpc = await startLoopbackRpc({ hang: ['eth_blockNumber'] });
    servers.push(rpc);
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
    });
    const controller = new AbortController();
    const timeoutError = createRpcTimeoutError('authentication attempt timed out');

    const pending = withRpcRequestContext(
      { signal: controller.signal },
      () => provider.send('eth_blockNumber', []),
    );
    try {
      for (let turn = 0; turn < 50 && rpc.hits('eth_blockNumber') === 0; turn += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      expect(rpc.hits('eth_blockNumber')).toBe(1);
      controller.abort(timeoutError);
      await expect(pending).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
      for (let turn = 0; turn < 50 && rpc.aborted('eth_blockNumber') === 0; turn += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      expect(rpc.aborted('eth_blockNumber')).toBe(1);
    } finally {
      if (!controller.signal.aborted) controller.abort(timeoutError);
      await pending.catch(() => {});
      provider.destroy();
    }
  });

  it('removes an aborted request while it is waiting for governor capacity', async () => {
    const rpc = await startLoopbackRpc();
    servers.push(rpc);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 0.1,
      foregroundReservePercent: 0,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    await governor.acquire('foreground');
    const provider = createRpcRequestProvider(rpc.url, {
      maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
      admission: governor,
    });
    const controller = new AbortController();
    const timeoutError = createRpcTimeoutError('caller deadline expired');
    const pending = withRpcRequestContext(
      { signal: controller.signal },
      () => provider._send({
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
      }),
    );
    try {
      await expect.poll(() => governor.snapshot().foregroundQueued).toBe(1);
      controller.abort(timeoutError);
      await expect(pending).rejects.toBe(timeoutError);
      expect(rpc.totalHits()).toBe(0);
      expect(governor.snapshot()).toMatchObject({
        foregroundQueued: 0,
        cancelled: 1,
      });
    } finally {
      if (!controller.signal.aborted) controller.abort(timeoutError);
      await pending.catch(() => {});
      provider.destroy();
    }
  });

  it('does not dispatch failover attempts after their admission deadlines expire', async () => {
    const primary = await startLoopbackRpc();
    const backup = await startLoopbackRpc();
    servers.push(primary, backup);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 0.1,
      foregroundReservePercent: 0,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    await governor.acquire('foreground');
    const adapter = new EVMChainAdapter(minimalConfig({
      rpcUrl: primary.url,
      rpcUrls: [backup.url],
      rpcRequestGovernor: governor,
    }));
    adapters.push(adapter);

    await expect(adapter.getBlockNumber()).rejects.toBeTruthy();
    expect(governor.snapshot()).toMatchObject({
      foregroundQueued: 0,
      cancelled: 2,
    });
    // The first abandoned waiter would receive the 10-second refill here if
    // the attempt timeout had merely raced it instead of aborting admission.
    await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
    expect(primary.totalHits() + backup.totalHits()).toBe(0);
  }, 15_000);

  it('surfaces queue saturation without failing over across the shared governor', async () => {
    const primary = await startLoopbackRpc();
    const backup = await startLoopbackRpc();
    servers.push(primary, backup);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 0.1,
      foregroundReservePercent: 0,
      burstRequests: 1,
      maxQueueSize: 1,
      startupJitterMs: 0,
    });
    await governor.acquire('foreground');
    const queuedController = new AbortController();
    const queued = governor.acquire('foreground', queuedController.signal);
    const adapter = new EVMChainAdapter(minimalConfig({
      rpcUrl: primary.url,
      rpcUrls: [backup.url],
      rpcRequestGovernor: governor,
    }));
    adapters.push(adapter);
    try {
      await expect(adapter.getBlockNumber()).rejects.toMatchObject({
        code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
      });
      expect(primary.totalHits() + backup.totalHits()).toBe(0);
      expect(governor.snapshot().rejected).toBe(1);
    } finally {
      queuedController.abort(new Error('test cleanup'));
      await queued.catch(() => {});
    }
  });
});

