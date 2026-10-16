import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorePriorityScheduler } from '@origintrail-official/dkg-storage';
import { BULK_GRAPH_KIND as K } from '@origintrail-official/dkg-core';
import { fixture, cg } from './helpers/bulk-graph-fixture.js';

afterEach(() => vi.restoreAllMocks());

describe('admitted public snapshots alongside durable repair', () => {
  it.each(['cold', 'warm'] as const)('finishes a %s export while a repair write owns the background slot', async mode => {
    const f = await fixture(2);
    if (mode === 'warm') await f.run();
    const scheduler = new StorePriorityScheduler();
    let release!: () => void;
    const repair = scheduler.run('background', 'agent.durableSync.graphScopedMaterialization',
      () => new Promise<void>(resolve => { release = resolve; }));
    const query = f.source.query.bind(f.source);
    const reads = vi.spyOn(f.source, 'query').mockImplementation((sparql, options) =>
      scheduler.run(options?.priority, options?.source ?? 'unknown', () => query(sparql, options), options?.signal));
    const outcome = f.run().then(value => ({ value }), error => ({ error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([outcome, new Promise<{ timedOut: true }>(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), 5000);
      })]);
      expect(result, 'export must not wait for the held repair write').toHaveProperty('value');
      expect(result && 'value' in result && result.value.committedAssetUals).toEqual(f.uals);
      expect(scheduler.snapshot.backgroundInflight).toBe(1);
      expect(reads.mock.calls.length).toBeGreaterThanOrEqual(6);
      for (const [, options] of reads.mock.calls) expect(options?.priority).toBe('normal');
      expect(f.exports.slice(-2)).toEqual(mode === 'warm' ? [0, 0] : [1, 1]);
    } finally { clearTimeout(timer); f.cancellation.abort(); release(); await repair; await outcome; }
    expect(scheduler.snapshot).toMatchObject({ normalInflight: 0, normalQueued: 0, backgroundInflight: 0, backgroundQueued: 0 });
    // The promotion is request scoped: unrelated cache reads retain their original lane.
    reads.mockClear();
    const lease = (await f.exportCache.acquireEncoded({ contextGraphId: cg, assetUal: f.uals[0]! }))!;
    try { await lease.assertCurrent(); } finally { lease.release(); }
    for (const [, options] of reads.mock.calls) expect(options?.priority).toBe('background');
  });

  it('releases store admission while waiting for stream completion and preserves repair progress', async () => {
    let releaseStream!: () => void, entered!: () => void;
    const heldStream = new Promise<void>(resolve => { releaseStream = resolve; });
    const atEnd = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(1, -1, false, { beforeSend: async frame => {
      if (frame.kind === K.CHUNK_END) { entered(); await heldStream; }
    } });
    const scheduler = new StorePriorityScheduler();
    const query = f.source.query.bind(f.source);
    vi.spyOn(f.source, 'query').mockImplementation((sparql, options) =>
      scheduler.run(options?.priority, options?.source ?? 'unknown', () => query(sparql, options), options?.signal));
    const run = f.run();
    try {
      await atEnd;
      expect(scheduler.snapshot).toMatchObject({ normalInflight: 0, backgroundInflight: 0 });
      await expect(scheduler.run('background', 'repair', async () => 'progress')).resolves.toBe('progress');
      await expect(scheduler.run('normal', 'api.query', async () => 'responsive')).resolves.toBe('responsive');
    } finally { releaseStream(); await run; }
  });
});
