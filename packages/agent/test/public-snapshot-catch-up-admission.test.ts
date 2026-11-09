// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { PublicSnapshotServingRuntime } from '../src/public-snapshot-serving-runtime.js';
import { createPublicSnapshotReader } from '../src/public-snapshot-reader.js';
import { recoverPublicSnapshotToCurrent } from '../src/public-snapshot-catch-up.js';
import { makeSnapshotAssets, sealSnapshotOf } from './helpers/public-snapshot-assets.js';

const graph = 'catch-up-admission';
afterEach(() => { vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers();
  const lifetime = new AgentWorkLifetime(), caller = new AbortController();
  const empty = sealSnapshotOf(graph, []), added = sealSnapshotOf(graph, makeSnapshotAssets(graph, 1));
  const build = vi.fn().mockResolvedValueOnce(empty).mockResolvedValue(added);
  const runtime = new PublicSnapshotServingRuntime(build, lifetime);
  const request = vi.fn(async (_peer: string, refresh: boolean) => {
    try { return Buffer.from(JSON.stringify(await runtime.get('edge', empty, refresh))); }
    catch { return Buffer.from('{"unavailable":true}'); }
  });
  const assertCurrent = vi.fn();
  const read = createPublicSnapshotReader({ mode: 'core-cache', chain: {}, request,
    peers: ['core'], expected: empty, signal: caller.signal, assertCurrent });
  const recover = vi.fn(async (observation: Awaited<ReturnType<typeof read>>) =>
    ({ committed: new Set(observation.snapshot.assets.map(asset => asset.id)) }));
  const run = async (duration = 120_000) => recoverPublicSnapshotToCurrent({ initial: await read(),
    deadline: Date.now() + duration, signal: caller.signal, assertCurrent, recover, readFresh: () => read(true) });
  return { run, caller, build, request, recover, assertCurrent, lifetime };
}

it('recovers one addition and confirms stable coverage through the real two-build serving window', async () => {
  const h = fixture(), start = Date.now(), job = h.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.build).toHaveBeenCalledTimes(2);
  expect(h.request).toHaveBeenCalledTimes(3); // The real runtime refuses the third physical build.
  expect(h.recover.mock.calls.map(([o]) => o.snapshot.assets.length)).toEqual([0, 1]);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(h.request).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  const result = await job;
  expect(Date.now() - start).toBe(60_000);
  expect(result.rounds).toBe(2);
  expect(result.recovered.committed.size).toBe(1);
  expect(result.fresh.snapshot.inventoryDigest).toBe(result.observation.snapshot.inventoryDigest);
  expect(h.build).toHaveBeenCalledTimes(3);
  expect(h.request).toHaveBeenCalledTimes(4);
  expect(h.recover).toHaveBeenCalledTimes(2); // Waiting does not reimport recovered data.
  expect(h.lifetime.physicalRuns.size).toBe(0);
});

it.each(['deadline', 'abort', 'ownership'] as const)('stops admission waiting on the original %s boundary', async boundary => {
  const h = fixture(), job = h.run(boundary === 'deadline' ? 1_000 : 120_000);
  const failed = expect(job).rejects.toThrow(boundary === 'deadline' ? 'original job deadline' : boundary);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.request).toHaveBeenCalledTimes(3);
  if (boundary === 'abort') h.caller.abort(new Error('abort'));
  if (boundary === 'ownership') h.assertCurrent.mockImplementation(() => { throw new Error('ownership'); });
  await vi.advanceTimersByTimeAsync(boundary === 'deadline' ? 1_000 : 2_500);
  await failed;
  expect(h.request).toHaveBeenCalledTimes(3);
  // Serving request deadlines intentionally remain alive after release; the
  // client retry timer must be gone without cancelling those core deadlines.
  expect(vi.getTimerCount()).toBe(2);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.request).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not retry a malformed snapshot as an admission refusal', async () => {
  const h = fixture();
  h.request.mockResolvedValueOnce(Buffer.from(JSON.stringify(sealSnapshotOf(graph, []))))
    .mockResolvedValue(Buffer.from('{"notASnapshot":true}'));
  await expect(h.run()).rejects.toThrow('No configured core');
  expect(h.request).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
