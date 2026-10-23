import { expect, it, vi } from 'vitest';
import { BoundedWork } from '../src/bounded-work.js';

it('hands failed slots to FIFO waiters before new arrivals without exceeding capacity', async () => {
  const slots = new BoundedWork(2), started: string[] = [], releases: Array<() => void> = [];
  const tasks: Array<Promise<unknown>> = []; let active = 0, peak = 0;
  const failure = new Error('first task failed');
  const gate = () => { let release!: () => void; const ready = new Promise<void>(yes => { release = yes; }); releases.push(release); return { ready, release }; };
  const a = gate(), b = gate(), c = gate(), d = gate();
  const start = (name: string, ready: Promise<void>, fail = false) => {
    const task = slots.run(async () => {
      started.push(name); active++; peak = Math.max(peak, active);
      try { await ready; if (fail) throw failure; return name; }
      finally { active--; }
    }).then(value => ({ value }), error => ({ error }));
    tasks.push(task); return task;
  };
  try {
    const first = start('a', a.ready, true); start('b', b.ready); start('c', c.ready); start('d', d.ready);
    expect(started).toEqual(['a', 'b']); a.release();
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']));
    start('e', Promise.resolve()); expect(started).toEqual(['a', 'b', 'c']);
    b.release(); await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c', 'd']));
    c.release(); await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c', 'd', 'e']));
    d.release(); await Promise.all(tasks);
    await expect(first).resolves.toEqual({ error: failure }); expect(peak).toBe(2); expect(active).toBe(0);
  } finally { for (const release of releases) release(); }
});
it('releases a physical slot when a starter throws synchronously', async () => {
  const slots = new BoundedWork(1), failure = new Error('synchronous starter failure');
  await expect(slots.run(() => { throw failure; })).rejects.toBe(failure);
  await expect(slots.run(async () => 'next')).resolves.toBe('next');
});
