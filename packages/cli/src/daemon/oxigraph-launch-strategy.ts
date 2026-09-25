import { normalizeOxigraphMemoryLimits, oxigraphMemorySupportError, type OxigraphMemoryLimits } from '../oxigraph-memory-limits.js';
import type { ChildProcess, spawn, StdioOptions } from 'node:child_process';
import { resolveHelperModuleNodeArgs } from '../own-module-path.js';
import type { CgroupOomSnapshot } from './oxigraph-memory.js';
import {
  OXIGRAPH_WATCHDOG_DIRECT_FLAG,
  OXIGRAPH_WATCHDOG_OOM_MARKER,
} from './oxigraph-parent-watchdog.js';

export { normalizeOxigraphMemoryLimits, type OxigraphMemoryLimits } from '../oxigraph-memory-limits.js';

/** What one launch runs, before `launch` adds the spawn options it relies on. */
interface OxigraphLaunchCommand {
  command: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
}

export type ListenOwnerResolver = (
  child: ChildProcess,
  port: number,
  host: string,
  ownership?: 'child-only' | 'process-tree',
) => Promise<number | null>;

/**
 * One Oxigraph launch: its child process, and everything that depends on how
 * it was launched. Termination, listener ownership and OOM attribution are
 * captured per launch, so they cannot be applied with another launch's
 * semantics.
 */
export interface OxigraphLaunchHandle {
  readonly child: ChildProcess;
  /** Whether the child still runs: not exited, and never failed to spawn. */
  alive(): boolean;
  /**
   * Signal the child and whatever it launched: its whole process group where
   * the launch leads one. Does nothing once the child has exited, so a
   * process-group id is never signalled after it could have been reused.
   */
  terminate(signal: NodeJS.Signals): void;
  /** The PID that owns the listen socket, checked as this launch mode allows. */
  resolveListenerPid(port: number, host: string, resolver: ListenOwnerResolver): Promise<number | null>;
  /** Note one line of stderr: the scoped watchdog reports an OOM kill there. */
  observeStderr(text: string): void;
  /** Take the listener's cgroup OOM counter once, as evidence for `classifyOomExit`. */
  captureOomSnapshot(listenerPid: number, read: (pid: number) => CgroupOomSnapshot | null): void;
  /** Whether the child's exit was an OOM kill. */
  classifyOomExit(exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    readOomKill: (dir: string) => number | null;
  }): boolean;
}

export interface OxigraphLaunchStrategy {
  readonly mode: 'direct' | 'systemd-scope';
  /** Spawn Oxigraph through `spawnProcess` and return that launch's handle. */
  launch(
    spawnProcess: typeof spawn,
    binaryPath: string,
    binaryArgs: string[],
    stdio: StdioOptions,
  ): OxigraphLaunchHandle;
  logSummary(): string | null;
}

interface LaunchMode {
  build(binaryPath: string, binaryArgs: string[]): OxigraphLaunchCommand;
  /**
   * Lead a new process group, which `terminate` signals: it reaches Oxigraph
   * even when the wrapper cannot forward the signal, as with SIGKILL.
   */
  processGroup: boolean;
  listenerOwnership: 'child-only' | 'process-tree';
  /** The scoped watchdog prints OXIGRAPH_WATCHDOG_OOM_MARKER on an OOM kill. */
  watchdogReportsOom: boolean;
}

function launcher(mode: LaunchMode): OxigraphLaunchStrategy['launch'] {
  return (spawnProcess, binaryPath, binaryArgs, stdio) => {
    const { command, args, environment } = mode.build(binaryPath, binaryArgs);
    const child = spawnProcess(command, args, {
      stdio,
      ...(mode.processGroup ? { detached: true } : {}),
      ...(environment ? { env: { ...process.env, ...environment } } : {}),
    });
    // An `error` event means the process never ran (ENOENT, EACCES) or could
    // not be signalled, so `exitCode`/`signalCode` alone would call it alive.
    let failed = false;
    child.on('error', () => { failed = true; });
    let watchdogSawOom = false;
    let oomSnapshot: CgroupOomSnapshot | undefined;
    const alive = (): boolean => !failed && child.exitCode === null && child.signalCode === null;
    return {
      child,
      alive,
      terminate(signal) {
        if (!alive()) return;
        if (mode.processGroup && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back to the wrapper alone.
          }
        }
        child.kill(signal);
      },
      resolveListenerPid: (port, host, resolver) => resolver(child, port, host, mode.listenerOwnership),
      observeStderr(text) {
        if (mode.watchdogReportsOom && text.includes(OXIGRAPH_WATCHDOG_OOM_MARKER)) watchdogSawOom = true;
      },
      captureOomSnapshot(listenerPid, read) {
        oomSnapshot ??= read(listenerPid) ?? undefined;
      },
      // `oom_kill` is cgroup-scoped, not per-PID, so an increment is only
      // supporting evidence for a SIGKILL-compatible exit.
      classifyOomExit({ code, signal, readOomKill }) {
        if (watchdogSawOom) return true;
        const sigkillCompatibleExit = signal === 'SIGKILL' || code === 137;
        if (!sigkillCompatibleExit || !oomSnapshot) return false;
        const oomKillNow = readOomKill(oomSnapshot.dir);
        return typeof oomKillNow === 'number' && oomKillNow > oomSnapshot.oomKill;
      },
    };
  };
}

