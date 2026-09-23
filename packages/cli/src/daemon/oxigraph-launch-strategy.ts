import { normalizeOxigraphMemoryLimits, oxigraphMemorySupportError, type OxigraphMemoryLimits } from '../oxigraph-memory-limits.js';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CgroupOomSnapshot } from './oxigraph-memory.js';
import {
  OXIGRAPH_WATCHDOG_DIRECT_FLAG,
  OXIGRAPH_WATCHDOG_OOM_MARKER,
} from './oxigraph-parent-watchdog.js';

export { normalizeOxigraphMemoryLimits, type OxigraphMemoryLimits } from '../oxigraph-memory-limits.js';

export interface OxigraphSpawnSpec {
  command: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
  /**
   * Lead a new process group, so the daemon's own signals reach the wrapper
   * and Oxigraph together. A SIGKILL sent to the wrapper alone cannot be
   * forwarded and would leave Oxigraph running.
   */
  processGroup?: boolean;
}

export type ListenOwnerResolver = (
  child: ChildProcess,
  port: number,
  host: string,
  ownership?: 'child-only' | 'process-tree',
) => Promise<number | null>;

export interface OxigraphLaunchStrategy {
  readonly mode: 'direct' | 'systemd-scope';
  nextSpawnSpec(binaryPath: string, binaryArgs: string[]): OxigraphSpawnSpec;
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
}

function cgroupEvidenceIncremented(
  input: Parameters<OxigraphLaunchStrategy['classifyOomExit']>[0],
): boolean {
  const sigkillCompatibleExit = input.signal === 'SIGKILL' || input.code === 137;
  if (!sigkillCompatibleExit || !input.snapshot) return false;
  const oomKillNow = input.readOomKill(input.snapshot.dir);
  return typeof oomKillNow === 'number' && oomKillNow > input.snapshot.oomKill;
}

/**
 * Node arguments that run the parent watchdog. A built install ships
 * `oxigraph-parent-watchdog.js` beside this module; a source checkout
 * (tsx, tests) only has the `.ts` file, which Node runs through tsx.
 */
function defaultWatchdogNodeArgs(): string[] {
  const built = fileURLToPath(new URL('./oxigraph-parent-watchdog.js', import.meta.url));
  if (existsSync(built)) return [built];
  const source = fileURLToPath(new URL('./oxigraph-parent-watchdog.ts', import.meta.url));
  if (existsSync(source)) return ['--import', import.meta.resolve('tsx'), source];
  return [built];
}

export function createOxigraphLaunchStrategy(opts: {
  memoryLimits?: OxigraphMemoryLimits;
  platform: NodeJS.Platform;
  parentPid: number;
  uid: number;
  nodeExecutable?: string;
  watchdogPath?: string;
}): OxigraphLaunchStrategy {
  const nodeExecutable = opts.nodeExecutable ?? process.execPath;
  const watchdogNodeArgs = (): string[] =>
    opts.watchdogPath === undefined ? defaultWatchdogNodeArgs() : [opts.watchdogPath];

  if (!opts.memoryLimits) {
    // Windows resolves listener ownership for the direct child only (netstat
    // has no process tree), so it keeps launching the binary itself.
    if (opts.platform === 'win32') {
      return {
        mode: 'direct',
        nextSpawnSpec: (binaryPath, binaryArgs) => ({ command: binaryPath, args: binaryArgs }),
        resolveListenerPid: (child, port, host, resolver) => resolver(child, port, host, 'child-only'),
        observeStderr: () => {},
        classifyOomExit: cgroupEvidenceIncremented,
        logSummary: () => null,
      };
    }
    // A worker SIGKILLed by the supervisor's liveness watchdog cannot stop
    // its children. Without the parent watchdog, Oxigraph would be reparented
    // to init and keep `<location>/LOCK`, and every respawned worker would
    // fail to open the store.
    return {
      mode: 'direct',
      nextSpawnSpec: (binaryPath, binaryArgs) => ({
        command: nodeExecutable,
        args: [
          ...watchdogNodeArgs(),
          OXIGRAPH_WATCHDOG_DIRECT_FLAG, String(opts.parentPid),
          binaryPath, ...binaryArgs,
        ],
        processGroup: true,
      }),
      resolveListenerPid: (child, port, host, resolver) => resolver(child, port, host, 'process-tree'),
      observeStderr: () => {},
      classifyOomExit: cgroupEvidenceIncremented,
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
  const watchdogOomChildren = new WeakSet<ChildProcess>();
  let generation = 0;

  return {
    mode: 'systemd-scope',
    nextSpawnSpec(binaryPath, binaryArgs) {
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
          '--', nodeExecutable, ...watchdogNodeArgs(), String(opts.parentPid), binaryPath, ...binaryArgs,
        ],
        environment: {
          XDG_RUNTIME_DIR: runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
        },
      };
    },
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
