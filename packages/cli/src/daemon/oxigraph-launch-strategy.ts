import { spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CgroupOomSnapshot } from './oxigraph-memory.js';
import {
  OXIGRAPH_WATCHDOG_OOM_MARKER,
  readLinuxProcessIdentity,
} from './oxigraph-parent-watchdog.js';

export interface OxigraphMemoryLimits {
  highMiB?: number;
  maxMiB: number;
}

export interface OxigraphSpawnSpec {
  command: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

export type ListenOwnerResolver = (
  child: ChildProcess,
  port: number,
  host: string,
  ownership?: 'child-only' | 'process-tree',
) => Promise<number | null>;

export interface OxigraphLaunchStrategy {
  readonly mode: 'direct' | 'parent-watchdog' | 'systemd-scope';
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
  /** Ask the owned wrapper/server to stop without orphaning descendants. */
  requestStop(child: ChildProcess): boolean;
  /** Last-resort bounded cleanup after the graceful window expires. */
  forceStop(child: ChildProcess): boolean;
  logSummary(): string | null;
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function closeParentPipe(child: ChildProcess): boolean {
  const pipe = child.stdio?.[3] as
    | (NodeJS.WritableStream & { writableEnded?: boolean })
    | null
    | undefined;
  if (!pipe || typeof pipe.end !== 'function') return false;
  if (!pipe.writableEnded) pipe.end();
  return true;
}

function forceKillWindowsProcessTree(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = spawnSync(
    'taskkill.exe',
    ['/PID', String(pid), '/T', '/F'],
    { stdio: 'ignore', windowsHide: true },
  );
  return result.status === 0;
}

function cgroupEvidenceIncremented(
  input: Parameters<OxigraphLaunchStrategy['classifyOomExit']>[0],
): boolean {
  const sigkillCompatibleExit = input.signal === 'SIGKILL' || input.code === 137;
  if (!sigkillCompatibleExit || !input.snapshot) return false;
  const oomKillNow = input.readOomKill(input.snapshot.dir);
  return typeof oomKillNow === 'number' && oomKillNow > input.snapshot.oomKill;
}

export function normalizeOxigraphMemoryLimits(input: {
  highMiB?: unknown;
  maxMiB?: unknown;
}): OxigraphMemoryLimits | undefined {
  if (input.highMiB === undefined && input.maxMiB === undefined) return undefined;
  if (typeof input.maxMiB !== 'number' || !Number.isInteger(input.maxMiB) || input.maxMiB <= 0) {
    throw new Error('Managed Oxigraph memoryMaxMiB must be a positive integer');
  }
  if (
    input.highMiB !== undefined &&
    (typeof input.highMiB !== 'number' || !Number.isInteger(input.highMiB) || input.highMiB <= 0 || input.highMiB > input.maxMiB)
  ) {
    throw new Error('Managed Oxigraph memoryHighMiB must be a positive integer no greater than memoryMaxMiB');
  }
  return {
    maxMiB: input.maxMiB,
    ...(typeof input.highMiB === 'number' ? { highMiB: input.highMiB } : {}),
  };
}

export function createOxigraphLaunchStrategy(opts: {
  memoryLimits?: OxigraphMemoryLimits;
  platform: NodeJS.Platform;
  parentPid: number;
  uid: number;
  nodeExecutable?: string;
  watchdogPath?: string;
  parentIdentity?: string;
  stopGraceMs?: number;
}): OxigraphLaunchStrategy {
  if (!opts.memoryLimits) {
    if (opts.platform === 'win32') {
      const watchdogPath = opts.watchdogPath ?? fileURLToPath(
        new URL('./oxigraph-parent-watchdog.js', import.meta.url),
      );
      const nodeExecutable = opts.nodeExecutable ?? process.execPath;
      return {
        mode: 'parent-watchdog',
        nextSpawnSpec: (binaryPath, binaryArgs) => ({
          command: nodeExecutable,
          args: [
            watchdogPath,
            'pipe',
            String(opts.parentPid),
            // fd 3 is an inherited parent-owned pipe. EOF is authoritative
            // worker death and is immune to PID reuse.
            '3',
            binaryPath,
            ...binaryArgs,
          ],
          environment: {
            DKG_OXIGRAPH_WATCHDOG_STOP_GRACE_MS: String(opts.stopGraceMs ?? 5_000),
          },
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        }),
        resolveListenerPid: (child, port, host, resolver) =>
          resolver(child, port, host, 'process-tree'),
        observeStderr: () => {},
        classifyOomExit: cgroupEvidenceIncremented,
        requestStop: closeParentPipe,
        forceStop: (child) =>
          forceKillWindowsProcessTree(child.pid ?? -1) || signalChild(child, 'SIGKILL'),
        logSummary: () =>
          'Starting Oxigraph behind a parent-pipe watchdog (Windows kill-on-parent-exit fallback).',
      };
    }
    return {
      mode: 'direct',
      nextSpawnSpec: (binaryPath, binaryArgs) => ({ command: binaryPath, args: binaryArgs }),
      resolveListenerPid: (child, port, host, resolver) => resolver(child, port, host, 'child-only'),
      observeStderr: () => {},
      classifyOomExit: cgroupEvidenceIncremented,
      requestStop: (child) => signalChild(child, 'SIGTERM'),
      forceStop: (child) => signalChild(child, 'SIGKILL'),
      logSummary: () => null,
    };
  }

  const limits = normalizeOxigraphMemoryLimits(opts.memoryLimits)!;
  if (opts.platform !== 'linux') {
    throw new Error('Managed Oxigraph memory limits require Linux with a running systemd user manager');
  }
  if (!Number.isInteger(opts.uid) || opts.uid < 0) {
    throw new Error('Managed Oxigraph memory limits require a numeric service user id');
  }
  const runtimeDir = `/run/user/${opts.uid}`;
  const watchdogPath = opts.watchdogPath ?? fileURLToPath(new URL('./oxigraph-parent-watchdog.js', import.meta.url));
  const nodeExecutable = opts.nodeExecutable ?? process.execPath;
  const parentIdentity = opts.parentIdentity ?? readLinuxProcessIdentity(opts.parentPid);
  if (!parentIdentity) {
    throw new Error(
      `Managed Oxigraph memory limits require a readable identity for daemon PID ${opts.parentPid}`,
    );
  }
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
          '--', nodeExecutable, watchdogPath,
          'process-identity', String(opts.parentPid), parentIdentity,
          binaryPath, ...binaryArgs,
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
    requestStop: (child) => signalChild(child, 'SIGTERM'),
    forceStop: (child) => signalChild(child, 'SIGKILL'),
    logSummary: () =>
      `Starting Oxigraph in an isolated systemd user scope ` +
      `(MemoryHigh=${limits.highMiB ?? 'unset'}MiB, MemoryMax=${limits.maxMiB}MiB).`,
  };
}
