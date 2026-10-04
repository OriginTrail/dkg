/** Harden migration orchestration over the same ordered phases rendered by dry-run. */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as os from 'node:os';
import { BLAZEGRAPH_CONTAINER_PORT, computeBlazegraphHeapMb, defaultDockerRunner,
  type DockerRunner } from '../blazegraph-docker.js';
import { storeHardenLockPath } from '../store-runtime-monitor.js';
import { assertDaemonStoppedForStoreMigration } from '../store-maintenance-gate.js';
import { HARDEN_BACKUP_SUFFIX, inspectHardenState } from './state.js';
import { HARDEN_EXPORT_FILENAME, hardenStepDefs, planHardenMigration, type HardenStep } from './steps.js';
import * as actions from './actions.js';
import { fileSize, type HardenWorkflowInputs } from './actions.js';
import { rollbackMigrationFailure } from './rollback-failure.js';

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
  outcome: 'already-hardened' | 'hardened' | 'dry-run';
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
  const { containerName, namespace, migrationDir, log } = opts;
  const backupName = `${containerName}${HARDEN_BACKUP_SUFFIX}`;
  const exportPath = join(migrationDir, HARDEN_EXPORT_FILENAME);
  const heapMb = computeBlazegraphHeapMb((opts.totalMemoryBytes ?? os.totalmem)(),
    (opts.env ?? process.env).DKG_BLAZEGRAPH_HEAP_MB);
  const info = await inspectHardenState(docker, containerName);
  if (info.usesMigrationVolume) throw new Error(`Container "${containerName}" already uses the replacement journal volume. `
    + 'Refusing to overwrite the original or backup data; restore its JVM/health policy manually before retrying.');
  if (info.state === 'absent') throw new Error(`Container "${containerName}" not found (and no "${backupName}") — nothing to harden. `
    + 'Check `docker ps -a` and pass --container if the name differs.');
  const hostPort = opts.hostPort ?? info.hostPort;
  if (hostPort === undefined) throw new Error(`Could not determine the host port for container "${containerName}": neither `
    + `HostConfig.PortBindings nor NetworkSettings.Ports carries a binding for ${BLAZEGRAPH_CONTAINER_PORT}/tcp (or 8080/tcp). `
    + 'Refusing to guess. Pass --port <port> (the port in your store URL, typically 9999).');
  const input = { containerName, namespace, hostPort, heapMb, migrationDir, state: info.state, running: info.running };
  const sourceName = info.state === 'backup-only' ? backupName : containerName;
  const defs = hardenStepDefs({ ...input, sourceContainerName: sourceName });
  if (opts.dryRun) return { outcome: 'dry-run', containerName,
    backupContainerName: info.state === 'backup-only' ? backupName : null,
    hostPort, exportPath: null, journalBytes: null, heapMb, steps: planHardenMigration(input) };
  const baseUrl = `http://127.0.0.1:${hostPort}`;
  const ctx: HardenWorkflowInputs = { ...input, opts, docker, info, sourceName, backupName, exportPath, baseUrl,
    sparqlUrl: `${baseUrl}/bigdata/namespace/${encodeURIComponent(namespace)}/sparql`,
    fetchImpl: opts.fetch ?? globalThis.fetch, log,
    stoppedHint: `NOTE: the legacy store container "${sourceName}" is currently STOPPED — `
      + `restore service with: docker start ${sourceName} (then re-run harden when ready).`,
  };
  if (info.state === 'hardened') {
    const backup = await docker.run(['inspect', backupName]);
    if (backup.exitCode !== 0 && !/no such (?:object|container)/i.test(backup.stderr)) throw new Error(
      `Cannot determine whether migration backup "${backupName}" remains: ${backup.stderr.trim() || 'Docker inspect failed'}. `
      + 'Refusing ASK-only verification while migration state is unknown.');
    const backupExists = backup.exitCode === 0;
    const savedSize = await fileSize(exportPath);
    if (backupExists || savedSize !== null) {
      if (savedSize === null || savedSize <= 0) throw new Error(
        `Migration replacement "${containerName}" has no valid retained export for journal verification. `
        + `Keep backup "${backupName}" and restore or locate the export before retrying.`);
      // Docker's hardened shape is reached before first-run verification.
      // Retained migration copies require the same identity/size proof on retry.
      await actions.verifyReplacement(ctx, defs.verify, { path: exportPath, bytes: savedSize });
    } else await actions.verifyExisting(ctx);
    return { outcome: 'already-hardened', containerName, backupContainerName: backupExists ? backupName : null,
      hostPort, exportPath: savedSize === null ? null : exportPath, journalBytes: savedSize, heapMb };
  }
  await mkdir(migrationDir, { recursive: true });
  await mkdir(opts.dkgHome, { recursive: true });
  const lockPath = storeHardenLockPath(opts.dkgHome);
  await writeFile(lockPath,
    `${JSON.stringify({ pid: process.pid, containerName, startedAt: new Date().toISOString() })}\n`,
    { encoding: 'utf-8', flag: 'wx' });
  try {
    await assertDaemonStoppedForStoreMigration(opts.dkgHome);
    log(`Wrote harden lock ${lockPath} — daemon startup and automatic store restarts stay blocked through verification and rollback.`);
    const preSize = info.running ? await actions.readJournalSize(ctx, defs.journalSize) : null;
    if (info.running) await actions.checkFreeDisk(ctx, preSize);
    const stopped = await actions.stopSource(ctx, defs.stop, defs.exportIntegrity);
    await actions.exportJournal(ctx, defs.exportJournal);
    const exported = await actions.verifyExport(ctx, stopped, preSize, defs.exportIntegrity);
    await actions.createVolume(ctx, defs.volumeCreate);
    await actions.seedVolume(ctx, defs.seedVolume, exported);
    if (info.state === 'legacy') await actions.renameBackup(ctx, defs.renameBackup);
    try {
      await actions.disableBackupRestart(ctx, defs.disableBackupRestart);
      await actions.runHardened(ctx, defs.runHardened);
    } catch (cause) { await rollbackMigrationFailure(ctx, 'post-swap setup', cause); }
    try { await actions.verifyReplacement(ctx, defs.verify, exported); }
    catch (cause) { await rollbackMigrationFailure(ctx, 'verification', cause); }
    log(`Verification passed — ${containerName} is hardened.`);
    return { outcome: 'hardened', containerName, backupContainerName: backupName, hostPort,
      exportPath, journalBytes: exported.bytes, heapMb };
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}
