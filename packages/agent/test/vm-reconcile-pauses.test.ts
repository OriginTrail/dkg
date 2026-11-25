import { describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { VmReconcileDispatcher, VmReconcileSchedulingRuntime } from '../src/vm-reconcile-dispatcher.js';
import { VmReconcilePauses, vmReconcilePausesFor } from '../src/internal/vm-reconcile-pauses.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
describe('foreground snapshot recovery ownership', () => {
  it('wakes an explicit sweep rejected while a snapshot held its only queue slot', async () => {
    const pauses = new VmReconcilePauses(), lease = pauses.acquire('a');
    const run = vi.fn(async () => 1);
    const runtime = new VmReconcileSchedulingRuntime(run, () => {}, { pauses, maxPending: 1 });
    const sweep = runtime.completeSweep(['a'], [], () => true);
    try {
      await tick();
      expect(runtime.snapshot()).toMatchObject({ active: 0, queued: 0 });
      expect(run).not.toHaveBeenCalled();
      lease.release(); await tick();
      expect(run).toHaveBeenCalledTimes(1);
      await sweep;
    } finally { lease.release(); await runtime.close(); await sweep; }
  });

  it('drains a failing old dispatcher before a replacement resumes on the shared graph owner', async () => {
    const pauses = new VmReconcilePauses();
    let fail!: (error: Error) => void;
    const old = new VmReconcileDispatcher(() => new Promise<void>((_, reject) => { fail = reject; }), () => {}, { pauses });
    const active = old.triggerManual('a');
    const rejected = expect(active).rejects.toThrow('old pass failed');
    await tick();
    const lease = pauses.acquire('a'), closing = old.close();
    let drained = false;
    const waiting = lease.wait(new AbortController().signal).then(() => { drained = true; });
    const run = vi.fn(async () => 'new');
    const next = new VmReconcileDispatcher(run, () => {}, { pauses });
    const pending = next.triggerManual('a');
    await tick(); expect(drained).toBe(false); expect(run).not.toHaveBeenCalled();
    fail(new Error('old pass failed')); await rejected; await closing; await waiting;
    expect(run).not.toHaveBeenCalled();
    lease.release(); await expect(pending).resolves.toBe('new');
    expect(old.snapshot()).toEqual({ active: 0, queued: 0, closed: true });
    await next.close();
  });
  it('drains an admitted pass, retains a trailing nudge and runs other graphs', async () => {
    const pauses = new VmReconcilePauses();
    let finish!: () => void;
    const run = vi.fn(async (key: string) => {
      if (run.mock.calls.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      return key;
    });
    const dispatcher = new VmReconcileDispatcher(run, () => {}, { concurrency: 2, pauses });
    const first = dispatcher.dispatch('a', 'live');
    await tick();
    const lease = pauses.acquire('a');
    let drained = false;
    const wait = lease.wait(new AbortController().signal).then(() => { drained = true; });
    const later = dispatcher.triggerManual('a');
    await expect(dispatcher.triggerManual('b')).resolves.toBe('b');
    expect(drained).toBe(false);
    finish(); await first; await wait; await tick();
    expect(run.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
    expect(dispatcher.isInFlight('a')).toBe(true);
    lease.release(); await expect(later).resolves.toBe('a');
    await dispatcher.close();
  });

  it('retains coalesced live, periodic and manual work until every lease ends', async () => {
    const owner = {}, pauses = vmReconcilePausesFor(owner);
    const one = pauses.acquire('a'), two = pauses.acquire('a');
    const run = vi.fn(async () => 42);
    const dispatcher = new VmReconcileDispatcher(run, () => {}, { pauses, maxPending: 2 });
    expect(vmReconcilePausesFor(owner)).toBe(pauses);
    dispatcher.triggerLive('a'); dispatcher.triggerPeriodic('a');
    const manual = dispatcher.triggerManual('a');
    let complete = false; void manual.then(() => { complete = true; });
    await tick(); one.release(); one.release(); await tick();
    expect(run).not.toHaveBeenCalled(); expect(complete).toBe(false);
    expect(dispatcher.snapshot().queued).toBe(1);
    two.release(); await expect(manual).resolves.toBe(42);
    expect(run).toHaveBeenCalledTimes(1);
    await dispatcher.close();
  });

  it('keeps queue bounds and shutdown rejection while paused', async () => {
    const pauses = new VmReconcilePauses(), lease = pauses.acquire('a');
    const other = pauses.acquire('b'), run = vi.fn(async () => 1);
    const dispatcher = new VmReconcileDispatcher(run, () => {}, { pauses, maxPending: 1 });
    const queued = dispatcher.triggerManual('a');
    const rejected = expect(queued).rejects.toThrow('closed');
    await expect(dispatcher.triggerManual('b')).rejects.toThrow();
    await dispatcher.close(); await rejected;
    lease.release(); other.release(); await tick();
    expect(run).not.toHaveBeenCalled();
  });

  it('cancels a drain wait without leaking its listener or preventing resumption', async () => {
    const pauses = new VmReconcilePauses(), caller = new AbortController();
    pauses.started('a');
    const lease = pauses.acquire('a');
    const waiting = lease.wait(caller.signal);
    const rejected = expect(waiting).rejects.toThrow('cancelled');
    caller.abort(new Error('cancelled')); await rejected;
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    lease.release(); pauses.finished('a');
    expect(pauses.isPaused('a')).toBe(false);
  });
});
