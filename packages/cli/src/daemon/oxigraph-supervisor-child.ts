import type { ChildProcess } from 'node:child_process';
import type { OxigraphLaunchStrategy } from './oxigraph-launch-strategy.js';
import type { CgroupOomSnapshot } from './oxigraph-memory.js';
import type { OxigraphServerIo } from './oxigraph-server-contract.js';
import { boundedOxigraphPhaseDelayMsV1 } from './oxigraph-supervisor-lifecycle.js';

interface OxigraphSupervisorChildOptionsV1 {
  binaryPath: string;
  location: string;
  bind: string;
  queryTimeoutS?: number;
  stopGraceMs: number;
  io: Pick<
    OxigraphServerIo,
    'spawn' | 'readCgroupOomSnapshot' | 'readCgroupOomKill'
  >;
  launchStrategy: OxigraphLaunchStrategy;
  log: (message: string) => void;
  maySpawn: () => boolean;
}

export type OxigraphSupervisorCurrentExitHandlerV1 = (
  child: ChildProcess,
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

/** Owns the one tracked child and all child-specific process evidence. */
export class OxigraphSupervisorChildV1 {
  readonly #options: OxigraphSupervisorChildOptionsV1;
  #current: ChildProcess | null = null;
  #lastStderr = '';
  readonly #errored = new WeakSet<ChildProcess>();
  readonly #handoffRetiring = new WeakSet<ChildProcess>();
  readonly #oomSnapshots = new WeakMap<ChildProcess, CgroupOomSnapshot>();
  #onCurrentExit: OxigraphSupervisorCurrentExitHandlerV1 | null = null;

  constructor(options: OxigraphSupervisorChildOptionsV1) {
    this.#options = options;
  }

  current(): ChildProcess | null {
    return this.#current;
  }

  stderrTail(): string {
    return this.#lastStderr;
  }

  alive(): boolean {
    return this.#current !== null && this.#isAlive(this.#current);
  }

  registerCurrentExitHandler(handler: OxigraphSupervisorCurrentExitHandlerV1): void {
    if (this.#onCurrentExit !== null) {
      throw new Error('Managed Oxigraph child exit handler is already registered');
    }
    this.#onCurrentExit = handler;
  }

  spawn(): ChildProcess {
    if (!this.#options.maySpawn()) {
      throw new Error('Refusing to spawn a managed Oxigraph child after shutdown began');
    }
    const onCurrentExit = this.#onCurrentExit;
    if (onCurrentExit === null) {
      throw new Error('Refusing to spawn a managed Oxigraph child before exit routing is registered');
    }
    const args = [
      'serve',
      '--location',
      this.#options.location,
      '--bind',
      this.#options.bind,
    ];
    if (this.#options.queryTimeoutS !== undefined) {
      args.push('--timeout-s', String(this.#options.queryTimeoutS));
    }
    const spawnSpec = this.#options.launchStrategy.nextSpawnSpec(
      this.#options.binaryPath,
      args,
    );
    const child = this.#options.io.spawn(
      spawnSpec.command,
      spawnSpec.args,
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(spawnSpec.environment
          ? { env: { ...process.env, ...spawnSpec.environment } }
          : {}),
      },
    );
    this.#current = child;
    child.once('error', (error) => {
      this.#errored.add(child);
      this.#lastStderr = `${this.#lastStderr}spawn error: ${(error as Error).message}\n`
        .slice(-1_000);
      this.#options.log(`[oxigraph] failed to launch binary: ${(error as Error).message}`);
    });
    child.stderr?.on('data', (bytes) => {
      const line = bytes.toString('utf-8').trim();
      if (!line) return;
      this.#options.launchStrategy.observeStderr(child, line);
      this.#lastStderr = `${this.#lastStderr}${line}\n`.slice(-1_000);
      this.#options.log(`[oxigraph] ${line}`);
    });
    child.once('exit', (code, signal) => {
      if (child !== this.#current) return;
      onCurrentExit(child, code, signal);
    });
    return child;
  }

  captureOomSnapshot(child: ChildProcess, listenerPid: number): void {
    if (this.#oomSnapshots.has(child)) return;
    const snapshot = this.#options.io.readCgroupOomSnapshot(listenerPid);
    if (snapshot) this.#oomSnapshots.set(child, snapshot);
  }

  signal(signal: NodeJS.Signals): void {
    if (!this.alive()) return;
    try {
      this.#current!.kill(signal);
    } catch {
      // Best effort; the serialized supervisor still proves exit/release.
    }
  }

  markHandoffRetiring(child: ChildProcess): void {
    this.#handoffRetiring.add(child);
  }

  consumeHandoffRetiring(child: ChildProcess): boolean {
    return this.#handoffRetiring.delete(child);
  }

  classifyOomExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): boolean {
    return this.#options.launchStrategy.classifyOomExit({
      child,
      code,
      signal,
      snapshot: this.#oomSnapshots.get(child),
      readOomKill: this.#options.io.readCgroupOomKill,
    });
  }

  detach(child: ChildProcess): void {
    if (this.#current === child) this.#current = null;
  }

  async awaitExit(child: ChildProcess, absoluteDeadlineMs?: number): Promise<void> {
    const killDelayMs = boundedOxigraphPhaseDelayMsV1(
      this.#options.stopGraceMs,
      absoluteDeadlineMs,
    );
    const deadlineDelayMs = absoluteDeadlineMs === undefined
      ? undefined
      : boundedOxigraphPhaseDelayMsV1(Number.MAX_SAFE_INTEGER, absoluteDeadlineMs);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        resolve();
      };
      child.once('exit', done);
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.#options.log('[oxigraph] did not exit on SIGTERM; sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, killDelayMs);
      killTimer.unref?.();
      if (deadlineDelayMs !== undefined) {
        deadlineTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          child.removeListener('exit', done);
          try { child.kill('SIGKILL'); } catch { /* best effort */ }
          reject(new Error('Managed Oxigraph child did not exit before the recovery deadline'));
        }, deadlineDelayMs);
        deadlineTimer.unref?.();
      }
    });
  }

  #isAlive(child: ChildProcess): boolean {
    return !this.#errored.has(child) && child.exitCode === null && child.signalCode === null;
  }
}
