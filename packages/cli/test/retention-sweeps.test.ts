/**
 * OT-RFC-73 P10b: starting retention. Mode `off` creates nothing and makes no store call in any runtime; any runtime but the daemon's admission instance refuses to
 * start a queue whose mode is not `off`; a factory that fails neither stops the daemon nor the other queue; a second queue's factory plugs into the same timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRetentionConfig, type ResolvedRetentionConfig } from '../src/retention-config.js';
import {
  RETENTION_SWEEP_FACTORIES, RetentionRuntimeRefusedError, startRetention, type RetentionRuntime,
} from '../src/daemon/retention-sweeps.js';
import type { RetentionAgent, RetentionSweep, RetentionSweepFactory } from '../src/daemon/retention-timer.js';

/** An agent that fails the test on any access: nothing may touch it (its store, its queue). */
const untouchable = new Proxy({}, {
  get(_target, property) { throw new Error(`the agent was touched: ${String(property)}`); },
  has() { throw new Error('the agent was touched'); },
}) as RetentionAgent;

const settings = (over: Record<string, unknown> = {}): ResolvedRetentionConfig => resolveRetentionConfig(over);
const NON_DAEMON: readonly RetentionRuntime[] = ['standalone-agent', 'worker-process', 'publisher-runner', 'offline-inspector', 'script'];

type StubSweep = RetentionSweep & { calls: number };

function stubSweep(queue: 'share' | 'publisher', mode: 'report' | 'delete', intervalMs: number): StubSweep {
  const sweep: StubSweep = {
    queue, mode, intervalMs, calls: 0,
    async runBatch() { sweep.calls += 1; return {}; },
    counters: () => ({ deleted: {}, kept: {}, skipped: {}, errors: {}, lastCompletePass: null }),
  };
  return sweep;
}

