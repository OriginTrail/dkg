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

export interface OxigraphLaunchStrategy {
  readonly mode: 'direct' | 'systemd-scope';
  /**
   * Spawn Oxigraph through `spawnProcess` with the options `terminate`
   * relies on: the direct watchdog leads its own process group, so the
   * daemon's signals reach the watchdog and Oxigraph together.
   */
  launch(
    spawnProcess: typeof spawn,
    binaryPath: string,
    binaryArgs: string[],
    stdio: StdioOptions,
  ): ChildProcess;
  resolveListenerPid(
    child: ChildProcess,
    port: number,
    host: string,
    resolver: ListenOwnerResolver,
  ): Promise<number | null>;
  observeStderr(child: ChildProcess, text: string): void;
  classifyOomExit(input: {
    child: ChildProcess;
    code: number | null;
    signal: NodeJS.Signals | null;
    snapshot?: CgroupOomSnapshot;
    readOomKill: (dir: string) => number | null;
  }): boolean;
  logSummary(): string | null;
  /**
   * Signal a child that `launch` returned, and whatever it launched. Call it
   * only while the child has not exited, so a process-group id cannot have
   * been reused. Any other child is signalled alone.
   */
  terminate(child: ChildProcess, signal: NodeJS.Signals): void;
}

function cgroupEvidenceIncremented(
  input: Parameters<OxigraphLaunchStrategy['classifyOomExit']>[0],
): boolean {
  const sigkillCompatibleExit = input.signal === 'SIGKILL' || input.code === 137;
  if (!sigkillCompatibleExit || !input.snapshot) return false;
  const oomKillNow = input.readOomKill(input.snapshot.dir);
  return typeof oomKillNow === 'number' && oomKillNow > input.snapshot.oomKill;
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  child.kill(signal);
}

// One owner for spawning and signalling. With `processGroup`, each child is
// spawned leading its own process group and remembered, and `terminate`
// signals that group: it reaches Oxigraph even when the wrapper cannot
// forward the signal, as with SIGKILL sent to the watchdog alone.
function launcher(
  build: (binaryPath: string, binaryArgs: string[]) => OxigraphLaunchCommand,
  processGroup: boolean,
): Pick<OxigraphLaunchStrategy, 'launch' | 'terminate'> {
  const groupLeaders = new WeakSet<ChildProcess>();
  return {
    launch(spawnProcess, binaryPath, binaryArgs, stdio) {
      const { command, args, environment } = build(binaryPath, binaryArgs);
      const child = spawnProcess(command, args, {
        stdio,
        ...(processGroup ? { detached: true } : {}),
        ...(environment ? { env: { ...process.env, ...environment } } : {}),
      });
      if (processGroup) groupLeaders.add(child);
      return child;
    },
    terminate(child, signal) {
      if (groupLeaders.has(child) && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the wrapper alone.
        }
      }
      signalChild(child, signal);
    },
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
  const direct = {
    mode: 'direct',
    observeStderr: () => {},
    classifyOomExit: cgroupEvidenceIncremented,
    logSummary: () => null,
  } as const;
  // Windows resolves listener ownership for the direct child only (netstat
  // has no process tree), so it keeps launching the binary itself.
  if (!opts.memoryLimits && opts.platform === 'win32') {
    return {
      ...direct,
      ...launcher((binaryPath, binaryArgs) => ({ command: binaryPath, args: binaryArgs }), false),
      resolveListenerPid: (child, port, host, resolver) => resolver(child, port, host, 'child-only'),
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
      ...direct,
      ...launcher((binaryPath, binaryArgs) => ({
        command: nodeExecutable,
        args: [
          ...watchdogNodeArgs,
          OXIGRAPH_WATCHDOG_DIRECT_FLAG, String(opts.parentPid),
          binaryPath, ...binaryArgs,
        ],
      }), true),
      resolveListenerPid: (child, port, host, resolver) => resolver(child, port, host, 'process-tree'),
    };
  }

  const limits = normalizeOxigraphMemoryLimits(opts.memoryLimits)!;
  const supportError = oxigraphMemorySupportError(limits, opts.platform);
  if (supportError) throw new Error(supportError);
  if (!Number.isInteger(opts.uid) || opts.uid < 0) {
    throw new Error('Managed Oxigraph memory limits require a numeric service user id');
  }
  const runtimeDir = `/run/user/${opts.uid}`;
  const watchdogOomChildren = new WeakSet<ChildProcess>();
  let generation = 0;

  return {
    mode: 'systemd-scope',
    // `systemd-run --scope` execs the watchdog in place, and setpriv's
    // parent-death signal stops Oxigraph with it. The launch still leads its
    // own process group, so a signal reaches every process it started
    // without depending on either.
    ...launcher((binaryPath, binaryArgs) => {
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
    }, true),
    resolveListenerPid: (child, port, host, resolver) => resolver(child, port, host, 'process-tree'),
    observeStderr(child, text) {
      if (text.includes(OXIGRAPH_WATCHDOG_OOM_MARKER)) watchdogOomChildren.add(child);
    },
    classifyOomExit(input) {
      return watchdogOomChildren.has(input.child) || cgroupEvidenceIncremented(input);
    },
    logSummary: () =>
      `Starting Oxigraph in an isolated systemd user scope ` +
      `(MemoryHigh=${limits.highMiB ?? 'unset'}MiB, MemoryMax=${limits.maxMiB}MiB).`,
  };
}
