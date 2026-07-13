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
 * Oxigraph within one poll interval if the original daemon PID disappears.
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
  const child = spawnChild(opts.command, [...opts.args], { stdio: 'inherit' });
  // The watchdog already runs inside the transient scope, so it can retain a
  // valid baseline and re-read memory.events while the scope still contains
  // this process. The parent supervisor cannot reliably do that after exit:
  // systemd may remove the empty cgroup before its ChildProcess callback runs.
  const oomSnapshot = readOomSnapshot(process.pid);
  let parentLost = false;
  let stopping = false;

  const timer = setInterval(() => {
    if (stopping || isProcessAlive(opts.parentPid)) return;
    parentLost = true;
    stopping = true;
    child.kill('SIGTERM');
  }, pollIntervalMs);
  timer.unref?.();

  const result = new Promise<OxigraphParentWatchdogResult>((resolveResult, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearInterval(timer);
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
    stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (stopping) return;
      stopping = true;
      child.kill(signal);
    },
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
