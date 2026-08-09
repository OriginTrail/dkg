import { type ChildProcess, spawn } from 'node:child_process';
import type {
  ManagedOxigraphOwnershipLeaseV1,
  ManagedOxigraphOwnershipSnapshotV1,
  ManagedOxigraphSupervisorHandoffV1,
} from './managed-oxigraph-ownership-bridge.js';
import type { OxigraphMemoryLimits } from './oxigraph-launch-strategy.js';
import type { CgroupOomSnapshot } from './oxigraph-memory.js';

export interface OxigraphServerIo {
  spawn: typeof spawn;
  fetch: typeof globalThis.fetch;
  /** Resolve the child or descendant PID that owns the listen socket. */
  findListenOwnerPid: (
    child: ChildProcess,
    port: number,
    host: string,
    ownership?: 'child-only' | 'process-tree',
  ) => Promise<number | null>;
  readCgroupOomSnapshot: (pid: number) => CgroupOomSnapshot | null;
  readCgroupOomKill: (dir: string) => number | null;
}

export interface StartOxigraphServerOptions {
  /** Absolute path to the verified `oxigraph` binary. */
  binaryPath: string;
  /** RocksDB storage directory (`--location`). */
  location: string;
  /** Bind host. Always loopback in production; overridable for tests. */
  host?: string;
  port: number;
  log?: (msg: string) => void;
  readyTimeoutMs?: number;
  queryTimeoutS?: number;
  readyIntervalMs?: number;
  stopGraceMs?: number;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
  /** Maximum gap between the two clean-generation handoff halves. */
  handoffAbandonMs?: number;
  memoryLimits?: OxigraphMemoryLimits;
  platform?: NodeJS.Platform;
  io?: Partial<OxigraphServerIo>;
}

/** Read-only ownership surface handed to the rest of the daemon. */
export interface OxigraphServerOwnershipV1 {
  readonly lease: ManagedOxigraphOwnershipLeaseV1;
  snapshot(): ManagedOxigraphOwnershipSnapshotV1;
  /** Recover only the caller-observed generation, coalescing equal requests. */
  recoverGeneration(expectedGeneration: string): Promise<string>;
}

export interface OxigraphServerHandle {
  readonly host: string;
  readonly port: number;
  readonly queryEndpoint: string;
  readonly updateEndpoint: string;
  readonly ownership: OxigraphServerOwnershipV1;
  readonly supervisorHandoff: ManagedOxigraphSupervisorHandoffV1;
  stop(): Promise<void>;
  /** Synchronous best-effort SIGTERM for process-exit handlers. */
  killSync(): void;
}
