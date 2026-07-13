import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
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
  /** `/proc/<pid>/stat` start-time identity captured by the daemon worker. */
  parentIdentity?: string;
  command: string;
  args: readonly string[];
  pollIntervalMs?: number;
  stopGraceMs?: number;
  spawnChild?: typeof spawn;
  isProcessAlive?: (pid: number) => boolean;
  readProcessIdentity?: (pid: number) => string | null;
  /** Windows fallback: inherited fd stream whose EOF means the worker died. */
  parentPipe?: NodeJS.ReadableStream;
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
 * Return a PID-reuse-safe Linux process identity.
 *
 * `/proc/<pid>/stat` field 22 is the process start time in clock ticks since
 * boot. Pairing it with the PID distinguishes the original daemon from a later
 * process that happens to reuse the same numeric PID.
 */
export function readLinuxProcessIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commEnd = stat.lastIndexOf(')');
    if (commEnd < 0) return null;
    // Text after `) ` starts at field 3 (`state`). Field 22 (`starttime`) is
    // therefore zero-based index 19 in this suffix.
    const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime && /^\d+$/.test(startTime) ? `${pid}:${startTime}` : null;
  } catch {
    return null;
  }
}

/**
 * Keep Oxigraph tied to the DKG daemon when it cannot share the worker's POSIX
 * process group (a sibling systemd cgroup or Windows). The typed watchdog
 * forwards shutdown signals and terminates Oxigraph when the original daemon
 * identity disappears or its inherited parent pipe reaches EOF.
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
  const readProcessIdentity = opts.readProcessIdentity ?? readLinuxProcessIdentity;
  const readOomSnapshot = opts.readOomSnapshot ?? readCgroupOomSnapshot;
  const readOomKill = opts.readOomKill ?? readCgroupOomKill;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const stopGraceMs = opts.stopGraceMs ?? 5_000;
  const expectedParentIdentity = opts.parentIdentity;
  const usesParentPipe = opts.parentPipe !== undefined;
  const parentMatches = (): boolean => {
    if (usesParentPipe) return true;
    if (expectedParentIdentity === undefined) return isProcessAlive(opts.parentPid);
    return readProcessIdentity(opts.parentPid) === expectedParentIdentity;
  };

  // Do not create an Oxigraph child when the daemon vanished (or its PID was
  // reused) before systemd got around to launching this watchdog.
  if (!parentMatches()) {
    throw new Error(
      `Oxigraph parent ${opts.parentPid} disappeared or changed identity before child spawn`,
    );
  }

  const child = spawnChild(opts.command, [...opts.args], { stdio: 'inherit' });
  // The watchdog already runs inside the transient scope, so it can retain a
  // valid baseline and re-read memory.events while the scope still contains
  // this process. The parent supervisor cannot reliably do that after exit:
  // systemd may remove the empty cgroup before its ChildProcess callback runs.
  const oomSnapshot = readOomSnapshot(process.pid);
  let parentLost = false;
  let stopping = false;
  let escalationTimer: NodeJS.Timeout | null = null;

  const childAlive = (): boolean =>
    child.exitCode === null && child.signalCode === null;

  const beginStop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    if (childAlive()) child.kill(signal);
    if (signal === 'SIGKILL' || !childAlive()) return;
    escalationTimer = setTimeout(() => {
      if (childAlive()) child.kill('SIGKILL');
    }, stopGraceMs);
    escalationTimer.unref?.();
  };

  const timer = usesParentPipe
    ? null
    : setInterval(() => {
        if (stopping || parentMatches()) return;
        parentLost = true;
        beginStop('SIGTERM');
      }, pollIntervalMs);
  timer?.unref?.();

  const onParentPipeClosed = (): void => {
    if (parentLost) return;
    parentLost = true;
    beginStop('SIGTERM');
  };
  const detachParentPipe = (): void => {
    opts.parentPipe?.removeListener('end', onParentPipeClosed);
    opts.parentPipe?.removeListener('close', onParentPipeClosed);
    opts.parentPipe?.removeListener('error', onParentPipeClosed);
    (opts.parentPipe as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined)
      ?.destroy?.();
  };

  const result = new Promise<OxigraphParentWatchdogResult>((resolveResult, reject) => {
    child.once('error', (error) => {
      if (timer) clearInterval(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      detachParentPipe();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (timer) clearInterval(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      detachParentPipe();
      const sigkillCompatibleExit = signal === 'SIGKILL' || code === 137;
      const oomKillNow = oomSnapshot ? readOomKill(oomSnapshot.dir) : null;
      const oomKilled = sigkillCompatibleExit
        && typeof oomKillNow === 'number'
        && oomKillNow > oomSnapshot!.oomKill;
      resolveResult({ code, signal, parentLost, oomKilled });
    });
  });

  if (opts.parentPipe) {
    opts.parentPipe.once('end', onParentPipeClosed);
    opts.parentPipe.once('close', onParentPipeClosed);
    opts.parentPipe.once('error', onParentPipeClosed);
    opts.parentPipe.resume();
    if ((opts.parentPipe as NodeJS.ReadableStream & { readableEnded?: boolean }).readableEnded) {
      onParentPipeClosed();
    }
  }

  // Close the spawn race: the parent may die after the pre-spawn identity
  // check but before the child exists. Re-check only after exit/error handlers
  // are attached, then begin the same bounded cleanup path.
  if (!parentMatches()) {
    parentLost = true;
    beginStop('SIGTERM');
  }

  return {
    child,
    result,
    stop(signal: NodeJS.Signals = 'SIGTERM') {
      beginStop(signal);
    },
  };
}

export function parseOxigraphParentWatchdogArgs(argv: readonly string[]): {
  parentPid: number;
  parentIdentity: string;
  command: string;
  args: string[];
} {
  const [rawParentPid, parentIdentity, command, ...args] = argv;
  const parentPid = Number(rawParentPid);
  if (!Number.isInteger(parentPid) || parentPid <= 0 || !parentIdentity || !command) {
    throw new Error(
      'Usage: oxigraph-parent-watchdog <parent-pid> <parent-identity> <command> [args...]',
    );
  }
  return { parentPid, parentIdentity, command, args };
}

export function conventionalSignalExitCode(signal: NodeJS.Signals): number {
  const signalNumber = osConstants.signals[signal];
  return 128 + (typeof signalNumber === 'number' ? signalNumber : 1);
}

async function main(): Promise<void> {
  const parsed = parseOxigraphParentWatchdogArgs(process.argv.slice(2));
  const pipeMatch = /^pipe:(\d+)$/.exec(parsed.parentIdentity);
  const parentPipe = pipeMatch
    ? createReadStream('', { fd: Number(pipeMatch[1]), autoClose: false })
    : undefined;
  const handle = startOxigraphParentWatchdog({ ...parsed, parentPipe });
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
