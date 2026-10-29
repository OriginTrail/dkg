// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Network, type JsonRpcProvider } from 'ethers';
import { RpcRequestGovernor } from '../src/rpc-request-governor.js';
import { withRpcRequestContext, withRpcRequestTimeout, createRpcRequestProvider } from '../src/rpc-request-transport.js';
import { startLoopbackRpc, type LoopbackRpc } from './loopback-rpc-harness.js';
import { RpcFailoverClient } from '../src/rpc-failover-client.js';
import { _resetRpcFailoverStatsForTest, getRpcFailoverStats } from '../src/rpc-failover-log.js';
import { resetRpcRequestTimingForTests, snapshotRpcRequestTiming } from '../src/rpc-request-timing.js';
import { createRpcTimeoutError } from '../src/chain-rpc-transport-error.js';

describe('RPC admission after earlier dispatches in the same operation', () => {
  const servers: LoopbackRpc[] = [];
  const providers: JsonRpcProvider[] = [];
  beforeEach(() => {
    resetRpcRequestTimingForTests();
    _resetRpcFailoverStatsForTest();
  });
  afterEach(async () => {
    for (const provider of providers.splice(0)) provider.destroy();
    for (const server of servers.splice(0)) await server.close();
  });

  async function setup(hang: string[] = []) {
    const rpc = await startLoopbackRpc({ hang });
    servers.push(rpc);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 0.1, foregroundReservePercent: 0,
      burstRequests: 1, maxQueueSize: 8, startupJitterMs: 0,
    });
    const provider = createRpcRequestProvider(rpc.url, {
      network: Network.from(31_337), admission: governor, maxRetries: 0,
      providerOptions: { batchMaxCount: 1 },
    });
    providers.push(provider);
    const send = (id: number, method = 'eth_blockNumber') => provider._send({
      id, method, params: [], jsonrpc: '2.0',
    });
    return { rpc, governor, provider, send };
  }

  it('reports local capacity when a completed first request consumed the token', async () => {
    const { rpc, governor, send } = await setup();
    await expect(withRpcRequestTimeout(250, 'two reads', async () => {
      await send(1);
      return send(2);
    })).rejects.toMatchObject({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    expect(rpc.totalHits()).toBe(1);
    expect(governor.snapshot()).toMatchObject({ foregroundQueued: 0, cancelled: 1 });
    const timing = snapshotRpcRequestTiming().foreground;
    expect(timing.admissionWait.count).toBe(1);
    expect(timing.admissionDeadlineWait.count).toBe(1);
    expect(timing.admissionDeadlineWait.totalMs).toBeGreaterThan(100);
    expect(timing.admissionCancelledWait.count).toBe(0);
    expect(timing.endpointLatency.count).toBe(1);
  });

  it('reports the same local capacity when the token was consumed outside the window', async () => {
    const { rpc, governor, send } = await setup();
    await governor.acquire('foreground');
    await expect(withRpcRequestTimeout(250, 'queued read', () => send(1)))
      .rejects.toMatchObject({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    expect(rpc.totalHits()).toBe(0);
    expect(governor.snapshot().foregroundQueued).toBe(0);
  });

  it('retains endpoint timeout when a dispatched request is still awaiting a response', async () => {
    const { rpc, send } = await setup(['eth_blockNumber']);
    await expect(withRpcRequestTimeout(250, 'hanging read', () => send(1)))
      .rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    expect(rpc.totalHits()).toBe(1);
    await expect.poll(() => rpc.aborted('eth_blockNumber')).toBe(1);
  });

  it('does not hide a live endpoint behind a concurrent queued request', async () => {
    const { rpc, governor, send } = await setup(['eth_blockNumber']);
    await expect(withRpcRequestTimeout(250, 'parallel reads', async () => {
      return Promise.all([send(1), send(2)]);
    })).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    expect(rpc.totalHits()).toBe(1);
    expect(governor.snapshot().foregroundQueued).toBe(0);
  });

  it('keeps the enclosing deadline authoritative over a longer nested deadline', async () => {
    const { rpc, governor, send } = await setup();
    const started = performance.now();
    await expect(withRpcRequestTimeout(250, 'outer', async () => {
      await send(1);
      return withRpcRequestTimeout(10_000, 'inner', () => send(2));
    })).rejects.toMatchObject({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(rpc.totalHits()).toBe(1);
    expect(governor.snapshot().foregroundQueued).toBe(0);
  });

  it('preserves caller cancellation rather than relabelling it as local pressure', async () => {
    const { rpc, governor, send } = await setup();
    const caller = new AbortController();
    // Even a caller-owned timeout is a caller cancellation, not our attempt deadline.
    const reason = createRpcTimeoutError('caller cancelled publication');
    const pending = withRpcRequestContext({ signal: caller.signal }, () =>
      withRpcRequestTimeout(10_000, 'operation', async () => {
        await send(1);
        return send(2);
      }),
    ).then(() => undefined, (error: unknown) => error);
    await expect.poll(() => governor.snapshot().foregroundQueued).toBe(1);
    caller.abort(reason);
    expect(await pending).toBe(reason);
    expect(rpc.totalHits()).toBe(1);
    expect(governor.snapshot().foregroundQueued).toBe(0);
    expect(snapshotRpcRequestTiming().foreground).toMatchObject({
      admissionCancelledWait: { count: 1 }, admissionDeadlineWait: { count: 0 },
      endpointLatency: { count: 1 },
    });
  });

  it('does not exhaust or de-prefer the primary after one successful read and one local wait', async () => {
    const { rpc, governor, provider } = await setup();
    const backup = await startLoopbackRpc();
    servers.push(backup);
    const backupProvider = createRpcRequestProvider(backup.url, {
      network: Network.from(31_337), admission: governor, maxRetries: 0,
    });
    providers.push(backupProvider);
    const client = new RpcFailoverClient(() => [
      { provider, rpcUrl: rpc.url }, { provider: backupProvider, rpcUrl: backup.url },
    ], async () => { throw new Error('read must never sign'); }, () => 'evm:31337');
    await expect(client.read('sequential RPC reads', async (selected) => {
      await selected._send({ id: 1, method: 'eth_blockNumber', params: [], jsonrpc: '2.0' });
      return selected._send({ id: 2, method: 'eth_blockNumber', params: [], jsonrpc: '2.0' });
    }, { deadlineMs: Date.now() + 250 })).rejects.toMatchObject({
      code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
    });
    expect(rpc.totalHits()).toBe(1);
    expect(backup.totalHits()).toBe(0);
    expect(getRpcFailoverStats()).toMatchObject({
      failovers: 0, exhaustions: 0, preferredEstablishments: 0, byEndpointHost: {},
    });
    expect(governor.snapshot().foregroundQueued).toBe(0);
    // Draining a governor log window cannot erase process-cumulative failed waits.
    governor.drainWindow();
    expect(snapshotRpcRequestTiming().foreground.admissionDeadlineWait.count).toBe(1);
  });
});
