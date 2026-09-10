import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { constants as osConstants } from 'node:os';
import {
  readCgroupOomKill,
  readCgroupOomSnapshot,
  type CgroupOomSnapshot,
} from './oxigraph-memory.js';

export const OXIGRAPH_WATCHDOG_OOM_MARKER =
  '[oxigraph-watchdog] scoped child OOM-killed by cgroup memory cap (or host OOM)';

export interface OxigraphParentWatchdogOptions {
  parentPid: number;
  command: string;
  args: readonly string[];
  pollIntervalMs?: number;
  stopGraceMs?: number;
  spawnChild?: typeof spawn;
  isProcessAlive?: (pid: number) => boolean;
  readOomSnapshot?: (pid: number) => CgroupOomSnapshot | null;
  readOomKill?: (dir: string) => number | null;
}

export interface OxigraphParentWatchdogResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  parentLost: boolean;
  oomKilled: boolean;
}

export interface OxigraphParentWatchdogHandle {
  child: ChildProcess;
  result: Promise<OxigraphParentWatchdogResult>;
  stop(signal?: NodeJS.Signals): void;
}

export interface OxigraphWatchdogLaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly protectedByParentDeathSignal: boolean;
}

/** Pure host-policy seam; runtime callers cannot select a different platform. */
export function buildOxigraphWatchdogLaunchPlan(
  platform: NodeJS.Platform,
  watchdogPid: number,
  command: string,
  args: readonly string[],
): OxigraphWatchdogLaunchPlan {
  if (platform !== 'linux') {
    return Object.freeze({
      command,
      args: Object.freeze([...args]),
      protectedByParentDeathSignal: false,
    });
  }
  return Object.freeze({
    command: 'setpriv',
    args: Object.freeze([
      '--pdeathsig', 'SIGKILL', '--', '/bin/sh', '-c',
      '[ "$PPID" = "$1" ] || exit 125; shift; exec "$@"',
      'dkg-oxigraph-child', String(watchdogPid), command, ...args,
    ]),
    protectedByParentDeathSignal: true,
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep Oxigraph tied to the DKG daemon even though systemd places it in a
 * sibling cgroup. The typed watchdog forwards shutdown signals and terminates
 * Oxigraph when the original daemon PID disappears. On Linux, a kernel
 * parent-death signal also covers abrupt death of the watchdog itself.
 */
export function startOxigraphParentWatchdog(
  opts: OxigraphParentWatchdogOptions,
): OxigraphParentWatchdogHandle {
  if (!Number.isInteger(opts.parentPid) || opts.parentPid <= 0) {
    throw new Error('Oxigraph parent watchdog requires a positive parent PID');
  }
  if (!opts.command) throw new Error('Oxigraph parent watchdog requires a command');

  const spawnChild = opts.spawnChild ?? spawn;
  const isProcessAlive = opts.isProcessAlive ?? processIsAlive;
  const readOomSnapshot = opts.readOomSnapshot ?? readCgroupOomSnapshot;
  const readOomKill = opts.readOomKill ?? readCgroupOomKill;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const stopGraceMs = opts.stopGraceMs ?? 5_000;
  if (!Number.isInteger(stopGraceMs) || stopGraceMs <= 0) {
    throw new Error('Oxigraph watchdog stop grace must be a positive integer');
  }
  // setpriv execs the command with PR_SET_PDEATHSIG installed. The shell
  // checks PPID AFTER installing it, closing the fork/prctl race: if this
  // watchdog died before setpriv ran, do not start an orphan database.
  // All variable values are positional arguments, never shell source.
  // Fail closed if util-linux setpriv is unavailable; do not launch an
  // unprotected store in a sibling systemd scope.
  const launch = buildOxigraphWatchdogLaunchPlan(
    process.platform,
    process.pid,
    opts.command,
    opts.args,
  );
  const child = spawnChild(launch.command, [...launch.args], { stdio: 'inherit' });
  // The watchdog already runs inside the transient scope, so it can retain a
  // valid baseline and re-read memory.events while the scope still contains
  // this process. The parent supervisor cannot reliably do that after exit:
  // systemd may remove the empty cgroup before its ChildProcess callback runs.
  const oomSnapshot = readOomSnapshot(process.pid);
  let parentLost = false;
  let stopping = false;
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    if (stopping || settled) return;
    stopping = true;
    child.kill(signal);
    if (signal !== 'SIGKILL') {
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, stopGraceMs);
      killTimer.unref?.();
    }
  };

  const timer = setInterval(() => {
    if (stopping || isProcessAlive(opts.parentPid)) return;
    parentLost = true;
    stop();
  }, pollIntervalMs);
  timer.unref?.();

  const result = new Promise<OxigraphParentWatchdogResult>((resolveResult, reject) => {
    const cleanup = (): void => {
      settled = true;
      clearInterval(timer);
      clearTimeout(killTimer);
    };
    child.once('error', (error) => {
      cleanup();
      reject(new Error(
        `Could not start protected Oxigraph child${launch.protectedByParentDeathSignal
          ? ' (requires util-linux setpriv)'
          : ''}: ${error.message}`,
        { cause: error },
      ));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      const sigkillCompatibleExit = signal === 'SIGKILL' || code === 137;
      const oomKillNow = oomSnapshot ? readOomKill(oomSnapshot.dir) : null;
      const oomKilled = sigkillCompatibleExit
        && typeof oomKillNow === 'number'
        && oomKillNow > oomSnapshot!.oomKill;
      resolveResult({ code, signal, parentLost, oomKilled });
    });
  });

  return {
    child,
    result,
    stop,
  };
}

export function parseOxigraphParentWatchdogArgs(argv: readonly string[]): {
  parentPid: number;
  command: string;
  args: string[];
} {
  const [rawParentPid, command, ...args] = argv;
  const parentPid = Number(rawParentPid);
  if (!Number.isInteger(parentPid) || parentPid <= 0 || !command) {
    throw new Error('Usage: oxigraph-parent-watchdog <parent-pid> <command> [args...]');
  }
  return { parentPid, command, args };
}

export function conventionalSignalExitCode(signal: NodeJS.Signals): number {
  const signalNumber = osConstants.signals[signal];
  return 128 + (typeof signalNumber === 'number' ? signalNumber : 1);
}

async function main(): Promise<void> {
  const parsed = parseOxigraphParentWatchdogArgs(process.argv.slice(2));
  const handle = startOxigraphParentWatchdog(parsed);
  let forwardedSignal: NodeJS.Signals | null = null;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      forwardedSignal = signal;
      handle.stop(signal);
    });
  }

  const result = await handle.result;
  if (result.oomKilled) {
    process.stderr.write(`${OXIGRAPH_WATCHDOG_OOM_MARKER}\n`);
    process.exitCode = 200;
    return;
  }
  if (forwardedSignal || result.parentLost) {
    process.exitCode = 0;
    return;
  }
  if (result.signal) {
    // Re-raising SIGTERM/SIGINT/SIGHUP would hit the forwarding listeners
    // installed above and could turn an unexpected child death into exit 0.
    // Preserve signal semantics explicitly without re-entering those handlers.
    process.exitCode = conventionalSignalExitCode(result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`[oxigraph-watchdog] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