export function createOxigraphLaunchStrategy(opts: {
  memoryLimits?: OxigraphMemoryLimits;
  platform: NodeJS.Platform;
  parentPid: number;
  uid: number;
  nodeExecutable?: string;
  watchdogPath?: string;
}): OxigraphLaunchStrategy {
  // Windows resolves listener ownership for the direct child only (netstat
  // has no process tree), so it keeps launching the binary itself.
  if (!opts.memoryLimits && opts.platform === 'win32') {
    return {
      mode: 'direct',
      launch: launcher({
        build: (binaryPath, binaryArgs) => ({ command: binaryPath, args: binaryArgs }),
        processGroup: false,
        listenerOwnership: 'child-only',
        watchdogReportsOom: false,
      }),
      logSummary: () => null,
    };
  }

  const nodeExecutable = opts.nodeExecutable ?? process.execPath;
  const watchdogNodeArgs = opts.watchdogPath === undefined
    ? resolveHelperModuleNodeArgs(new URL('./oxigraph-parent-watchdog.js', import.meta.url))
    : [opts.watchdogPath];

  if (!opts.memoryLimits) {
    // A worker SIGKILLed by the supervisor's liveness watchdog cannot stop
    // its children. Without the parent watchdog, Oxigraph would be reparented
    // to init and keep `<location>/LOCK`, and every respawned worker would
    // fail to open the store.
    return {
      mode: 'direct',
      launch: launcher({
        build: (binaryPath, binaryArgs) => ({
          command: nodeExecutable,
          args: [
            ...watchdogNodeArgs,
            OXIGRAPH_WATCHDOG_DIRECT_FLAG, String(opts.parentPid),
            binaryPath, ...binaryArgs,
          ],
        }),
        processGroup: true,
        listenerOwnership: 'process-tree',
        // A direct watchdog passes an OOM SIGKILL on as exit 137, which the
        // cgroup evidence classifies.
        watchdogReportsOom: false,
      }),
      logSummary: () => null,
    };
  }

  const limits = normalizeOxigraphMemoryLimits(opts.memoryLimits)!;
  const supportError = oxigraphMemorySupportError(limits, opts.platform);
  if (supportError) throw new Error(supportError);
  if (!Number.isInteger(opts.uid) || opts.uid < 0) {
    throw new Error('Managed Oxigraph memory limits require a numeric service user id');
  }
  const runtimeDir = `/run/user/${opts.uid}`;
  let generation = 0;

  return {
    mode: 'systemd-scope',
    // `systemd-run --scope` execs the watchdog in place, and setpriv's
    // parent-death signal stops Oxigraph with it. The launch still leads its
    // own process group, so a signal reaches every process it started
    // without depending on either.
    launch: launcher({
      build: (binaryPath, binaryArgs) => {
        generation += 1;
        const unit = `dkg-oxigraph-${opts.parentPid}-${generation}`;
        return {
          command: 'systemd-run',
          args: [
            '--user', '--scope', '--collect', '--quiet',
            `--unit=${unit}`,
            ...(limits.highMiB === undefined ? [] : [`--property=MemoryHigh=${limits.highMiB}M`]),
            `--property=MemoryMax=${limits.maxMiB}M`,
            '--property=MemorySwapMax=0',
            '--', nodeExecutable, ...watchdogNodeArgs, String(opts.parentPid), binaryPath, ...binaryArgs,
          ],
          environment: {
            XDG_RUNTIME_DIR: runtimeDir,
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
          },
        };
      },
      processGroup: true,
      listenerOwnership: 'process-tree',
      watchdogReportsOom: true,
    }),
    logSummary: () =>
      `Starting Oxigraph in an isolated systemd user scope ` +
      `(MemoryHigh=${limits.highMiB ?? 'unset'}MiB, MemoryMax=${limits.maxMiB}MiB).`,
  };
}
