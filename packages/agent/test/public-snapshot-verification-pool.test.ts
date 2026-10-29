import { beforeEach, expect, it, vi } from 'vitest';
import { withSnapshotVerificationPool } from '../src/snapshot-verification-pool.js';
const state = vi.hoisted(() => ({ close: [] as ReturnType<typeof vi.fn>[] }));
vi.mock('node:os', () => ({ availableParallelism: () => 2, freemem: () => 4 * 2 ** 30 }));
vi.mock('../src/sync-verify-worker.js', () => ({ SyncVerifyWorker: class {
  close = vi.fn(async () => {});
  constructor() { state.close.push(this.close); }
  async parseAndFilter() {} async processDurableBatch() {}
} }));
beforeEach(() => { state.close.length = 0; });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
it('preserves lane order despite reverse completion', async () => {
  const gate = deferred();
  const result = await withSnapshotVerificationPool({ contextGraphId: 'graph', signal: new AbortController().signal,
    run: async ({ index }) => { if (index === 0) await gate.promise; else gate.resolve(); return index; } });
  expect(result).toEqual([0, 1]); expect(state.close.every(close => close.mock.calls.length > 0)).toBe(true);
});
it.each(['failure', 'cancel'] as const)('drains callbacks and physical workers after %s without hiding the cause', async mode => {
  const lane = deferred(), physical = deferred(), started = deferred(); const caller = new AbortController();
  const cause = new Error(mode);
  let settled = false;
  const work = withSnapshotVerificationPool({ contextGraphId: 'graph', signal: caller.signal,
    run: async ({ index }) => {
      if (index === 0) { await started.promise; if (mode === 'cancel') caller.abort(cause); else throw cause; return index; }
      state.close.forEach(close => close.mockImplementation(async () => { await physical.promise; throw new Error('close failed'); }));
      started.resolve(); await lane.promise; return index;
    } });
  const rejected = expect(work).rejects.toBe(cause); void work.catch(() => { settled = true; });
  await expect.poll(() => state.close.every(close => close.mock.calls.length > 0)).toBe(true);
  expect(settled).toBe(false); lane.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
  expect(settled).toBe(false); physical.resolve(); await rejected;
});
