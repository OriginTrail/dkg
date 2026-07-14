import { signalWorkerProcessGroup, WORKER_GROUP_TERM_GRACE_MS } from './worker-process-group.js';

/**
 * Terminal-delivered signals whose POSIX default action ends the supervisor.
 *
 * `SIGQUIT` is POSIX-only; Windows emulates the other three.
 */
export const FOREGROUND_TERMINATING_SIGNALS = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGQUIT',
] as const satisfies readonly NodeJS.Signals[];

/** Job-control signals a tty delivers only to its foreground process group. */
export const FOREGROUND_JOB_CONTROL_SIGNALS = [
  'SIGTSTP',
  'SIGCONT',
] as const satisfies readonly NodeJS.Signals[];

export interface RelayWorker {
  readonly pid?: number;
  kill(signal: NodeJS.Signals): boolean;
}

export interface ForegroundSignalRelayIo {
  platform?: NodeJS.Platform;
  kill?: typeof process.kill;
  on?: (signal: NodeJS.Signals, handler: () => void) => void;
  off?: (signal: NodeJS.Signals, handler: () => void) => void;
  /** Re-raise the stop on the supervisor itself so the shell sees a stopped job. */
  suspendSelf?: () => void;
  setTimeout?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  killGraceMs?: number;
}

export interface ForegroundSignalRelay {
  /**
   * Adopt the worker that is now current. A terminating signal that arrived
   * before this call is replayed onto the new worker immediately, so a signal
   * landing in the spawn window can never be dropped.
   */
  attach(worker: RelayWorker): void;
  detach(): void;
  /** The terminating signal already seen, if any. */
  signalled(): NodeJS.Signals | null;
  dispose(): void;
}

/**
 * Relay terminal signals from a `--foreground` supervisor to its worker.
 *
 * The worker runs in a private POSIX session so the supervisor can reap its
 * descendants (the managed Oxigraph) as one process group. That same isolation
 * means the tty no longer delivers job-control or hangup signals to the worker:
 * they reach the supervisor's foreground process group and stop there. Without
 * this relay, closing the terminal kills the supervisor and leaves the worker
 * and its managed store running with the store port still bound -- exactly the
 * orphan this module's process-group cleanup exists to prevent.
 *
 * Signals are addressed to the worker's process group, not its PID, so
 * descendants receive them too. Terminating signals arm a bounded escalation:
 * a worker that ignores the relayed signal is SIGKILLed as a group rather than
 * left to outlive a terminal that is already gone.
 */
export function createForegroundSignalRelay(opts: {
  onTerminate: (signal: NodeJS.Signals) => void;
  io?: ForegroundSignalRelayIo;
}): ForegroundSignalRelay {
  const io = opts.io ?? {};
  const platform = io.platform ?? process.platform;
  const kill = io.kill ?? process.kill.bind(process);
  const on = io.on ?? ((signal, handler) => { process.on(signal, handler); });
  const off = io.off ?? ((signal, handler) => { process.off(signal, handler); });
  const suspendSelf = io.suspendSelf ?? (() => { kill(process.pid, 'SIGSTOP'); });
  const arm = io.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const disarm = io.clearTimeout ?? ((timer) => clearTimeout(timer));
  const killGraceMs = io.killGraceMs ?? WORKER_GROUP_TERM_GRACE_MS;

  let worker: RelayWorker | null = null;
  let terminating: NodeJS.Signals | null = null;
  let escalation: NodeJS.Timeout | null = null;

  // Prefer the worker's process group: the worker is its own group leader, so
  // `-pid` reaches the managed store too. Windows has no process groups and an
  // already-exited group reports ESRCH; both fall back to the child handle.
  const relay = (signal: NodeJS.Signals): void => {
    if (!worker) return;
    if (signalWorkerProcessGroup(worker.pid, signal, { platform, kill })) return;
    try {
      worker.kill(signal);
    } catch {
      /* worker already gone; the post-exit reap is still the authority */
    }
  };

  const cancelEscalation = (): void => {
    if (!escalation) return;
    disarm(escalation);
    escalation = null;
  };

  const armEscalation = (): void => {
    cancelEscalation();
    const target = worker;
    escalation = arm(() => {
      escalation = null;
      // Still the same worker, and it outlived the grace window: force it.
      if (worker && worker === target) relay('SIGKILL');
    }, killGraceMs);
    escalation.unref?.();
  };

  const onTerminatingSignal = (signal: NodeJS.Signals) => () => {
    terminating ??= signal;
    opts.onTerminate(signal);
    relay(signal);
    if (worker) armEscalation();
  };

  const onStop = (): void => {
    relay('SIGTSTP');
    // Suspend only after the worker is stopped, so the job halts as one unit
    // and the shell reports a stopped job rather than a vanished one.
    suspendSelf();
  };

  const onContinue = (): void => {
    relay('SIGCONT');
  };

  const handlers: Array<[NodeJS.Signals, () => void]> = [];
  for (const signal of FOREGROUND_TERMINATING_SIGNALS) {
    // Windows emulates INT/TERM/HUP but has no SIGQUIT.
    if (platform === 'win32' && signal === 'SIGQUIT') continue;
    handlers.push([signal, onTerminatingSignal(signal)]);
  }
  if (platform !== 'win32') {
    handlers.push(['SIGTSTP', onStop], ['SIGCONT', onContinue]);
  }
  for (const [signal, handler] of handlers) on(signal, handler);

  return {
    attach(next: RelayWorker) {
      worker = next;
      // A terminating signal that landed while no worker was current (during
      // the pre-spawn await, or between spawn and adoption) still owns this
      // worker's fate. Replay it now instead of supervising a worker the user
      // has already asked to die.
      if (terminating) {
        relay(terminating);
        armEscalation();
      }
    },
    detach() {
      cancelEscalation();
      worker = null;
    },
    signalled() {
      return terminating;
    },
    dispose() {
      cancelEscalation();
      worker = null;
      for (const [signal, handler] of handlers) off(signal, handler);
    },
  };
}
