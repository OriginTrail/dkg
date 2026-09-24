import { join } from 'node:path';
import type { ChainIndexCapability } from '@origintrail-official/dkg-chain';
import { SqliteChainEventLogStore, type DashboardDB } from '@origintrail-official/dkg-node-ui';
import {
  ChainIndexReadWorker,
  type ChainIndexReadWorkerOptions,
} from './worker/chain-index-read-worker.js';

type ReaderResource = Pick<ChainIndexReadWorker, 'createReadModel' | 'close'>;

export interface DaemonChainIndexResource {
  /** Only the owning agent adapter receives this capability. */
  readonly capability: ChainIndexCapability;
  /** Shared by failed startup, fatal prerequisites, and normal shutdown. */
  close(): Promise<void>;
}

/** Startup may close the shared DB only while it can account for every user. */
export function createStartupChainIndexCloseGuard() {
  let phase: { kind: 'before-agent' } | { kind: 'agent'; stop: () => Promise<void> }
    | { kind: 'daemon-consumers' } | { kind: 'drained' } = { kind: 'before-agent' };
  return {
    agentCreated: (stop: () => Promise<void>) => { phase = { kind: 'agent', stop }; },
    daemonConsumersStarted: () => { phase = { kind: 'daemon-consumers' }; },
    dependenciesDrained: () => { phase = { kind: 'drained' }; },
    beforeDatabaseClose: async () => {
      if (phase.kind === 'daemon-consumers') {
        throw new Error('Startup failed after daemon consumers started; shared database requires full producer teardown');
      }
      if (phase.kind === 'agent') await phase.stop();
    },
  };
}

/** A cleanup quarantine must not hide the error that caused startup to fail. */
export async function rethrowAfterStartupCleanup(
  error: unknown,
  cleanup?: () => Promise<void>,
): Promise<never> {
  try {
    await cleanup?.();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Daemon startup failed and resource cleanup did not complete', {
      cause: error,
    });
  }
  throw error;
}

/** Owns the reader and the shared database it reads, including their close order. */
export function createDaemonChainIndexResource(
  dashboard: DashboardDB,
  options: {
    log: (message: string) => void;
    /** Fixed dependency barrier; failure keeps the shared database alive. */
    beforeDatabaseClose: () => Promise<void>;
    createReader?: (path: string, store: SqliteChainEventLogStore,
      options: ChainIndexReadWorkerOptions) => ReaderResource;
  },
): DaemonChainIndexResource {
  const beforeDatabaseClose = options.beforeDatabaseClose;
  const store = new SqliteChainEventLogStore(dashboard);
  let lastWarningAt = 0;
  let reader: ReaderResource;
  try {
    reader = (options.createReader ?? ((path, ownedStore, workerOptions) =>
      new ChainIndexReadWorker(path, ownedStore, workerOptions)))(
      join(dashboard.dataDir, 'node-ui.db'), store, {
        onDiagnostic: (event) => {
          if (event.durationMs < 250 && (event.reason === 'served' || event.reason === 'proof-miss')) return;
          const now = Date.now();
          if (now - lastWarningAt < 30_000) return;
          lastWarningAt = now;
          options.log(`[chain-index-read] method=${event.method} result=${event.reason} `
            + `duration_ms=${event.durationMs} queue_ms=${event.queueMs} rows=${event.rowsRead} `
            + `read_ms=${Math.round(event.readMs)} decode_ms=${Math.round(event.decodeMs)}`);
        },
      },
    );
  } catch (error) {
    dashboard.close();
    throw error;
  }
  const capability = Object.freeze({ store, readModelFactory: reader.createReadModel });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    capability,
    close: () => {
      // Concurrent paths share the same retirement. If retiring the reader
      // fails, keep its database alive rather than closing beneath active work.
      closing ??= Promise.resolve().then(async () => {
        await reader.close();
        await beforeDatabaseClose();
        dashboard.close();
      });
      return closing;
    },
  });
}
