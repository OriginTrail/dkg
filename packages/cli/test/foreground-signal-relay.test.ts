import { describe, expect, it } from 'vitest';
import {
  createForegroundSignalRelay,
  FOREGROUND_TERMINATING_SIGNALS,
  type ForegroundSignalRelayIo,
  type RelayWorker,
} from '../src/daemon/foreground-signal-relay.js';

function esrch(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing process'), { code: 'ESRCH' });
}

interface Harness {
  io: ForegroundSignalRelayIo;
  /** Every kill() the relay issued, as `pid:signal`. */
  kills: string[];
  /** Signals delivered through the ChildProcess handle instead of the group. */
  childKills: NodeJS.Signals[];
  terminated: NodeJS.Signals[];
  suspended: number;
  raise(signal: NodeJS.Signals): void;
  worker(pid: number | undefined): RelayWorker;
  /** Fire the pending escalation timer. */
  runEscalation(): void;
  pendingTimers(): number;
}

function harness(opts: { platform?: NodeJS.Platform; groupMissing?: boolean } = {}): Harness {
  const listeners = new Map<NodeJS.Signals, Set<() => void>>();
  const kills: string[] = [];
  const childKills: NodeJS.Signals[] = [];
  const terminated: NodeJS.Signals[] = [];
  let suspended = 0;
  let timers: Array<() => void> = [];

  const kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    kills.push(`${pid}:${String(signal ?? 'SIGTERM')}`);
    if (opts.groupMissing && pid < 0) throw esrch();
    return true;
  }) as typeof process.kill;

  const io: ForegroundSignalRelayIo = {
    platform: opts.platform ?? 'linux',
    kill,
    on: (signal, handler) => {
      if (!listeners.has(signal)) listeners.set(signal, new Set());
      listeners.get(signal)!.add(handler);
    },
    off: (signal, handler) => { listeners.get(signal)?.delete(handler); },
    suspendSelf: () => { suspended += 1; },
    setTimeout: (handler) => {
      timers.push(handler);
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    },
    clearTimeout: () => { timers = []; },
  };

  return {
    io,
    kills,
    childKills,
    terminated,
    get suspended() { return suspended; },
    raise: (signal) => { for (const handler of listeners.get(signal) ?? []) handler(); },
    worker: (pid) => ({
      pid,
      kill: (signal: NodeJS.Signals) => { childKills.push(signal); return true; },
    }),
    runEscalation: () => {
      const pending = timers;
      timers = [];
      for (const handler of pending) handler();
    },
    pendingTimers: () => timers.length,
  } as Harness;
}

describe('foreground signal relay', () => {
  it.each(FOREGROUND_TERMINATING_SIGNALS)(
    'relays %s to the worker process group, not just the worker pid',
    (signal) => {
      const h = harness();
      const relay = createForegroundSignalRelay({
        onTerminate: (s) => h.terminated.push(s),
        io: h.io,
      });
      relay.attach(h.worker(4242));

      h.raise(signal);

      // Negative pid == the worker's whole process group, so the managed
      // Oxigraph it owns receives the signal too.
      expect(h.kills).toContain(`-4242:${signal}`);
      expect(h.childKills).toEqual([]);
      expect(relay.signalled()).toBe(signal);
      expect(h.terminated).toEqual([signal]);
    },
  );

  it('SIGHUP reaches the worker — the regression that orphaned it on terminal close', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(777));

    h.raise('SIGHUP');

    expect(h.kills).toContain('-777:SIGHUP');
    expect(relay.signalled()).toBe('SIGHUP');
  });

  it('escalates to SIGKILL when the worker outlives the grace window', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(4242));

    h.raise('SIGTERM');
    expect(h.kills).toEqual(['-4242:SIGTERM']);

    h.runEscalation();
    expect(h.kills).toEqual(['-4242:SIGTERM', '-4242:SIGKILL']);
  });

  it('does not escalate onto a replacement worker that reused the pid', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    const first = h.worker(4242);
    relay.attach(first);

    h.raise('SIGTERM');
    // Worker exits; the supervisor detaches before the escalation window closes.
    relay.detach();

    // detach() must disarm the timer, or a later worker — possibly holding a
    // recycled pid — would be SIGKILLed by a signal it never received.
    expect(h.pendingTimers()).toBe(0);
    h.runEscalation();
    expect(h.kills).toEqual(['-4242:SIGTERM']);
  });

  it('replays a signal that arrived while no worker was attached', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });

    // Ctrl-C during the supervisor's pre-spawn await: no worker exists yet.
    h.raise('SIGINT');
    expect(h.kills).toEqual([]);

    relay.attach(h.worker(999));

    // The worker must not be supervised as if nothing happened.
    expect(h.kills).toEqual(['-999:SIGINT']);
    expect(relay.signalled()).toBe('SIGINT');
  });

  it('falls back to the child handle when the group is unreachable', () => {
    const h = harness({ groupMissing: true });
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(4242));

    h.raise('SIGTERM');

    expect(h.childKills).toEqual(['SIGTERM']);
  });

  it('falls back to the child handle when the worker pid is unknown', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(undefined));

    h.raise('SIGINT');

    expect(h.kills).toEqual([]);
    expect(h.childKills).toEqual(['SIGINT']);
  });

  it('stops the worker before suspending itself, then resumes both', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(4242));

    h.raise('SIGTSTP');
    // Ctrl-Z must halt the job as a unit: worker first, supervisor second.
    expect(h.kills).toEqual(['-4242:SIGTSTP']);
    expect(h.suspended).toBe(1);
    // A stop is not a shutdown — `fg` must be able to resume the node.
    expect(relay.signalled()).toBeNull();

    h.raise('SIGCONT');
    expect(h.kills).toEqual(['-4242:SIGTSTP', '-4242:SIGCONT']);
  });

  it('keeps the first terminating signal as the shutdown cause', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(4242));

    h.raise('SIGINT');
    h.raise('SIGTERM');

    expect(relay.signalled()).toBe('SIGINT');
    // A second Ctrl-C still reaches the worker rather than being swallowed.
    expect(h.kills).toEqual(['-4242:SIGINT', '-4242:SIGTERM']);
  });

  it('does not register POSIX-only signals on Windows', () => {
    const h = harness({ platform: 'win32' });
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(4242));

    // Windows has no SIGQUIT/SIGTSTP/SIGCONT and no process groups.
    h.raise('SIGQUIT');
    h.raise('SIGTSTP');
    expect(h.kills).toEqual([]);
    expect(h.childKills).toEqual([]);
    expect(h.suspended).toBe(0);

    h.raise('SIGTERM');
    expect(h.childKills).toEqual(['SIGTERM']);
  });

  it('removes its process listeners on dispose', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(4242));

    relay.dispose();
    h.raise('SIGTERM');

    expect(h.kills).toEqual([]);
    expect(h.childKills).toEqual([]);
  });
});
