// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
const body = JSON.stringify({ contextGraphId: 'test', onChainId: '1', trustedCorePeerIds: ['core'] });
function held() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, operation: vi.fn(() => promise) };
}
async function serve(checkpoint = held(), snapshot = held()) {
  const agent = {
    preparePublicGraphCheckpoint: checkpoint.operation,
    syncPublicGraphSnapshot: snapshot.operation,
    getPublicSnapshotSourcePolicies: () => ['base-mainnet-registered-cores'],
    getDefaultAgentAddress: () => undefined,
    resolveAgentByToken: () => undefined,
  };
  let arrived = 0;
  const server = createServer(async (req, res) => {
    arrived++;
    const url = new URL(req.url!, 'http://127.0.0.1');
    await handleContextGraphRoutes({ req, res, agent, url, path: url.pathname,
      config: { auth: { enabled: true } },
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
    } as any);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/context-graph/`;
  return { checkpoint, snapshot, arrived: () => arrived,
    url: (kind: string) => root + (kind === 'checkpoint' ? 'snapshot-checkpoint' : 'snapshot-sync') };
}
async function status(url: string) { return (await fetch(url)).json(); }

describe('snapshot job ownership and admission', () => {
  it.each(['checkpoint', 'snapshot'] as const)('admits one %s job when two request bodies finish together', async kind => {
    const fixture = await serve();
    const requests = [0, 1].map(() => {
      let client!: ReturnType<typeof request>;
      const response = new Promise<number>(resolve => {
        client = request(fixture.url(kind), { method: 'POST' }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode!));
        });
        client.write(body.slice(0, -1));
      });
      return { client, response };
    });
    // Both handlers have passed the initial admission check and await their bodies.
    await vi.waitFor(() => expect(fixture.arrived()).toBe(2));
    requests.forEach(({ client }) => client.end('}'));
    expect((await Promise.all(requests.map(r => r.response))).sort()).toEqual([202, 409]);
    expect(fixture[kind].operation).toHaveBeenCalledTimes(1);
    fixture[kind].resolve({ current: false });
    await vi.waitFor(async () => expect((await status(fixture.url(kind))).state).toBe('complete'));
  });

  it('keeps endpoint histories, response shapes and node owners independent', async () => {
    const first = await serve(), second = await serve();
    const checkpoint = first.url('checkpoint'), snapshot = first.url('snapshot');
    const running = await (await fetch(checkpoint, { method: 'POST', body })).json();
    expect(await status(snapshot)).toMatchObject({ state: 'idle' });
    expect(await status(second.url('checkpoint'))).toEqual({ state: 'idle' });
    expect((await fetch(snapshot, { method: 'POST', body })).status).toBe(202);
    expect((await fetch(second.url('checkpoint'), { method: 'POST', body })).status).toBe(202);
    first.checkpoint.reject(new Error('Inventory changed'));
    first.snapshot.resolve({ current: true });
    second.checkpoint.resolve({ current: false, committed: 0, state: 'verified-unpublished' });
    await vi.waitFor(async () => expect((await status(checkpoint)).state).toBe('failed'));
    await vi.waitFor(async () => expect((await status(snapshot)).state).toBe('complete'));
    const failed = await status(checkpoint), complete = await status(snapshot);
    expect(failed).toEqual({ id: running.id, startedAt: running.startedAt, state: 'failed', error: 'Inventory changed' });
    expect(complete).toMatchObject({ state: 'complete', result: { current: true },
      request: { contextGraphId: 'test', trustedCorePeerIds: ['core'] }, finishedAt: expect.any(Number) });
    expect(complete.id).not.toBe(running.id);
    await vi.waitFor(async () => expect(await status(second.url('checkpoint'))).toMatchObject({ state: 'complete' }));
    for (const fixture of [first, second]) expect(fixture.checkpoint.operation).toHaveBeenCalledTimes(1);
  });
});
