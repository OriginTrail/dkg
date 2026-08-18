import { execFileSync, spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createForegroundSignalRelay,
  FOREGROUND_RELAY_KILL_GRACE_MS,
  FOREGROUND_TERMINATING_SIGNALS,
  type ForegroundSignalRelayIo,
  type RelayWorker,
} from '../src/daemon/foreground-signal-relay.js';
import {
  SHUTDOWN_HARD_TIMEOUT_MS,
  SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS,
} from '../src/daemon/shutdown.js';

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
  /** The delay (ms) of every escalation timer the relay armed. */
  armedDelays: number[];
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
  const armedDelays: number[] = [];

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
    setTimeout: (handler, ms) => {
      timers.push(handler);
      armedDelays.push(ms);
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    },
    clearTimeout: () => { timers = []; },
  };

  return {
    io,
    kills,
    childKills,
    terminated,
    armedDelays,
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

  it('stops the worker with SIGSTOP before suspending itself, then resumes both', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(4242));

    h.raise('SIGTSTP');
    // Must be SIGSTOP, not SIGTSTP: the worker's group is orphaned, and POSIX
    // discards SIGTSTP sent to a default-disposition process in such a group.
    // Ctrl-Z must halt the job as a unit: worker first, supervisor second.
    expect(h.kills).toEqual(['-4242:SIGSTOP']);
    expect(h.suspended).toBe(1);
    // A stop is not a shutdown — `fg` must be able to resume the node.
    expect(relay.signalled()).toBeNull();

    h.raise('SIGCONT');
    expect(h.kills).toEqual(['-4242:SIGSTOP', '-4242:SIGCONT']);
  });

  it('arms the force-kill for longer than the worker\'s own shutdown budget', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(4242));

    h.raise('SIGTERM');

    // The delay the relay ACTUALLY arms is the thing that matters: a worker
    // shutting down as designed self-exits at its own deadline, so escalating
    // inside that window would SIGKILL a healthy node mid-flush. Asserting only
    // that the constant is large would still pass if the relay armed a shorter
    // timer.
    expect(h.armedDelays).toEqual([FOREGROUND_RELAY_KILL_GRACE_MS]);
    expect(FOREGROUND_RELAY_KILL_GRACE_MS).toBeGreaterThan(
      SHUTDOWN_HARD_TIMEOUT_MS + SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS,
    );
  });

  it('does not let repeated signals push the force-kill backstop out', () => {
    const h = harness();
    const relay = createForegroundSignalRelay({ onTerminate: () => {}, io: h.io });
    relay.attach(h.worker(4242));

    h.raise('SIGINT');
    h.raise('SIGINT');
    h.raise('SIGINT');

    // Three Ctrl-Cs, one deadline: a user asking harder for the node to die must
    // not extend the window in which it is allowed to ignore them.
    expect(h.armedDelays).toEqual([FOREGROUND_RELAY_KILL_GRACE_MS]);
    expect(h.pendingTimers()).toBe(1);
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

  // The mocked-kill tests above can only prove which signal was ISSUED. Whether
  // the kernel DELIVERS it to a setsid'd worker is the part that actually broke:
  // an orphaned process group silently discards SIGTSTP. This exercises a real
  // detached child so a stop signal that no-ops cannot pass as a green test.
  it.runIf(process.platform !== 'win32')(
    'really suspends a setsid worker group, and resumes it',
    async () => {
      const child = spawn(
        process.execPath,
        // Mirrors the daemon worker: handlers for SIGINT/SIGTERM only, so its
        // stop-signal disposition stays SIG_DFL.
        ['-e', "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"],
        { detached: true, stdio: 'ignore' },
      );
      const pid = child.pid!;
      const stateOf = (): string => {
        try {
          return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim();
        } catch {
          return 'GONE';
        }
      };
      const settle = () => new Promise<void>(done => setTimeout(done, 300));

      // Real kill(), real signal delivery — only the self-suspend is stubbed,
      // since SIGSTOPping the test runner would deadlock it.
      const relay = createForegroundSignalRelay({
        onTerminate: () => {},
        io: { suspendSelf: () => {} },
      });
      try {
        await settle();
        expect(stateOf()).not.toMatch(/^T/);

        relay.attach({ pid, kill: (signal: NodeJS.Signals) => child.kill(signal) });

        // Ctrl-Z: the worker group must actually stop, not merely be signalled.
        process.emit('SIGTSTP' as never);
        await settle();
        expect(stateOf()).toMatch(/^T/);

        // `fg`: both halves come back.
        process.emit('SIGCONT' as never);
        await settle();
        expect(stateOf()).not.toMatch(/^T/);
      } finally {
        relay.dispose();
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    },
  );

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
