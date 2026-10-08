// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3098 — real loopback HTTP requests through the canonical ethers transport.
 * These prove helper isolation and numeric-block failure fallback, without a
 * deployed contract, funded wallet, external endpoint, or DKG daemon.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Network, type JsonRpcProvider } from 'ethers';
import { readFirstProviderWithTransientRetry } from '../src/rpc-provider-fallback.js';
import { isContractViewRetryable } from '../src/rpc-failover-client.js';
import {
  createRpcRequestProvider,
  withRpcRequestContext,
} from '../src/rpc-request-transport.js';
import {
  CHAIN_ID_HEX,
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError,
  sendJsonRpcResult,
  startLoopbackRpc,
  type LoopbackRpc,
} from './loopback-rpc-harness.js';

const TARGET = `0x${'11'.repeat(20)}`;
const AT_BLOCK = '0x10';
const CALL = [{ to: TARGET, data: '0x12345678' }, AT_BLOCK];
const options = { retryDelayMs: 1, isRetryable: isContractViewRetryable };

describe('ordered snapshot fallback over real loopback RPC transport', () => {
  const harness = createLoopbackJsonRpcTestHarness();
  const providers: JsonRpcProvider[] = [];
  const servers: LoopbackRpc[] = [];

  function provider(url: string): JsonRpcProvider {
    const result = createRpcRequestProvider(url, {
      maxRetries: 0,
      network: Network.from(31_337),
      providerOptions: { batchMaxCount: 1 },
    });
    providers.push(result);
    return result;
  }

  afterEach(async () => {
    for (const result of providers.splice(0)) result.destroy();
    await harness.stopAll();
    for (const server of servers.splice(0)) await server.close();
  });

  it('a healthy primary reaches HTTP while both configured failing backups receive zero requests', async () => {
    const primary = await harness.start((request, response) =>
      sendJsonRpcResult(response, request, request.method === 'eth_chainId' ? CHAIN_ID_HEX : '0x1234'));
    const backup1 = await harness.start((request, response) =>
      sendJsonRpcError(response, request, 3, 'execution reverted: unusable pinned state', '0x'));
    const backup2 = await harness.start((request, response) =>
      sendJsonRpcError(response, request, 3, 'execution reverted: unusable pinned state', '0x'));
    const endpoints = [primary, backup1, backup2];

    await expect(readFirstProviderWithTransientRetry(
      endpoints.map((endpoint) => provider(endpoint.url)),
      (rpc) => rpc.send('eth_call', CALL) as Promise<string>,
      options,
    )).resolves.toBe('0x1234');

    expect(primary.calls.map(({ method, params }) => ({ method, params })))
      .toEqual([{ method: 'eth_call', params: CALL }]);
    expect(backup1.calls).toEqual([]);
    expect(backup2.calls).toEqual([]);
  });

  it.each([1, 2])('numeric-block state refusals progress sequentially to endpoint %i', async (winningIndex) => {
    const order: number[] = [];
    const endpoints = await Promise.all([0, 1, 2].map((index) =>
      harness.start((request, response) => {
        if (request.method === 'eth_chainId') {
          sendJsonRpcResult(response, request, CHAIN_ID_HEX);
          return;
        }
        order.push(index);
        if (index < winningIndex) {
          // This fixture is a deterministic state refusal, not a claim about
          // the error class returned by any live public RPC.
          sendJsonRpcError(response, request, 3, 'execution reverted: unusable pinned state', '0x');
          return;
        }
        sendJsonRpcResult(response, request, '0x5678');
      })));

    await expect(readFirstProviderWithTransientRetry(
      endpoints.map((endpoint) => provider(endpoint.url)),
      (rpc) => rpc.send('eth_call', CALL) as Promise<string>,
      options,
    )).resolves.toBe('0x5678');

    expect(order).toEqual(winningIndex === 1 ? [0, 1] : [0, 1, 2]);
    for (const endpoint of endpoints.slice(0, winningIndex + 1)) {
      expect(endpoint.calls.map(({ method, params }) => ({ method, params })))
        .toEqual([{ method: 'eth_call', params: CALL }]);
    }
    for (const endpoint of endpoints.slice(winningIndex + 1)) expect(endpoint.calls).toEqual([]);
  });

  it('an inherited caller abort physically cancels the primary request and never reaches the backup', async () => {
    const primary = await startLoopbackRpc({ hang: ['eth_call'] });
    const backup = await startLoopbackRpc();
    servers.push(primary, backup);
    const controller = new AbortController();
    const result = withRpcRequestContext({ signal: controller.signal }, () =>
      readFirstProviderWithTransientRetry(
        [provider(primary.url), provider(backup.url)],
        (rpc) => rpc.send('eth_call', CALL) as Promise<string>,
        options,
      ));

    try {
      await expect.poll(() => primary.hits('eth_call')).toBe(1);
      controller.abort();
      await expect(result).resolves.toBeNull();
      await expect.poll(() => primary.aborted('eth_call')).toBe(1);
      expect(backup.totalHits()).toBe(0);
    } finally {
      controller.abort();
      await result.catch(() => {});
    }
  });
});
