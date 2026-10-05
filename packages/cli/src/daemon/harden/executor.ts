import { randomUUID } from 'node:crypto';
/** Harden migration orchestration over the same ordered phases rendered by dry-run. */
import { mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import { BLAZEGRAPH_CONTAINER_PORT, computeBlazegraphHeapMb, defaultDockerRunner,
  type DockerRunner } from '../blazegraph-docker.js';
import { claimStoreMigrationMarker, releaseStoreMigrationMarker, storeHardenLockPath } from '../store-migration-marker.js';
import { assertDaemonStoppedForStoreMigration } from '../store-maintenance-gate.js';
import { HARDEN_BACKUP_SUFFIX, inspectHardenState } from './state.js';
import { buildHardenMigration, type HardenStep } from './steps.js';
import { hardenRecoveryStep, preserveHardenRecoveryBarrier, recoverHardenMigration } from './recovery-barrier.js';
import { rollbackMigrationFailure } from './rollback-failure.js';
import { HARDEN_VOLUME_ATTEMPT_PLACEHOLDER } from './volume.js';

export interface ExecuteHardenMigrationOptions {
  containerName: string;
  namespace: string;
  migrationDir: string;
  /**
   * DKG config home (`dkgDir()`), resolved by the caller exactly the way
   * the `dkg store harden` command resolves its config. The harden lock
   * marker (`<dkgHome>/.store-harden.lock`, see
   * store-runtime-monitor.ts `storeHardenLockPath`) lives here so the
   * daemon's runtime store monitor — which reads the same path — can
   * suspend its docker restarts while the migration holds the container
   * stopped.
   */
  dkgHome: string;
  log: (m: string) => void;
  dryRun?: boolean;
  /** Verify recovery from an incomplete rollback before clearing its startup barrier. */
  recover?: boolean;
  /** Host port override; default = the port read off the legacy container. */
  hostPort?: number;
  // Injectables (tests provide these; production callers omit them):
  docker?: DockerRunner;
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  totalMemoryBytes?: () => number;
  /** Free-bytes probe for the disk preflight. Default: statfs(migrationDir). */
  freeDiskBytes?: (dir: string) => Promise<number>;
  /** Readiness-poll bounds for the verify step (tests shrink these). */
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  /**
   * Deadline for ONE readiness/ASK/identity fetch (tests shrink it). A
   * never-settling probe response must become a normal verification
   * failure — and post-rename, a rollback — never an unbounded await.
   */
  probeTimeoutMs?: number;
}

export interface HardenMigrationResult {
  outcome: 'already-hardened' | 'hardened' | 'dry-run' | 'recovered';
  containerName: string;
  /** Set when a backup container exists that the operator must remove manually. */
  backupContainerName: string | null;
  hostPort: number;
  /** On-disk journal export (retained after success as a second recovery copy). */
  exportPath: string | null;
  journalBytes: number | null;
  heapMb: number;
  /** Dry-run only: the step list that would execute. */
  steps?: HardenStep[];
}

export async function executeHardenMigration(opts: ExecuteHardenMigrationOptions): Promise<HardenMigrationResult> {
  const docker = opts.docker ?? defaultDockerRunner();
  const { containerName, namespace, log, migrationDir, dkgHome } = opts;
  // Capture the relative-path base before the first await; normalize it once in the specification.
  const workingDirectory = process.cwd();
  const backupName = `${containerName}${HARDEN_BACKUP_SUFFIX}`;
  const heapMb = computeBlazegraphHeapMb((opts.totalMemoryBytes ?? os.totalmem)(),
    (opts.env ?? process.env).DKG_BLAZEGRAPH_HEAP_MB);
  const info = await inspectHardenState(docker, containerName);
  if (info.usesMigrationVolume) throw new Error(`Container "${containerName}" already uses the replacement journal volume. `
    + 'Refusing to overwrite the original or backup data; restore its JVM/health/log policy manually before retrying.');
  if (info.state === 'absent') throw new Error(`Container "${containerName}" not found (and no "${backupName}") — nothing to harden. `
    + 'Check `docker ps -a` and pass --container if the name differs.');
  const hostPort = opts.hostPort ?? info.hostPort;
  if (hostPort === undefined) throw new Error(`Could not determine the host port for container "${containerName}": neither `
    + `HostConfig.PortBindings nor NetworkSettings.Ports carries a binding for ${BLAZEGRAPH_CONTAINER_PORT}/tcp (or 8080/tcp). `
    + 'Refusing to guess. Pass --port <port> (the port in your store URL, typically 9999).');
  const input = { containerName, namespace, hostPort, heapMb, migrationDir, state: info.state, running: info.running,
    volumeAttemptId: opts.dryRun ? HARDEN_VOLUME_ATTEMPT_PLACEHOLDER : randomUUID() };
  const migration = buildHardenMigration({ ...input, dkgHome, workingDirectory });
  const spec = migration.specification;
  if (opts.dryRun) return { outcome: 'dry-run', containerName: spec.containerName,
    backupContainerName: spec.state === 'backup-only' ? spec.backupName : null,
    hostPort: spec.hostPort, exportPath: null, journalBytes: null, heapMb: spec.heapMb, steps: opts.recover ? [hardenRecoveryStep(spec.containerName)] : migration.steps };
  const execution = migration.bind({ docker, fetchImpl: opts.fetch ?? globalThis.fetch, log,
    freeDiskBytes: opts.freeDiskBytes, probeTimeoutMs: opts.probeTimeoutMs,
    readyTimeoutMs: opts.readyTimeoutMs, readyIntervalMs: opts.readyIntervalMs,
  });
  const ctx = execution.context;
  if (opts.recover) return recoverHardenMigration(ctx);
  if (info.state === 'hardened') {
    for (const phase of execution.phases) await phase.execute();
    return { outcome: 'already-hardened', containerName: spec.containerName,
      backupContainerName: execution.backupExists ? spec.backupName : null, hostPort: spec.hostPort,
      exportPath: execution.exported?.path ?? null, journalBytes: execution.exported?.bytes ?? null, heapMb: spec.heapMb };
  }
  await mkdir(spec.migrationDir, { recursive: true });
  await mkdir(spec.dkgHome!, { recursive: true });
  const lockPath = storeHardenLockPath(spec.dkgHome!);
  const marker = await claimStoreMigrationMarker(lockPath, spec.containerName);
  let recoveryRequired = false;
  try {
    await assertDaemonStoppedForStoreMigration(spec.dkgHome!);
    log(`Wrote harden lock ${lockPath} — daemon startup and automatic store restarts stay blocked through verification and rollback.`);
    for (const phase of execution.phases) {
      // Rename can have an uncertain Docker outcome; retain the barrier until
      // verification succeeds or rollback positively restores the source.
      if (phase.id === 'rename-backup' || phase.rollbackPhase !== undefined) recoveryRequired = true;
      try { await phase.execute(); }
      catch (cause) {
        if (phase.rollbackPhase === undefined) throw cause;
        const failure = await rollbackMigrationFailure(ctx, phase.rollbackPhase, cause);
        recoveryRequired = !failure.rollback.complete;
        throw failure.error;
      }
    }
    const exported = execution.exported;
    if (exported === null) throw new Error('Migration completed without a verified export');
    recoveryRequired = false;
    log(`Verification passed — ${spec.containerName} is hardened.`);
    return { outcome: 'hardened', containerName: spec.containerName, backupContainerName: spec.backupName, hostPort: spec.hostPort,
      exportPath: spec.exportPath, journalBytes: exported.bytes, heapMb: spec.heapMb };
  } catch (error) {
    if (recoveryRequired) {
      await preserveHardenRecoveryBarrier(ctx, execution.exported?.bytes, marker).catch(() => {});
    }
    throw error;
  } finally {
    if (!recoveryRequired) await releaseStoreMigrationMarker(marker).catch(() => {});
  }
}
