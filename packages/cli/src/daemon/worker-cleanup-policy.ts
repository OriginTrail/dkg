import { loadConfig } from '../config.js';
import {
  MANAGED_OXIGRAPH_BACKEND,
  resolveManagedOxigraphPort,
} from './oxigraph-managed.js';
import {
  reapWorkerProcessGroup,
  waitForTcpPortRelease,
  type WorkerProcessGroupCleanupResult,
} from './worker-process-group.js';

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface WorkerCleanupConfig {
  store?: {
    backend?: unknown;
    options?: Record<string, unknown>;
  };
}

export interface WorkerCleanupPolicyIo {
  loadConfig(): Promise<WorkerCleanupConfig>;
  reapWorkerProcessGroup(
    workerPid: number | undefined,
  ): Promise<WorkerProcessGroupCleanupResult>;
  waitForTcpPortRelease(host: string, port: number): Promise<boolean>;
  warn(message: string): void;
  now(): number;
}

export interface WorkerCleanupContext {
  label?: string;
  generation?: number;
}

const defaultIo: WorkerCleanupPolicyIo = {
  loadConfig,
  reapWorkerProcessGroup,
  waitForTcpPortRelease,
  warn: () => {},
  now: Date.now,
};

/**
 * Cleanup policy barrier between an exited daemon worker and its replacement.
 *
 * This module owns all knowledge of worker process groups and the managed
 * Oxigraph backend. The CLI supervisor consumes only the boolean barrier:
 * true permits a replacement worker, false fails closed.
 */
export async function cleanupDaemonWorker(
  workerPid: number | undefined,
  exit: WorkerExit,
  overrides: Partial<WorkerCleanupPolicyIo> = {},
  context: WorkerCleanupContext = {},
): Promise<boolean> {
  const io: WorkerCleanupPolicyIo = { ...defaultIo, ...overrides };
  const startedAt = io.now();
  let groupResult: WorkerProcessGroupCleanupResult | undefined;
  const finish = (succeeded: boolean): boolean => {
    const durationMs = Math.max(0, io.now() - startedAt);
    io.warn(
      `[supervisor] ${context.label ?? 'worker'} cleanup ` +
        `${succeeded ? 'completed' : 'failed'} ` +
        `(generation=${context.generation ?? 'unknown'}, pid=${workerPid ?? 'unknown'}, ` +
        `code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'null'}, ` +
        `durationMs=${durationMs}, sigterm=${groupResult?.termSent ?? 'unknown'}, ` +
        `sigkill=${groupResult?.killSent ?? 'unknown'}, ` +
        `groupEmpty=${groupResult?.empty ?? 'unknown'}).`,
    );
    return succeeded;
  };
  try {
    groupResult = await io.reapWorkerProcessGroup(workerPid);
    if (!groupResult.empty) {
      io.warn(
        `[supervisor] worker process group ${workerPid ?? 'unknown'} still has survivors ` +
          `after SIGTERM/SIGKILL; refusing to spawn a replacement.`,
      );
      return finish(false);
    }

    const config = await io.loadConfig();
    if (config.store?.backend === MANAGED_OXIGRAPH_BACKEND) {
      const managedPort = resolveManagedOxigraphPort(config.store.options);
      const released = await io.waitForTcpPortRelease('127.0.0.1', managedPort);
      if (!released) {
        io.warn(
          `[supervisor] managed Oxigraph port 127.0.0.1:${managedPort} is still listening ` +
            `after worker cleanup; refusing to spawn a replacement.`,
        );
        return finish(false);
      }
    }
    return finish(true);
  } catch (error) {
    io.warn(
      `[supervisor] worker descendant cleanup failed: ` +
        `${error instanceof Error ? error.message : String(error)}; ` +
        `refusing to spawn a replacement.`,
    );
    return finish(false);
  }
}
