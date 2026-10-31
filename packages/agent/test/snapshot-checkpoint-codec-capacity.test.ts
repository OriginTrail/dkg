import { afterEach, expect, it, vi } from 'vitest';
import { checkpointFixture } from './helpers/public-checkpoint-fixture.js';

const codecs = vi.hoisted(() => ({
  /** Hold this many compressing lanes, then start their real codecs together. */
  holdLanes: 0, held: [] as Array<() => void>,
  refused: 0, gunzipRefusals: 0,
  compress: undefined as undefined | ((bytes: Uint8Array) => Error | undefined),
}));
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), availableParallelism: () => 4, freemem: () => 8 * 2 ** 30,
}));
vi.mock('@origintrail-official/dkg-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return {
    ...actual,
    gzipBounded: async (...args: Parameters<typeof actual.gzipBounded>) => {
      // Only a verification lane compresses with this ceiling; the supplier's own codec calls pass through.
      if (args[1].maxOutputBytes !== 16 * 1024 * 1024) return actual.gzipBounded(...args);
      const failure = codecs.compress?.(args[0]);
      if (failure) throw failure;
      if (codecs.holdLanes > 0) {
        await new Promise<void>(resolve => {
          codecs.held.push(resolve);
          if (codecs.held.length === codecs.holdLanes) {
            codecs.holdLanes = 0;
            for (const start of codecs.held.splice(0)) start();
          }
        });
      }
      try { return await actual.gzipBounded(...args); } catch (error) {
        if (error instanceof actual.BoundedGzipCapacityError) codecs.refused++;
        throw error;
      }
    },
    gunzipBounded: async (...args: Parameters<typeof actual.gunzipBounded>) => {
      if (codecs.gunzipRefusals > 0) { codecs.gunzipRefusals--; throw new actual.BoundedGzipCapacityError(); }
      return actual.gunzipBounded(...args);
    },
  };
});
afterEach(() => { Object.assign(codecs, { holdLanes: 0, refused: 0, gunzipRefusals: 0, compress: undefined }); codecs.held.length = 0; });

it('finishes a job whose lanes all compress at once, more than the process has room for', async () => {
  const f = await checkpointFixture();
  codecs.holdLanes = 3;
  const result = await f.run();
  expect(result.manifest.assets).toHaveLength(3);
  expect(codecs.refused).toBeGreaterThan(0);
}, 30_000);

it('waits for capacity to decompress a compressed asset too', async () => {
  const f = await checkpointFixture({ payloadBytes: [14, 4000, 14] });
  codecs.gunzipRefusals = 3;
  const result = await f.run();
  expect(result.manifest.assets).toHaveLength(3);
  expect(codecs.gunzipRefusals).toBe(0);
}, 30_000);

it('ends a wait with the reason the job was cancelled', async () => {
  const f = await checkpointFixture();
  const reason = new Error('retired');
  const { BoundedGzipCapacityError } = await vi.importActual<typeof import('@origintrail-official/dkg-core')>('@origintrail-official/dkg-core');
  const waiting = new Set<string>();
  codecs.compress = bytes => {
    // Cancel once every lane waits, so none is still inside a verification thread that the cancellation closes.
    waiting.add(Buffer.from(bytes).toString());
    if (waiting.size === 3) f.abort.abort(reason);
    return new BoundedGzipCapacityError();
  };
  await expect(f.run()).rejects.toBe(reason);
}, 30_000);

it('still fails the job on any other codec failure', async () => {
  const f = await checkpointFixture();
  const failure = new Error('codec failed');
  const compress = vi.fn(() => failure);
  codecs.compress = compress;
  await expect(f.run()).rejects.toBe(failure);
  expect(compress.mock.calls.length).toBeLessThanOrEqual(3);
}, 30_000);
