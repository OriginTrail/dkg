// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'vitest';

import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { RpcRequestGovernor } from '../src/rpc-request-governor.js';
import { startLoopbackRpc, type LoopbackRpc } from './loopback-rpc-harness.js';

const DEPLOYER_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB = '0x0000000000000000000000000000000000000001';

function minimalConfig(overrides: Partial<EVMAdapterConfig>): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    privateKey: DEPLOYER_PK,
    hubAddress: HUB,
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    ...overrides,
  };
}

describe('registry scan RPC admission', () => {
  const adapters: EVMChainAdapter[] = [];
  const servers: LoopbackRpc[] = [];

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) adapter.destroy();
    for (const server of servers.splice(0)) await server.close();
  });

  it('preserves retry-later saturation without touching a backup or wrapping the error', async () => {
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
      await expect((adapter as any).resolveLogScanHead('registry scan'))
        .rejects.toMatchObject({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
      expect(primary.totalHits()).toBe(0);
      expect(backup.totalHits()).toBe(0);
      expect(governor.snapshot().rejected).toBe(1);
    } finally {
      queuedController.abort(new Error('test cleanup'));
      await queued.catch(() => undefined);
    }
  });
});