function stubFactory(queue: 'share' | 'publisher'): RetentionSweepFactory & { created: StubSweep[]; create: ReturnType<typeof vi.fn> } {
  const created: StubSweep[] = [];
  const create = vi.fn((context: Parameters<RetentionSweepFactory['create']>[0]) => {
    const mode = context.settings[queue].mode;
    if (mode === 'off') return undefined;
    const sweep = stubSweep(queue, mode, context.settings[queue].intervalMs);
    created.push(sweep);
    return sweep;
  });
  return { queue, create, created };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('mode off (the default)', () => {
  it.each(['daemon-admission', ...NON_DAEMON] as RetentionRuntime[])('in the %s runtime creates nothing: no factory runs, the agent is not touched, no timer exists', async (runtime) => {
    const share = stubFactory('share'), publisher = stubFactory('publisher');
    const log = vi.fn();
    const handle = startRetention({ runtime, settings: settings(), agent: untouchable, log, factories: [share, publisher] });
    expect(share.create).not.toHaveBeenCalled();
    expect(publisher.create).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(handle.usage()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it('is also the answer for modes written as "off" explicitly', () => {
    const share = stubFactory('share');
    startRetention({ runtime: 'daemon-admission', settings: settings({ share: { mode: 'off' }, publisher: { mode: 'off' } }), agent: untouchable, log: vi.fn(), factories: [share] });
    expect(share.create).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('only the daemon admission instance starts it', () => {
  it.each(NON_DAEMON)('the %s runtime is refused with a clear error when a mode is not off, and nothing is created', (runtime) => {
    const share = stubFactory('share'), publisher = stubFactory('publisher');
    const log = vi.fn();
    for (const written of [{ share: { mode: 'report' } }, { share: { mode: 'delete' } }, { publisher: { mode: 'report' } }, { share: { mode: 'report' }, publisher: { mode: 'delete' } }]) {
      let error: unknown;
      try { startRetention({ runtime, settings: settings(written), agent: untouchable, log, factories: [share, publisher] }); } catch (cause) { error = cause; }
      expect(error, JSON.stringify(written)).toBeInstanceOf(RetentionRuntimeRefusedError);
      expect(error).toMatchObject({ name: 'RetentionRuntimeRefusedError', code: 'RETENTION_RUNTIME_REFUSED', runtime });
      const message = (error as Error).message;
      expect(message).toContain(`the ${runtime} runtime`);
      expect(message).toContain("daemon's admission instance");
      for (const queue of Object.keys(written)) expect(message).toContain(`queueRetention.${queue}.mode`);
    }
    expect(share.create).not.toHaveBeenCalled();
    expect(publisher.create).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('an unknown runtime name is refused too (the check is fail-closed)', () => {
    expect(() => startRetention({ runtime: 'something-new' as RetentionRuntime, settings: settings({ share: { mode: 'report' } }), agent: untouchable, log: vi.fn(), factories: [stubFactory('share')] }))
      .toThrow(RetentionRuntimeRefusedError);
  });

  it('the daemon admission instance builds the sweep and ticks it on its interval; stop ends it', async () => {
    const share = stubFactory('share');
    const log = vi.fn();
    const handle = startRetention({ runtime: 'daemon-admission', settings: settings({ share: { mode: 'report', intervalMs: 5_000 } }), agent: untouchable, log, factories: [share] });
    expect(share.create).toHaveBeenCalledTimes(1);
    const context = share.create.mock.calls[0]![0];
    expect(context.agent).toBe(untouchable);
    expect(context.settings.share).toMatchObject({ mode: 'report', intervalMs: 5_000 });
    const sweep = share.created[0]!;
    expect(sweep.calls).toBe(0);                                      // the first tick is an interval after the start
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweep.calls).toBe(3);
    expect(handle.usage()).toHaveLength(1);
    expect(handle.usage()[0]).toMatchObject({ queue: 'share', mode: 'report', ticks: 3 });
    await handle.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep.calls).toBe(3);
    expect(log.mock.calls.map(call => String(call[0])).join('\n')).toMatch(/share retention started in report mode.*it judges and counts, and deletes nothing/);
  });

  it('delete mode starts with a loud warning that it is irreversible and belongs behind the delete gate', async () => {
    const share = stubFactory('share');
    const log = vi.fn();
    const handle = startRetention({ runtime: 'daemon-admission', settings: settings({ share: { mode: 'delete' } }), agent: untouchable, log, factories: [share] });
    const started = log.mock.calls.map(call => String(call[0])).find(line => line.includes('started'))!;
    expect(started).toMatch(/^\[warn\] \[retention\] share retention started in DELETE mode/);
    expect(started).toContain('cannot be restored');
    expect(started).toContain('delete gate');
    await handle.stop();
  });
});

describe('the registry', () => {
  it('holds the share factory and, until P11, no publisher factory', () => {
    expect(RETENTION_SWEEP_FACTORIES.map(factory => factory.queue)).toEqual(['share']);
  });

  it('a second queue\'s factory registers with the same timer: nothing else changes', async () => {
    const share = stubFactory('share'), publisher = stubFactory('publisher');
    const handle = startRetention({
      runtime: 'daemon-admission', settings: settings({ share: { mode: 'report', intervalMs: 1_000 }, publisher: { mode: 'delete', intervalMs: 2_000 } }),
      agent: untouchable, log: vi.fn(), factories: [share, publisher],
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(share.created[0]!.calls).toBe(4);
    expect(publisher.created[0]!.calls).toBe(2);
    expect(handle.usage().map(view => `${view.queue}:${view.mode}`)).toEqual(['share:report', 'publisher:delete']);
    await handle.stop();
  });

  it('a publisher mode that is not off, with no publisher sweep in the build, is said so in the log and runs nothing', async () => {
    const share = stubFactory('share');
    const log = vi.fn();
    const handle = startRetention({ runtime: 'daemon-admission', settings: settings({ publisher: { mode: 'report' } }), agent: untouchable, log, factories: [share] });
    expect(share.create).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(handle.usage()).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toMatch(/\[warn\] \[retention\] queueRetention\.publisher\.mode is "report" but this build has no publisher retention sweep/);
    // and the share queue is unaffected when both are asked for
    const both = startRetention({ runtime: 'daemon-admission', settings: settings({ share: { mode: 'report' }, publisher: { mode: 'report' } }), agent: untouchable, log: vi.fn(), factories: [share] });
    expect(both.usage().map(view => view.queue)).toEqual(['share']);
    await both.stop();
  });
});

describe('a factory that fails does not stop the daemon', () => {
  it('logs an error naming the queue and the cause, starts the other queue, and does not throw', async () => {
    const share: RetentionSweepFactory = { queue: 'share', create: () => { throw new Error('the queue is on another store'); } };
    const publisher = stubFactory('publisher');
    const log = vi.fn();
    const handle = startRetention({
      runtime: 'daemon-admission', settings: settings({ share: { mode: 'report' }, publisher: { mode: 'report' } }), agent: untouchable, log, factories: [share, publisher],
    });
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.find(line => line.includes('NOT started'))).toMatch(/^\[error\] \[retention\] share retention \(mode=report\) was NOT started: the queue is on another store\. The daemon keeps running with share retention off/);
    expect(handle.usage().map(view => view.queue)).toEqual(['publisher']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publisher.created[0]!.calls).toBe(1);
    await handle.stop();
  });

  it('with no sweep left the handle is inert', async () => {
    const share: RetentionSweepFactory = { queue: 'share', create: () => undefined };
    const handle = startRetention({ runtime: 'daemon-admission', settings: settings({ share: { mode: 'report' } }), agent: untouchable, log: vi.fn(), factories: [share] });
    expect(vi.getTimerCount()).toBe(0);
    expect(handle.usage()).toEqual([]);
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});
